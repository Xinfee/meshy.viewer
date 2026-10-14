# meshy.viewer

A **100% client-side** 3D model viewer and converter that runs entirely in
your browser. It opens `.meshy` containers as well as standard `.glb` /
`.gltf` files — static or skeletal-animated — and renders them with three.js.

- **Zero external requests at runtime** — the whole three.js runtime and all
  decoders are vendored in `vendor/`, and both demos (including textures) are
  bundled on the site.
- **Nothing leaves your machine** — files are processed locally; there is no
  server and no upload.

## Using it

The workspace starts **empty**. Use the **Samples ▾** button (or the card in
the middle of the screen) to load one of the two bundled demos, or drop your
own `.meshy` / `.glb` / `.gltf` file anywhere on the page:

* **Static sample** — a textured AI-generated mesh (511k vertices, 954k
  triangles, WebP textures embedded).
* **Animated sample** — a skinned character with a walk cycle (24-bone rig,
  PNG texture embedded).

### Features

* **View** — orbit controls, wireframe, grid, auto-spin.
* **Light** — studio lights or an HDRI environment (bundled EXR, or your own
  `.hdr` / `.exr`), with optional background.
* **Animate** — clip picker, play/pause, timeline scrub, variable speed,
  bone overlay.
* **Convert** — one-click export to GLB / glTF (skin + animations + textures
  preserved) and OBJ / STL / PLY (bind-pose geometry).
* **Extract** — original embedded texture images, skeleton hierarchy JSON,
  animation keyframes JSON.

## Run it locally

Any static file server works (a secure context is required for local file
processing):

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Opening `index.html` via `file://` will not work.

## Deploy

Push this folder to a repository and point GitHub Pages (Settings → Pages →
Deploy from branch) at the branch hosting it — the site is a plain static
folder with no build step.

## Scope note

This tool exists for interoperability with assets **you generated**. The
bundled samples are included for demonstration. Don't use it on assets you
don't have rights to.
