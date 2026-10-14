# Clean-room implementation spec — meshy.viewer

A complete, code-free specification for reimplementing a static-site viewer
and converter for Meshy AI exports. Everything here is derived from the
format description in [FORMAT.md](FORMAT.md) and from black-box observations
of the reference files listed in §1.

---

## 0. Deliverable definition

Build a **pure client-side static site** (no server, no build step, deployable
to GitHub Pages) that:

1. Opens Meshy `.meshy` encrypted containers **and** plain `.glb`/`.gltf`
   files (including Meshy animated `*_withSkin.glb` exports) in the browser.
2. Renders them with three.js: textured, orbitable, wireframe, grid.
3. Plays skeletal animations: clip picker, play/pause, timeline scrub,
   variable speed, bone-overlay helper.
4. Lights the scene with studio lights or an HDRI environment (bundled
   OpenEXR or a user-provided `.hdr`/`.exr`).
5. Exports: GLB / glTF (skin + animations + textures preserved),
   OBJ / STL / PLY (bind-pose geometry).
6. Extracts: original embedded texture bytes, skeleton hierarchy JSON,
   animation keyframes JSON.
7. Never uploads the model anywhere; all crypto and parsing in the browser.

Runtime requirements: evergreen browser with WebGL2 + WebCrypto, served over
`https://` or `localhost` (WebCrypto is undefined on insecure origins).
Suggested three.js version: **r170**, **vendored into the site** — the whole
runtime (library, loaders, exporters, DRACO/meshopt/KTX2 decoders) is
self-hosted so the page needs no third-party CDN at runtime and keeps working
on restricted networks, fully offline once deployed.

---

## 1. Reference assets & test vectors

The following files (SHA-256, exact byte size) are the regression fixtures.
A conforming implementation reproduces the derived values when run against
them.

| File | Bytes | SHA-256 |
|---|---:|---|
| `model.meshy` (encrypted container) | 5,685,404 | `d17b0723332d0ad12a366c560894ab1efc95e592607ceede1a71699e314013c5` |
| `model.glb` (decrypted static GLB) | 5,685,356 | `075a17567ae450171ae988f8d072b05654daf277008773103c7e6d95a9a489e1` |
| `Animation_Walking_withSkin.glb` (animated export) | 16,113,308 | `f585cf5e1167dc5a1d3f2b66e62003df5800dba35efa257b904de50cfae0de54` |
| `decor_shop_2k_Lower45Sat.exr` (HDRI) | 493,133 | `98f5388b8e937901f16d8c0d8c64dba80900d82f2097ab2e7b44c206a332521b` |

Container header of `model.meshy` (little-endian):

```
magic        "MESHY.AI"                       (bytes 0..8)
version      0x0001                           (bytes 8..10)
nonce        1954c611423d08bf4361edf6         (bytes 10..22)
reserved     1e330ab2 00000000 0000           (bytes 22..32 — OPAQUE, ignore)
ciphertext   8192 bytes at [32..8224)         (= GLB plaintext [0..8192))
GCM tag      f0a5869df82ef6cf7f92f2b1109ec585 (bytes 8224..8240)
tail         plaintext GLB [8192..5685356)    (bytes 8240..5685404, unencrypted)
padding      none in this sample (container = header + tag + GLB exactly)
```

Derived values that MUST match after a correct decrypt:

* plaintext head begins with `"glTF"` and its `uint32` length field at offset
  8 equals **5,685,356**;
* the SHA-256 of the reassembled GLB equals the `model.glb` hash above;
* JSON chunk declares generator `gltfpack 1.2`, `extensionsRequired` =
  `KHR_mesh_quantization`, `EXT_meshopt_compression`, `EXT_texture_webp`;
* BIN chunk length 5,682,152; 3 embedded WebP images.

Animated fixture facts: 26 nodes, 1 mesh, 1 skin (24 joints, names `Hips`,
`Spine`, `LeftUpLeg`, … Mixamo-style), 1 clip named
`Armature|walking_man|baselayer` with 72 channels, duration ≈ 1.0667 s,
generator `Khronos glTF Blender I/O v4.0.43`, 1 embedded PNG, no required
extensions.

