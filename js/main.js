/**
 * main.js — Meshy Viewer: renders .meshy/.glb/.gltf with three.js and exports
 * standard formats (GLB/GLTF/OBJ/STL/PLY). Pure static, no build step.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { PLYExporter } from "three/addons/exporters/PLYExporter.js";
import { loadModelBuffer } from "./meshy-loader.js";

/* ---------------------------------------------------------------- scene */
const canvas = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11141a);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 2000);
camera.position.set(1.6, 1.1, 1.9);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotateSpeed = 2.2;

// lighting
const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2d35, 1.0);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 6, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.9);
rim.position.set(-4, 2, -3);
scene.add(rim);

const grid = new THREE.GridHelper(10, 20, 0x334455, 0x1d2430);
grid.position.y = -0.0001;
scene.add(grid);

// loaders
const draco = new DRACOLoader().setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
const ktx2 = new KTX2Loader()
  .setTranscoderPath("https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/basis/")
  .detectSupport(renderer);

const gltfLoader = new GLTFLoader()
  .setDRACOLoader(draco)
  .setKTX2Loader(ktx2);
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

/* ------------------------------------------------------------- ui state */
let currentRoot = null;
let wireframe = false;
const $ = (id) => document.getElementById(id);

function setBusy(on, msg) {
  $("busy").classList.toggle("hidden", !on);
  if (msg) $("busy-msg").textContent = msg;
}

function banner(msg, isError = true) {
  const b = $("banner");
  b.classList.toggle("hidden", !msg);
  b.classList.toggle("error", isError);
  if (msg) b.textContent = msg;
}

function fmtBytes(n) {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + " KB";
  return n + " B";
}

function disposeCurrent() {
  if (!currentRoot) return;
  currentRoot.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const k in m) {
          const v = m[k];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    }
  });
  scene.remove(currentRoot);
  currentRoot = null;
}

function frameObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.9;
  camera.near = maxDim / 1000;
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(dist * 0.75, dist * 0.5, dist * 0.9));
  controls.update();
}

function collectStats(root) {
  let verts = 0, tris = 0, meshes = 0, textures = new Set(), materials = new Set();
  root.traverse((o) => {
    if (o.isMesh && o.geometry) {
      meshes++;
      const g = o.geometry;
      const p = g.getAttribute("position");
      if (p) verts += p.count;
      if (g.index) tris += g.index.count / 3;
      else if (p) tris += p.count / 3;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        materials.add(m.uuid);
        for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"]) {
          if (m[k]?.isTexture) textures.add(m[k].uuid);
        }
      }
    }
  });
  return { verts, tris: Math.round(tris), meshes, textures: textures.size, materials: materials.size };
}

/* ----------------------------------------------------------------- load */
async function loadArrayBuffer(name, buffer) {
  banner("");
  disposeCurrent();
  setBusy(true, `Parsing ${name}…`);
  try {
    const t0 = performance.now();
    const { kind, data, info } = await loadModelBuffer(buffer);
    const parseMs = (performance.now() - t0).toFixed(0);

    setBusy(true, "Decoding geometry (meshopt/draco)…");
    let gltf;
    if (kind === "glb") {
      gltf = await gltfLoader.parseAsync(data, "");
    } else {
      const text = new TextDecoder().decode(data);
      gltf = await gltfLoader.parseAsync(text, "");
    }
    const loadMs = (performance.now() - t0).toFixed(0);

    currentRoot = gltf.scene || gltf.scenes[0];
    scene.add(currentRoot);
    frameObject(currentRoot);

    const s = collectStats(currentRoot);
    const srcNames = { meshy: "Meshy container (.meshy)", glb: "GLB", gltf: "glTF JSON" };
    $("stat-file").textContent = name;
    $("stat-source").textContent = srcNames[info.source] ?? info.source;
    if (info.source === "meshy") {
      $("stat-container").textContent =
        `${fmtBytes(info.containerSize)} → GLB ${fmtBytes(info.glbLength)} · nonce ${info.nonceHex.slice(0, 8)}… · v${info.version}` +
        (info.paddingBytes ? ` · ${info.paddingBytes} B pad` : "");
    } else {
      $("stat-container").textContent = fmtBytes(buffer.byteLength);
    }
    $("stat-mesh").textContent =
      `${s.verts.toLocaleString()} verts · ${s.tris.toLocaleString()} tris · ${s.meshes} mesh(es) · ${s.materials} mat · ${s.textures} tex`;
    $("stat-time").textContent = `decrypt+parse ${parseMs} ms · full load ${loadMs} ms`;
    $("panel").classList.remove("hidden");
  } catch (e) {
    console.error(e);
    banner(`${e.message ?? e}`);
    $("panel").classList.add("hidden");
  } finally {
    setBusy(false);
  }
}

