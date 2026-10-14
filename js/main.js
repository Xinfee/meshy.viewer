/**
 * main.js — Meshy Viewer: renders .meshy/.glb/.gltf with three.js, plays
 * skeletal animations (Mixamo-style rigs), lights with HDRI environments,
 * and exports/extracts standard formats:
 *   - GLB / glTF (skin + animations + textures preserved)
 *   - OBJ / STL / PLY (bind-pose geometry)
 *   - original texture images, skeleton hierarchy JSON, animation keyframes JSON
 * Pure static, no build step.
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
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { loadModelBuffer, extractGLBImages } from "./meshy-loader.js";

/* ---------------------------------------------------------------- scene */
const canvas = document.getElementById("viewport");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
const BG_COLOR = new THREE.Color(0x11141a);
scene.background = BG_COLOR;

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

// animation state
let mixer = null;
let clips = [];
let actions = [];
let activeAction = null;
let playing = false;
let skeletonHelper = null;
let bindPose = [];            // captured at load, before any animation runs
let lastGLBBuffer = null;     // raw GLB (decrypted .meshy payload or plain file)
let currentFileName = "";

// environment state
let envTexture = null;
let envBG = false;
let customEnvCache = null;    // { name, texture }

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

function fmtSecs(t) {
  return (t ?? 0).toFixed(2) + " s";
}

function disposeCurrent() {
  resetAnimationState();
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
  lastGLBBuffer = null;
  bindPose = [];
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
  let verts = 0, tris = 0, meshes = 0, bones = 0, textures = new Set(), materials = new Set();
  root.traverse((o) => {
    if (o.isBone) bones++;
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
  return { verts, tris: Math.round(tris), meshes, bones, textures: textures.size, materials: materials.size };
}

/* ------------------------------------------------------------ animation */
function resetAnimationState() {
  if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); }
  mixer = null;
  clips = [];
  actions = [];
  activeAction = null;
  playing = false;
  if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper.dispose?.(); skeletonHelper = null; }
  $("animbar").classList.add("hidden");
  $("btn-skeleton").classList.remove("active");
  $("btn-play").textContent = "▶";
}

/** Capture bone-local transforms (bind/rest pose) before any clip runs. */
function captureBindPose(root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  if (!bones.length) return [];
  root.updateMatrixWorld(true);
  return bones.map((b) => ({
    obj: b,
    name: b.name || b.uuid,
    parent: b.parent?.isBone ? (b.parent.name || b.parent.uuid) : null,
    translation: b.position.toArray(),
    rotation: b.quaternion.toArray(),
    scale: b.scale.toArray(),
    worldPosition: b.getWorldPosition(new THREE.Vector3()).toArray(),
  }));
}

function setupAnimations(gltf, root) {
  clips = gltf.animations ?? [];
  if (!clips.length) return;
  mixer = new THREE.AnimationMixer(root);
  actions = clips.map((c) => mixer.clipAction(c));
  playing = true;
  playClip(0, true);

  const sel = $("clip-select");
  sel.innerHTML = "";
  clips.forEach((c, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `${i}: ${c.name || "clip"} (${fmtSecs(c.duration)})`;
    sel.appendChild(opt);
  });
  $("animbar").classList.remove("hidden");
  $("btn-play").textContent = "⏸";
  $("timeline").value = 0;
  $("speed").value = 1;
  $("speed-val").textContent = "1.00×";
}

function playClip(index, resume = true) {
  if (!mixer || !actions[index]) return;
  const prev = activeAction;
  activeAction = actions[index];
  if (prev && prev !== activeAction) {
    prev.fadeOut(0.15);
    activeAction.reset().fadeIn(0.15).play();
  } else {
    activeAction.reset();
    if (resume || playing) activeAction.play();
  }
  $("clip-select").value = String(index);
}

function setPlaying(on) {
  playing = on;
  if (activeAction) {
    // three.js AnimationAction has no pause() method — `paused` is a property.
    activeAction.paused = !on;
    if (on) activeAction.play();
  }
  $("btn-play").textContent = on ? "⏸" : "▶";
}