---

## 2. Input intake

Single file-entry point. Read the whole file into an `ArrayBuffer`, then
sniff magic bytes (never trust the extension):

| First bytes | Interpretation |
|---|---|
| `MESHY.AI` (8 B) | encrypted container → decrypt first (§3) |
| `glTF` (4 B) | plain GLB → use as-is |
| `{` (after optional whitespace) | glTF JSON → pass text to the glTF parser |
| anything else | error: "Unrecognized file" |

Accept files via a file picker (`accept=".meshy,.glb,.gltf"`), a global
drag-and-drop overlay, and (for the demos) `fetch()` of bundled samples.
Keep the decrypted/plain GLB buffer around: the texture extractor needs the
raw container later.

**Truncation check (container path):** after decrypting the 8 KiB head, the
GLB's declared length is known. Required tail = `glbLength − 8192`; available
tail = `containerSize − 8256`. If short, abort with a percentage message —
see §9 (this failure mode occurs in the wild).

---

## 3. Decryption pipeline (`.meshy` → GLB)

Constants: `HEADER=32`, `CIPHER=8192`, `TAG=16`,
`KEY = ASCII 'JSON{"accessors":[{"bufferView":'` (exactly 32 bytes).

1. Parse `version = u16le @ 8` (report it in the UI), `nonce = bytes
   [10..22)`, `tag = bytes [8224..8240)`.
2. AES-256-GCM decrypt `bytes [32..8224)` with the nonce and key above; pass
   `ciphertext || tag` as one buffer (WebCrypto convention). No AAD.
   Authentication failure ⇒ fatal error (file corrupted / not a container).
3. Verify plaintext starts with `"glTF"`; read `glbLength = u32le @ 8`.
4. Allocate `glbLength` bytes: copy the decrypted head to `[0..8192)`, then
   the raw tail `bytes [8256 .. 8256 + glbLength − 8192)` to `[8192..)`.
   Ignore any bytes beyond the GLB (zero padding).
5. Report: container size → GLB size, nonce prefix, version, padding bytes.

The decrypted GLB uses `EXT_meshopt_compression`: the glTF loader must be
configured with a MeshoptDecoder (three.js ships one as
`three/addons/libs/meshopt_decoder.module.js`). Also wire DRACO and KTX2
decoders for robustness. Textures inside the container may be WebP
(`EXT_texture_webp`) — the browser decodes them natively.

---

## 4. Scene & rendering

* Renderer: WebGL, antialias, pixel ratio ≤ 2. Background `#11141a`.
* Camera: perspective 50° FOV. Framing rule after load: bounding box of the
  scene root → `maxDim = max(size.x, size.y, size.z)`;
  `dist = maxDim / (2·tan(FOV/2)) · 1.9`; camera at
  `center + (0.75·dist, 0.5·dist, 0.9·dist)`; `near = maxDim/1000`,
  `far = maxDim·100`; orbit target = box center. A *Reset* button re-runs it.
* Controls: orbit with damping, auto-rotate toggle (speed ≈ 2.2).
* Lights (studio preset): hemisphere `(0xbfd4ff, 0x2a2d35, 1.0)`,
  directional key `(0xffffff, 2.2)` at `(3, 6, 4)`, directional rim
  `(0x88aaff, 0.9)` at `(-4, 2, -3)`. Tone mapping: none.
* Grid: 10×10 units, 20 divisions, colours `0x334455` / `0x1d2430`, toggleable.
* Wireframe toggle must handle material arrays.
* Disposal: on every (re)load, dispose geometries, materials and textures of
  the previous model; stop the mixer; remove the skeleton helper.

## 5. Animation subsystem

After load, collect `gltf.animations`. If any exist, show the animation bar
and **autoplay the first clip, looping**.