async function loadFile(file) {
  if (!file) return;
  setBusy(true, `Reading ${file.name}…`);
  try {
    const buffer = await file.arrayBuffer();
    await loadArrayBuffer(file.name, buffer);
  } catch (e) {
    banner(String(e.message ?? e));
    setBusy(false);
  }
}

/* --------------------------------------------------------------- export */
function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const baseName = () => ($("stat-file").textContent || "model").replace(/\.[^.]+$/, "");

async function exportModel(format) {
  if (!currentRoot) { banner("Load a model first.", true); return; }
  banner("");
  setBusy(true, `Exporting ${format.toUpperCase()}…`);
  try {
    // Work on a clone with world transforms baked (clone shared geometry, cheap).
    const src = currentRoot;
    await new Promise((res) => renderer.render(scene, camera) || requestAnimationFrame(res));

    if (format === "glb" || format === "gltf") {
      const exporter = new GLTFExporter();
      const binary = format === "glb";
      const out = await exporter.parseAsync(src, { binary, onlyVisible: true });
      if (binary) saveBlob(new Blob([out], { type: "model/gltf-binary" }), baseName() + ".glb");
      else saveBlob(new Blob([JSON.stringify(out)], { type: "model/gltf+json" }), baseName() + ".gltf");
    } else if (format === "obj") {
      const out = new OBJExporter().parse(src);
      saveBlob(new Blob([out], { type: "text/plain" }), baseName() + ".obj");
    } else if (format === "stl") {
      const out = new STLExporter().parse(src, { binary: true });
      saveBlob(new Blob([out], { type: "model/stl" }), baseName() + ".stl");
    } else if (format === "ply") {
      const exporter = new PLYExporter();
      exporter.parse(src, (out) => saveBlob(new Blob([out], { type: "text/plain" }), baseName() + ".ply"),
        (err) => banner("PLY export failed: " + err), { binary: false });
    }
    banner(`Exported ${baseName()}.${format}`, false);
  } catch (e) {
    console.error(e);
    banner("Export failed: " + (e.message ?? e));
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------------- wiring */
$("btn-open").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => loadFile(e.target.files[0]));
$("btn-sample").addEventListener("click", () => loadSample());
document.querySelectorAll("[data-export]").forEach((b) =>
  b.addEventListener("click", () => exportModel(b.dataset.export)));
$("btn-wireframe").addEventListener("click", (e) => {
  wireframe = !wireframe;
  e.currentTarget.classList.toggle("active", wireframe);
  currentRoot?.traverse((o) => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m && (m.wireframe = wireframe));
    }
  });
});
$("btn-rotate").addEventListener("click", (e) => {
  controls.autoRotate = !controls.autoRotate;
  e.currentTarget.classList.toggle("active", controls.autoRotate);
});
$("btn-reset").addEventListener("click", () => { if (currentRoot) frameObject(currentRoot); });
$("btn-grid").addEventListener("click", (e) => {
  grid.visible = !grid.visible;
  e.currentTarget.classList.toggle("active", grid.visible);
});

// drag & drop
addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
addEventListener("dragleave", () => document.body.classList.remove("dragging"));
addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const f = [...e.dataTransfer.files].find((f) => /\.(meshy|glb|gltf)$/i.test(f.name)) ?? e.dataTransfer.files[0];
  loadFile(f);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

async function loadSample() {
  try {
    setBusy(true, "Fetching sample/model.meshy…");
    const res = await fetch("sample/model.meshy");
    if (!res.ok) throw new Error(`sample fetch ${res.status}`);
    const buffer = await res.arrayBuffer();
    await loadArrayBuffer("model.meshy (sample)", buffer);
  } catch (e) {
    banner("Could not load bundled sample: " + (e.message ?? e));
    setBusy(false);
  }
}

loadSample();