function restoreBindPose() {
  for (const b of bindPose) {
    b.obj.position.fromArray(b.translation);
    b.obj.quaternion.fromArray(b.rotation);
    b.obj.scale.fromArray(b.scale);
  }
  if (currentRoot) currentRoot.updateMatrixWorld(true);
}

/* ------------------------------------------------------------- env map */
function setEnvLighting(useEnv) {
  if (useEnv) {
    hemi.intensity = 0.25; key.intensity = 0.9; rim.intensity = 0.35;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
  } else {
    hemi.intensity = 1.0; key.intensity = 2.2; rim.intensity = 0.9;
    renderer.toneMapping = THREE.NoToneMapping;
  }
}

function applyEnvTexture(tex) {
  envTexture?.dispose?.();
  envTexture = tex;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = tex;
  scene.background = envBG ? tex : BG_COLOR;
  setEnvLighting(true);
}

function clearEnv() {
  envTexture?.dispose?.();
  envTexture = null;
  scene.environment = null;
  scene.background = BG_COLOR;
  setEnvLighting(false);
}

async function loadEnvFromBuffer(name, buffer) {
  const lower = name.toLowerCase();
  setBusy(true, `Loading environment ${name}…`);
  try {
    let tex;
    if (lower.endsWith(".hdr")) tex = new RGBELoader().parse(buffer);
    else if (lower.endsWith(".exr")) tex = new EXRLoader().parse(buffer);
    else throw new Error("Environment file must be .hdr (RGBE) or .exr (OpenEXR)");
    customEnvCache = { name, texture: tex };
    applyEnvTexture(tex);
    banner(`Environment loaded: ${name}`, false);
  } catch (e) {
    console.error(e);
    banner("Environment load failed: " + (e.message ?? e));
    $("env-select").value = "studio";
    clearEnv();
  } finally {
    setBusy(false);
  }
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
    lastGLBBuffer = data;
    currentFileName = name;

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

    bindPose = captureBindPose(currentRoot);
    setupAnimations(gltf, currentRoot);

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
    const clipDur = clips.length ? clips.reduce((a, c) => Math.max(a, c.duration), 0) : 0;
    $("stat-rig").textContent = s.bones
      ? `${s.bones} bones · ${clips.length} animation(s)` + (clipDur ? ` · longest ${fmtSecs(clipDur)}` : "")
      : "static (no skeleton)";
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

const baseName = () => (currentFileName || "model").replace(/\.[^.]+$/, "");

async function exportModel(format) {
  if (!currentRoot) { banner("Load a model first.", true); return; }
  banner("");
  setBusy(true, `Exporting ${format.toUpperCase()}…`);
  // Exports use the rest/bind pose; playback state is restored afterwards.
  const wasPlaying = playing && !!activeAction;
  if (wasPlaying) setPlaying(false);
  restoreBindPose();
  try {
    await new Promise((res) => renderer.render(scene, camera) || requestAnimationFrame(res));

    if (format === "glb" || format === "gltf") {
      const exporter = new GLTFExporter();
      const binary = format === "glb";
      const out = await exporter.parseAsync(currentRoot, {
        binary,
        onlyVisible: true,
        animations: clips, // preserves skeletal clips in the export
      });
      if (binary) saveBlob(new Blob([out], { type: "model/gltf-binary" }), baseName() + ".glb");
      else saveBlob(new Blob([JSON.stringify(out)], { type: "model/gltf+json" }), baseName() + ".gltf");
    } else if (format === "obj") {
      const out = new OBJExporter().parse(currentRoot);
      saveBlob(new Blob([out], { type: "text/plain" }), baseName() + ".obj");
    } else if (format === "stl") {
      const out = new STLExporter().parse(currentRoot, { binary: true });
      saveBlob(new Blob([out], { type: "model/stl" }), baseName() + ".stl");
    } else if (format === "ply") {
      const exporter = new PLYExporter();
      exporter.parse(currentRoot, (out) => saveBlob(new Blob([out], { type: "text/plain" }), baseName() + ".ply"),
        (err) => banner("PLY export failed: " + err), { binary: false });
    }
    banner(`Exported ${baseName()}.${format}`, false);
  } catch (e) {
    console.error(e);
    banner("Export failed: " + (e.message ?? e));
  } finally {
    if (wasPlaying) setPlaying(true);
    setBusy(false);
  }
}

/* -------------------------------------------------------------- extract */
function extractTextures() {
  if (!currentRoot) { banner("Load a model first.", true); return; }
  if (!lastGLBBuffer) { banner("No GLB buffer available for this source.", true); return; }
  banner("");
  try {
    const imgs = extractGLBImages(lastGLBBuffer);
    const usable = imgs.filter((im) => im.bytes);
    if (!usable.length) {
      banner("No embedded images found (external URIs are not bundled).", true);
      return;
    }
    usable.forEach((im, i) => {
      setTimeout(() => saveBlob(new Blob([im.bytes], { type: im.mimeType }),
        `${baseName()}_${im.name || "texture_" + i}.${im.ext}`), i * 350);
    });
    banner(`Extracting ${usable.length} texture(s)…`, false);
  } catch (e) {
    console.error(e);
    banner("Texture extraction failed: " + (e.message ?? e));
  }
}

function extractSkeleton() {
  if (!currentRoot) { banner("Load a model first.", true); return; }
  if (!bindPose.length) { banner("This model has no skeleton.", true); return; }
  const doc = {
    source: currentFileName,
    boneCount: bindPose.length,
    note: "Bone-local transforms captured in the bind/rest pose (translation, rotation quaternion [x,y,z,w], scale). parent=null marks a root bone.",
    bones: bindPose.map((b) => ({
      name: b.name,
      parent: b.parent,
      translation: round6(b.translation),
      rotation: round6(b.rotation),
      scale: round6(b.scale),
      worldPosition: round6(b.worldPosition),
    })),
  };
  saveBlob(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), baseName() + "_skeleton.json");
  banner(`Extracted skeleton (${bindPose.length} bones) → ${baseName()}_skeleton.json`, false);
}

