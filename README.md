# meshy-viewer

A **100% client-side** viewer and converter for [Meshy AI](https://www.meshy.ai)
`.meshy` model files — decrypts, renders with three.js, and converts to
standard 3D formats. No server, no build step: deploy the folder as-is to
**GitHub Pages** (or any static host).

![viewer](https://img.shields.io/badge/three.js-r170-049EF2) ![deps](https://img.shields.io/badge/dependencies-0-brightgreen) ![crypto](https://img.shields.io/badge/crypto-WebCrypto%20AES--GCM-blue)

## What it does

| Step | How |
|---|---|
| Decrypt `.meshy` → GLB | AES-256-GCM via the browser's native `crypto.subtle` (see [FORMAT.md](FORMAT.md)) |
| Render | three.js `GLTFLoader` + `MeshoptDecoder` (also Draco / KTX2-ready) |
| Convert | one-click export to **GLB / glTF / OBJ / STL / PLY** — pure JS exporters |

Everything runs in the browser. Your model never leaves your machine.

## Run it locally

WebCrypto needs a secure context, so use any static server:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

or `npx serve .` — whatever you like. Opening `index.html` via `file://`
will not work (blocked `crypto.subtle` + module CORS).

## Deploy to GitHub Pages

1. Push this folder to a repository (the `sample/` subfolder is optional but
   gives visitors a working demo out of the box — delete it if you don't want
   a 5.7 MB asset in your repo, the viewer works without it).
2. Repo **Settings → Pages → Deploy from branch** → `main` / root.
3. Done: `https://<user>.github.io/<repo>/`.

Features: drag & drop `.meshy` / `.glb` / `.gltf` anywhere, or use *Open file…*;
wireframe / spin / grid / reset; live stats (vertices, triangles, textures,
decrypt+parse timing); export buttons.

## Files

```
index.html            UI shell (import map loads three.js r170 from jsDelivr)
js/meshy-loader.js    pure-JS .meshy → GLB decoder (WebCrypto AES-256-GCM)
js/main.js            scene, controls, stats, exporters
sample/model.meshy    bundled sample asset (optional)
FORMAT.md             full reverse-engineered container specification
```

## Notes & limits

* The bundled sample is a *textured* AI mesh (511k vertices, 954k triangles,
  3 WebP textures) — a good stress test.
* OBJ/STL exports geometry only (no materials) — that's a limitation of the
  formats themselves, not the exporter.
* If a `.meshy` file was truncated in transit, decryption still succeeds but
  the meshopt stream fails; the viewer detects this and tells you to
  re-download. (Seen in the wild — see FORMAT.md "gotchas".)
* The container format belongs to Meshy; this loader exists for
  interoperability with assets **you generated**. Don't use it on assets you
  don't have rights to.
