# The `.meshy` container format

Reverse-engineered from binary analysis of a `model.meshy` asset and Meshy's own
`loader-worker` / `mesh_loader.wasm` runtime. Documented here for interoperability
with assets you generated yourself.

## TL;DR

A `.meshy` file is a **thin encryption wrapper around a standard glTF 2.0 binary
(GLB)**. Only the **first 8 192 bytes** of the GLB are encrypted
(AES-256-GCM); the remainder of the GLB — including the entire `BIN` chunk —
is stored verbatim after the 16-byte authentication tag. The GLB payload is
typically `gltfpack`-compressed with `EXT_meshopt_compression` (plus
`KHR_mesh_quantization`; textures may be WebP via `EXT_texture_webp`).

## Layout

```
offset   size  field
0        8     magic  "MESHY.AI"  (4d 45 53 48 59 2e 41 49)
8        2     version, uint16 LE   (observed value: 1)
10       12    AES-256-GCM nonce / IV (random per file)
22       10    reserved (observed zeros)
32       8192  AES-256-GCM ciphertext  = plaintext GLB bytes [0 .. 8192)
8240     16    GCM authentication tag over those 8192 bytes
8256     N     plaintext GLB bytes [8192 .. glbLength)  ← NOT encrypted
...      pad   zero padding up to the container's file size (optional)
```

* `glbLength` is declared **inside** the encrypted head (GLB header field at
  plaintext offset 8, little-endian `uint32`), so a decoder learns the total
  size only after decryption.
* Plaintext head always starts with `glTF` (`67 6c 54 46`), version 2.

## The key

The AES-256 key is a 32-byte ASCII string, stored in the wasm as a decoy
"JSON literal" (a string fragment used elsewhere for MBC metadata), and copied
into a global at runtime:

```
JSON{"accessors":[{"bufferView":
```

(as bytes: `4a 53 4f 4e 7b 22 61 63 63 65 73 73 6f 72 73 22 3a 5b 7b 22 62 75
66 66 65 72 56 69 65 77 22 3a`)

It is the same for every file — the per-file nonce provides the randomness.
AEAD additional authenticated data is empty.

## Why only 8 KiB is encrypted

Meshy's viewer decrypts in a worker (`/resource/decrypt/loader-worker.min.js`
→ `mesh_loader.wasm`). The wasm caps the encrypted region at
`min(fileSize − 32, 8208) − 16` bytes, i.e. at most 8 192 bytes of ciphertext
plus one 16-byte tag. Everything after the tag is appended to the plaintext
head unmodified, producing the original GLB. The 8 KiB budget comfortably
covers the GLB header, the JSON chunk and the start of the BIN chunk for
typical models; the heavy geometry stays in the clear (it is gltfpack/meshopt
compressed anyway).

## Decryption algorithm (reference)

```js
async function decryptMeshy(buffer /* ArrayBuffer */) {
  const u8 = new Uint8Array(buffer);
  if (new TextDecoder().decode(u8.slice(0, 8)) !== "MESHY.AI")
    throw new Error("bad magic");
  const nonce = u8.slice(10, 22);
  const key = new TextEncoder().encode('JSON{"accessors":[{"bufferView":'); // 32 B
  const ct = u8.slice(32, 32 + 8192);
  const tag = u8.slice(32 + 8192, 32 + 8192 + 16);
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const head = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, concat(ct, tag)));
  const glbLength = head[8] | (head[9] << 8) | (head[10] << 16) | (head[11] << 24);
  const tailStart = 32 + 8192 + 16;
  const out = new Uint8Array(glbLength);
  out.set(head, 0);
  out.set(u8.subarray(tailStart, tailStart + (glbLength - 8192)), 8192);
  return out.buffer;   // → standard GLB, load with GLTFLoader + MeshoptDecoder
}
```

`crypto.subtle` requires a secure context: `https://` (e.g. GitHub Pages) or
`localhost`. See `js/meshy-loader.js` in this repository for the hardened
implementation.

## Inside the GLB

Typical payload (AI-generated textured mesh, packaged by Meshy):

* generator `gltfpack 1.2` (older assets: 0.25)
* `extensionsRequired`: `KHR_mesh_quantization`, `EXT_meshopt_compression`
* `extensionsUsed`: additionally `KHR_texture_transform`, `EXT_texture_webp`
* geometry: quantized attributes + octahedral normals + meshopt index buffer
* one mesh, one material, PBR `baseColorTexture` (WebP)

Any glTF 2.0 loader with meshopt support renders it directly:
three.js `GLTFLoader` + `MeshoptDecoder`, Blender ≥ 3.x, gltf-transform, etc.
A fully standard (extension-free) GLB/OBJ/STL can be produced by loading the
decrypted GLB and re-exporting the decoded meshes — which is exactly what the
bundled viewer's *Export* buttons do.

## trivia / gotchas

* `file model.meshy` reports `data` — the container has no registered magic.
* The trailing zero padding is *not* part of the GLB; ignore bytes past
  `glbLength`.
* If a `.meshy` file is truncated in transit, the encrypted head still
  authenticates (only the first 8 KiB is protected) and the GLB header still
  parses — the failure only surfaces when the meshopt decoder hits the zero
  run (`Malformed buffer data`). If that happens, re-download the asset.
* Meshy's own wasm bundles an older meshopt codec; files packaged by
  `gltfpack ≥ 1.x` can make it fail with `meshopt decompression failed for
  bufferView 0` even when intact. A current MeshoptDecoder (as used here)
  decodes them fine.