| Control | Behaviour |
|---|---|
| Clip picker | `#index: name (duration s)`; switching crossfades out 0.15 s / in 0.15 s |
| Play/pause | ⏸/▶ button — **set `action.paused = !playing`; on resume also call `action.play()`** (three.js AnimationAction has **no `.pause()` method** — classic trap) |
| Timeline | range 0–1000 → `action.time = frac·clip.duration`, then `mixer.update(0)` to apply the pose; while playing the slider mirrors `action.time % duration` (unless the user is dragging it) |
| Speed | range 0–2.5 step 0.05 → `action.timeScale`; label `1.00×` |
| Bones | toggles `THREE.SkeletonHelper` over the current root |

Frame loop: `mixer.update(delta)` from a `THREE.Clock`, only while playing;
time readout `t.toFixed(2) / dur.toFixed(2) s`.

Bind pose capture: **before starting any clip**, walk all `isBone` nodes and
store per-bone: name, parent bone name (or null), local
translation / quaternion `[x,y,z,w]` / scale, world position. This snapshot
feeds both the skeleton extraction and the bind-pose restore before export.

## 6. Environment lighting

Selector with three states:

1. **Studio lights** — the §4 preset; `scene.environment = null`;
   background = solid colour; `NoToneMapping`.
2. **Bundled Meshy HDRI** — `fetch('env/decor_shop_2k_Lower45Sat.exr')`,
   parse with an OpenEXR loader (three.js `EXRLoader`), set
   `mapping = EquirectangularReflectionMapping`, assign to
   `scene.environment`; ACES filmic tone mapping, exposure 1.0; dim lights to
   hemi 0.25 / key 0.9 / rim 0.35. Optional **BG** toggle puts the same
   texture on `scene.background`.
3. **Custom file…** — user-picked `.hdr` (RGBE loader) or `.exr` (EXR loader),
   parsed from an ArrayBuffer; same application path.

## 7. Export matrix

Export operates on the loaded scene root. Before any export: pause playback
(restore afterwards) and **restore the bind pose** from the §5 snapshot, so
files come out in rest pose with clips attached — matching Meshy's own
convention.

| Format | Library | Notes |
|---|---|---|
| GLB (binary) | three.js `GLTFExporter` `{ binary:true, animations: clips }` | preserves skin, skeleton, clips, embedded textures. ~16.8 MB out for the animated fixture; 37.0 MB for the static fixture |
| glTF (JSON) | `GLTFExporter` `{ binary:false, animations: clips }` | embedded base64 buffers; ~22.4 MB for the animated fixture |
| OBJ | `OBJExporter` | bind-pose geometry only; no materials |
| STL (binary) | `STLExporter` `{ binary:true }` | geometry only |
| PLY | `PLYExporter` `{ binary:false }` | geometry + vertex colours |

Known non-goals: `KHR_materials_specular` / `KHR_materials_ior` from the
animated fixture are not round-tripped by three's exporter; base colour /
normal / metallic-roughness maps survive.

## 8. Extraction feature set

**Textures** — walk the *raw GLB buffer* (decrypted or plain), never the
decoded three.js textures, so users get the original bytes:

1. Parse GLB header: `jsonLen = u32le@12`, first chunk must be `JSON`;
   parse the JSON chunk.
2. Scan chunks after it for type `BIN\0` (0x004e4942); record bin start.
3. For each `images[i]`: if it has `bufferView`, slice
   `bin + bufferView.byteOffset (+0 if absent)` for `byteLength` bytes;
   if it has `uri`, report it as external (skip).
4. Download each as `originalName_texture_<i>.<ext>` with its
   `mimeType` (`png`/`jpg`/`webp`); stagger multiple downloads ~350 ms so
   browsers don't block them.

WebP payloads from the static fixture are byte-identical to what Meshy
stored (meshopt compresses geometry, not images).

**Skeleton JSON** — `{"source", "boneCount", "note", "bones":[{name, parent,
translation, rotation [x,y,z,w], scale, worldPosition}]}` from the bind-pose
snapshot, numbers rounded to 6 decimals. ≈ 9.7 KB for the 24-joint fixture.

