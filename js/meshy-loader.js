/**
 * meshy-loader.js — pure client-side decoder for Meshy AI `.meshy` model files.
 *
 * Reverse-engineered container (see FORMAT.md):
 *   [0..8)   magic "MESHY.AI"          [10..22)  AES-256-GCM nonce
 *   [32..)   ciphertext of GLB bytes [0..8192), followed by a 16-byte GCM tag,
 *   then the plaintext remainder of the GLB. Optional zero padding at EOF.
 *
 * The decrypted result is a standard glTF 2.0 binary (GLB) that uses
 * EXT_meshopt_compression — feed it to three's GLTFLoader with MeshoptDecoder.
 *
 * Uses only WebCrypto + typed arrays: no server, no WASM, works on
 * GitHub Pages / any static host (requires a secure context: https or localhost).
 */

const MESHY_MAGIC = "MESHY.AI";
// 32-byte AES-256 key, hidden in mesh_loader.wasm as a fake JSON string literal.
const MESHY_KEY_LITERAL = 'JSON{"accessors":[{"bufferView":';
const HEAD_CIPHER_LEN = 8192;
const TAG_LEN = 16;
const HEADER_LEN = 32; // 8 magic + 2 version + 12 nonce + 10 reserved

let cachedKeyPromise = null;
function getKey() {
  if (!cachedKeyPromise) {
    const raw = new TextEncoder().encode(MESHY_KEY_LITERAL);
    if (raw.length !== 32) throw new Error("internal: bad key length");
    cachedKeyPromise = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  }
  return cachedKeyPromise;
}

const u32le = (u8, o) => u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24);

function magicOf(u8, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(u8[i]);
  return s;
}

/** True when the buffer carries the MESHY.AI magic. */
export function isMeshyBuffer(buffer) {
  if (buffer.byteLength < 8) return false;
  return magicOf(new Uint8Array(buffer, 0, 8), 8) === MESHY_MAGIC;
}

/** GLB magic check ("glTF"). */
export function isGLBBuffer(buffer) {
  if (buffer.byteLength < 4) return false;
  return magicOf(new Uint8Array(buffer, 0, 4), 4) === "glTF";
}

/**
 * Decrypt a .meshy container and return { glb: ArrayBuffer, info: {...} }.
 * Throws Error with a descriptive message on bad magic, truncated payloads
 * or authentication failure.
 */
export async function decryptMeshy(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (u8.length < HEADER_LEN + HEAD_CIPHER_LEN + TAG_LEN) {
    throw new Error(`File too small (${u8.length} B): a .meshy container needs at least ${HEADER_LEN + HEAD_CIPHER_LEN + TAG_LEN} B`);
  }
  if (magicOf(u8, 8) !== MESHY_MAGIC) {
    throw new Error("Invalid file: MESHY.AI magic header not found");
  }

  const version = u8[8] | (u8[9] << 8);
  const nonce = u8.slice(10, 22);
  const tag = u8.slice(HEADER_LEN + HEAD_CIPHER_LEN, HEADER_LEN + HEAD_CIPHER_LEN + TAG_LEN);

  // WebCrypto expects ciphertext||tag for AES-GCM.
  const boxed = u8.slice(HEADER_LEN, HEADER_LEN + HEAD_CIPHER_LEN + TAG_LEN);

  let head;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await getKey(), boxed);
    head = new Uint8Array(plain);
  } catch {
    throw new Error("Decryption failed: authentication tag mismatch (file corrupted or not a .meshy file)");
  }
  if (magicOf(head, 4) !== "glTF") {
    throw new Error("Decrypted payload is not a GLB");
  }

  const glbLength = u32le(head, 8);
  const tailStart = HEADER_LEN + HEAD_CIPHER_LEN + TAG_LEN;
  const tailNeeded = glbLength - HEAD_CIPHER_LEN;
  const tailAvail = u8.length - tailStart;
  if (tailAvail < tailNeeded) {
    const have = HEAD_CIPHER_LEN + Math.max(0, tailAvail);
    throw new Error(
      `Truncated file: GLB declares ${glbLength.toLocaleString()} B but only ${have.toLocaleString()} B are present ` +
      `(${(100 * have / glbLength).toFixed(1)}%). The mesh data is incomplete — re-download the asset.`
    );
  }

  const out = new Uint8Array(glbLength);
  out.set(head, 0);
  out.set(u8.subarray(tailStart, tailStart + tailNeeded), HEAD_CIPHER_LEN);

  return {
    glb: out.buffer,
    info: {
      version,
      nonceHex: [...nonce].map(b => b.toString(16).padStart(2, "0")).join(""),
      glbLength,
      containerSize: u8.length,
      paddingBytes: u8.length - tailStart - tailNeeded,
    },
  };
}

/**
 * Accepts .meshy, .glb or .gltf(JSON) input and returns
 * { kind: "glb" | "gltf-json", data: ArrayBuffer, info }.
 * For .meshy the data is the decrypted GLB.
 */
export async function loadModelBuffer(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const magic4 = magicOf(u8, 4);

  if (magicOf(u8, 8) === MESHY_MAGIC) {
    const { glb, info } = await decryptMeshy(u8.buffer);
    return { kind: "glb", data: glb, info: { ...info, source: "meshy" } };
  }
  if (magic4 === "glTF") {
    return { kind: "glb", data: u8.slice().buffer, info: { source: "glb" } };
  }
  // try JSON .gltf (plain or base64/uri embedded)
  const text = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 1 << 16)));
  if (text.trimStart().startsWith("{")) {
    return { kind: "gltf-json", data: u8.slice().buffer, info: { source: "gltf" } };
  }
  throw new Error("Unrecognized file: expected .meshy, .glb or .gltf");
}