function round6(arr) { return arr.map((v) => +v.toFixed(6)); }

function extractAnimations() {
  if (!currentRoot) { banner("Load a model first.", true); return; }
  if (!clips.length) { banner("This model has no animations.", true); return; }
  const doc = {
    source: currentFileName,
    clipCount: clips.length,
    clips: clips.map((c) => ({
      name: c.name,
      duration: +c.duration.toFixed(6),
      trackCount: c.tracks.length,
      tracks: c.tracks.map((t) => ({
        name: t.name,                       // e.g. "Hips.quaternion"
        property: t.name.split(".").pop(),  // position | quaternion | scale | morphTargetInfluences
        interpolation: ["LINEAR", "STEP", "CUBICSPLINE"][t.interpolation] ?? t.interpolation,
        times: round6(Array.from(t.times)),
        values: round6(Array.from(t.values)),
      })),
    })),
  };
  saveBlob(new Blob([JSON.stringify(doc)], { type: "application/json" }), baseName() + "_animations.json");
  banner(`Extracted ${clips.length} animation clip(s) with keyframes → ${baseName()}_animations.json`, false);
}

/* -------------------------------------------------------------- wiring */
$("btn-open").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => loadFile(e.target.files[0]));
$("btn-sample").addEventListener("click", () => loadSample());
$("btn-walk").addEventListener("click", () => loadWalkDemo());
document.querySelectorAll("[data-export]").forEach((b) =>
  b.addEventListener("click", () => exportModel(b.dataset.export)));
$("btn-extex").addEventListener("click", extractTextures);
$("btn-exskel").addEventListener("click", extractSkeleton);
$("btn-exanim").addEventListener("click", extractAnimations);

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

