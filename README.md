# meshy-viewer

A **100% client-side** viewer and converter for [Meshy AI](https://www.meshy.ai)
model exports — decrypts `.meshy` containers, renders static *and* **animated**
(skeletal) models with three.js, plays animation clips, lights with HDRI
environments, and converts/extracts to standard formats. No server, no build
step: deploy the folder as-is to **GitHub Pages** (or any static host).

![viewer](https://img.shields.io/badge/three.js-r170-049EF2) ![deps](https://img.shields.io/badge/dependencies-0-brightgreen) ![crypto](https://img.shields.io/badge/crypto-WebCrypto%20AES--GCM-blue)

## What it does

| Step | How |
|---|---|
| Decrypt `.meshy` → GLB | AES-256-GCM via the browser's native `crypto.subtle` (see [FORMAT.md](FORMAT.md)) |
| Load animated exports | `*_withSkin.glb` etc. are plain GLB — auto-detected by magic bytes |
| Render | three.js `GLTFLoader` + `MeshoptDecoder` (also Draco / KTX2-ready) |
| Animate | `AnimationMixer` playback: clip picker, play/pause, timeline scrub, 0–2.5× speed, `SkeletonHelper` bone overlay |
| Light | Studio lights or HDRI — bundled Meshy decor-shop EXR, or drop your own `.hdr` / `.exr` (ACES tone mapping, optional as background) |
| Convert | one-click export to **GLB / glTF / OBJ / STL / PLY** — GLB/glTF keep **skin + animations + textures** |
| Extract | original texture images (verbatim bytes from the GLB), skeleton hierarchy JSON (bind pose), full animation keyframe JSON |

Everything runs in the browser. Your model never leaves your machine.

## Supported inputs

* `*.meshy` — Meshy's encrypted static container (AES-256-GCM + meshopt, see
  [FORMAT.md](FORMAT.md))
* `*.glb` / `*.gltf` — any glTF 2.0 file, including Meshy's animated
  `Animation_*_withSkin.glb` exports (Mixamo-style rigs, embedded textures)
* `.hdr` / `.exr` — environment maps for the lighting selector

The workspace starts **empty** — nothing is loaded until you ask for it. Hit
the **Samples ▾** button (or the card in the middle of the screen) to pick one
of the bundled demos:

* **Static — encrypted .meshy container** (`sample/model.meshy`, 5.4 MB):
  decrypted in-browser via WebCrypto; 511k verts, 3 WebP textures embedded.
* **Animated — walking man (skinned GLB)**
  (`sample/Animation_Walking_withSkin.glb`, 15.4 MB): 24-bone Mixamo-style
  rig + walk cycle, PNG texture embedded.

Both demos are **fully self-contained** — textures live inside the file, so
loading the sample needs no other downloads. Your own files work the same way:
drag & drop a `.meshy` / `.glb` / `.gltf` anywhere, or use *Open file…*.

## Run it locally

WebCrypto needs a secure context, so use any static server:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

or `npx serve .` — whatever you like. Opening `index.html` via `file://`
will not work (blocked `crypto.subtle` + module CORS).

## Deploy to GitHub Pages

1. Push this folder to a repository (the `sample/` and `env/` subfolders are
   optional but give visitors working static + animated demos out of the box —
   together ≈ 21 MB; delete them if you want a slim repo, the viewer works
   without them).
2. Repo **Settings → Pages → Deploy from branch** → the branch hosting this
   folder (for this repo: `gh-pages`) / root.
3. Done: `https://<user>.github.io/<repo>/`.

## Files

```
index.html                          UI shell (import map loads three.js r170 from jsDelivr)
js/meshy-loader.js                  pure-JS .meshy → GLB decoder + GLB texture extractor
js/main.js                          scene, animation playback, HDRI, exporters, extractors
sample/model.meshy                  bundled static sample (optional)
sample/Animation_Walking_withSkin.glb  bundled animated demo: 24-bone rig + walk cycle (optional)
env/decor_shop_2k_Lower45Sat.exr    bundled HDRI environment (optional)
FORMAT.md                           reverse-engineered container spec + animated-export findings
```

## Notes & limits

* The workspace is empty on start; samples load on demand from the `sample/`
  and `env/` folders (delete them for a slim repo — the viewer works without
  them, only the Samples entries will fail).
* The bundled static sample is a *textured* AI mesh (511k vertices, 954k
  triangles, 3 WebP textures) — a good stress test. The animated demo is a
  24-joint Mixamo-style rig with a 1.07 s walk cycle.
* GLB/glTF exports are written from the **bind pose** with all animation clips
  attached (same convention as Meshy's own exports). OBJ/STL/PLY always carry
  bind-pose geometry — those formats simply have no skeleton/animation concept.
* GLTF re-export does not round-trip Meshy's `KHR_materials_specular` /
  `KHR_materials_ior` (three.js exporter limitation); base colour, normal and
  metallic-roughness maps survive intact.
* Texture extraction pulls the **original embedded bytes** (PNG/JPEG/WebP) out
  of the GLB `BIN` chunk — no canvas re-encode. WebP files may need a browser
  or converter to view.
* If a `.meshy` file was truncated in transit, decryption still succeeds but
  the meshopt stream fails; the viewer detects this and tells you to
  re-download. (Seen in the wild — see FORMAT.md "gotchas".)
* The container format belongs to Meshy; this loader exists for
  interoperability with assets **you generated**. Don't use it on assets you
  don't have rights to.