**Animations JSON** — for each clip: `name`, `duration`, and per track:
`name` (e.g. `"Hips.quaternion"`), `property` (suffix after the last dot),
`interpolation` (`LINEAR`/`STEP`/`CUBICSPLINE`), `times[]`, `values[]`
(rounded to 6 decimals). ≈ 41.6 KB for the 72-channel fixture.

## 9. UI specification

Fixed chrome over a full-viewport canvas:

* **Top-left brand**: `meshy.viewer` + tagline + link to `FORMAT.md`.
* **Top-right toolbar** (wrapping groups of pill buttons):
  *file* — **Samples ▾** (dropdown chooser with two described entries:
  *Static — encrypted .meshy container* and *Animated — walking man,
  skinned GLB*) · Open file…;
  *view* — Wireframe · Spin · Grid · Reset;
  *env* — Studio lights / Meshy HDRI / Custom… + BG toggle;
  *export* — GLB · glTF · OBJ · STL · PLY;
  *extract* — Textures · Skeleton · Anims.
* **Empty workspace on start** — nothing auto-loads; a centred empty-state
  card (“No model loaded”) offers the same two demos as shortcut buttons plus
  a drag-and-drop hint, and disappears once a model is loaded.
* **Bottom-centre animation bar** (hidden when no clips): play/pause,
  clip picker, timeline slider, `t / dur s` readout, speed slider + label,
  Bones toggle.
* **Bottom-left info panel** rows: file · source (`Meshy container (.meshy)`
  / `GLB` / `glTF JSON`) · container (size→size, nonce, version, padding) ·
  geometry (verts/tris/meshes/materials/textures) · rig/anim (bones,
  animations, longest duration, or `static (no skeleton)`) · timing
  (decrypt+parse ms, full-load ms).
* **Banner** for status/errors (green/red), auto-shown after actions.
* **Busy overlay** with spinner during load/export.
* Drag-and-drop anywhere shows a dashed overlay and accepts
  `.meshy/.glb/.gltf`.

## 10. Acceptance tests

Run locally (`python3 -m http.server`), then:

1. **Load the static sample** (Samples ▾ → *Static*, or the empty-state card)
   → panel shows `511,270 verts · 954,092 tris ·
   1 mesh · 4 tex`, `static (no skeleton)`, decrypt+parse < 50 ms.
2. **Load the animated sample** (Samples ▾ → *Animated*) → `22,361 verts ·
   15,550 tris`, `24 bones · 1 animation(s) ·
   longest 1.07 s`; timeline advances; character walks.
3. **Pause/resume** → button flips ⏸/▶, pose freezes/resumes.
4. **Scrub to 50 %** → time ≈ 0.533 s of 1.067 s.
5. **Bones** → cyan skeleton overlay follows the deformation.
6. **Env → Meshy HDRI** → ACES-lit shop lighting; BG toggle shows the shop.
7. **Export GLB** (animated) → valid GLB; its JSON declares `skins:1`,
   `joints:24`, `animations:1` with 72 channels, `images:1`, generator
   `THREE.GLTFExporter r170`.
8. **Extract Textures** → one 14,817,666-byte PNG (byte-identical to the
   GLB's embedded image).
9. **Extract Skeleton / Anims** → JSONs with the sizes in §8 and 24 bones /
   72 tracks.
10. **Static GLB regression** → exporting the decrypted fixture yields
    37,034,628 B.

## 11. Pitfalls checklist

* `AnimationAction` has **no `.pause()`** — use the `.paused` property
  (this broke the first implementation's export path).
* WebCrypto needs a secure context; `file://` won't work at all (modules +
  crypto).
* WebCrypto GCM wants `ciphertext||tag` concatenated; node/crypto and Python
  `cryptography` differ in default tag handling.
* `glbLength` is only known **after** decryption; validate the tail before
  allocating.
* Zero padding at container EOF is not part of the GLB — never copy it.
* Older meshopt decoders may fail on `gltfpack 1.x` output — use a current
  MeshoptDecoder.
* GLTFExporter processes animation tracks asynchronously; don't assume the
  main thread is blocked while it runs.