// animation bar
$("btn-play").addEventListener("click", () => setPlaying(!playing));
$("clip-select").addEventListener("change", (e) => {
  const i = Number(e.target.value);
  if (mixer && actions[i]) { playClip(i, playing); if (playing) setPlaying(true); }
});
$("timeline").addEventListener("input", (e) => {
  if (!activeAction || !clips.length) return;
  const frac = Number(e.target.value) / 1000;
  const clip = activeAction.getClip();
  activeAction.time = frac * clip.duration;
  mixer.update(0);
});
$("speed").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  if (activeAction) activeAction.timeScale = v;
  $("speed-val").textContent = v.toFixed(2) + "×";
});
$("btn-skeleton").addEventListener("click", (e) => {
  if (!currentRoot) return;
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper.dispose?.();
    skeletonHelper = null;
    e.currentTarget.classList.remove("active");
  } else {
    skeletonHelper = new THREE.SkeletonHelper(currentRoot);
    scene.add(skeletonHelper);
    e.currentTarget.classList.add("active");
  }
});

// environment
$("env-select").addEventListener("change", async (e) => {
  const v = e.target.value;
  if (v === "studio") { clearEnv(); return; }
  if (v === "custom") {
    if (customEnvCache) applyEnvTexture(customEnvCache.texture);
    else $("env-input").click();
    return;
  }
  if (v === "meshy") {
    try {
      setBusy(true, "Loading Meshy HDRI…");
      const res = await fetch("env/decor_shop_2k_Lower45Sat.exr");
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = await res.arrayBuffer();
      const tex = new EXRLoader().parse(buf);
      applyEnvTexture(tex);
    } catch (err) {
      console.error(err);
      banner("HDRI load failed: " + (err.message ?? err));
      $("env-select").value = "studio";
      clearEnv();
    } finally { setBusy(false); }
  }
});
$("env-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  await loadEnvFromBuffer(f.name, buf);
  if (!customEnvCache) $("env-select").value = "studio";
});
$("btn-envbg").addEventListener("click", (e) => {
  envBG = !envBG;
  e.currentTarget.classList.toggle("active", envBG);
  if (envTexture) scene.background = envBG ? envTexture : BG_COLOR;
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

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (mixer && playing) mixer.update(dt);
  if (mixer && activeAction) {
    const dur = activeAction.getClip().duration || 1;
    const t = activeAction.time % dur;
    if (document.activeElement !== $("timeline")) $("timeline").value = Math.round((t / dur) * 1000);
    $("anim-time").textContent = `${t.toFixed(2)} / ${dur.toFixed(2)} s`;
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

async function fetchSample(name) {
  const res = await fetch(name);
  if (!res.ok) throw new Error(`fetch ${res.status} for ${name}`);
  return res.arrayBuffer();
}

async function loadSample() {
  try {
    setBusy(true, "Fetching sample/model.meshy…");
    const buffer = await fetchSample("sample/model.meshy");
    await loadArrayBuffer("model.meshy (sample)", buffer);
  } catch (e) {
    banner("Could not load bundled sample: " + (e.message ?? e));
    setBusy(false);
  }
}

async function loadWalkDemo() {
  try {
    setBusy(true, "Fetching sample/Animation_Walking_withSkin.glb…");
    const buffer = await fetchSample("sample/Animation_Walking_withSkin.glb");
    await loadArrayBuffer("Animation_Walking_withSkin.glb (demo)", buffer);
  } catch (e) {
    banner("Could not load animated demo: " + (e.message ?? e));
    setBusy(false);
  }
}

loadSample();

// test hook for automated browser tests / console debugging
window.__viewer = {
  getRoot: () => currentRoot,
  getClips: () => clips,
  getAnimState: () => ({ mixer, actions, activeAction, playing,
    proto: activeAction ? Object.getPrototypeOf(activeAction)?.constructor?.name : null,
    hasPause: activeAction ? typeof activeAction.pause : null }),
  stats: () => currentRoot && collectStats(currentRoot),
  exportModel,
  extractTextures,
  extractSkeleton,
  extractAnimations,
};
