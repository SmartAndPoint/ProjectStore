// A kept file's type, name and limit, and the words of a refusal (the spec
// "Attachments in the core: a folder named by the layout, content-hash names,
// the edit verb's --attach, the attachment edge and doctor's findings", alias
// `attachments`, contract 2; the ADR "Pictures and PDFs live in one attachments
// folder of the layout…", decisions 2–4).
//
// It imports nothing, so the same file runs in Node, for the edit verb and
// doctor, and in the dashboard's page, which loads it from the core through the
// server's `/attachment.js`: the page names a pasted picture exactly as the verb
// will, and holds no copy of this code.
//
// The type is read from the first bytes, never from a file's name, so an HTML
// file named `shot.png` is no picture. The name is the first 16 hex digits of
// the bytes' SHA-256, then a dot and the type: the same bytes get the same name
// on any day, from any caller.

/* eslint-disable n/no-unsupported-features/node-builtins -- the global crypto.subtle is present from Node 20 (engines) and stable from 23; the module must not import node:crypto, because the dashboard's page loads it in the browser */

// The limit of one kept file, in bytes (5 MiB).
export const MAX_BYTES = 5 * 1024 * 1024;

// The types a vault keeps, in the order a message names them.
export const KEPT_TYPES = Object.freeze(["png", "jpg", "gif", "webp", "pdf"]);

const LABEL = Object.freeze({ png: "PNG", jpg: "JPEG", gif: "GIF", webp: "WebP", pdf: "PDF" });

// 16 lowercase hex digits, a dot and any extension: the shape doctor, the
// resolver and the text checks read. A name the verb writes is narrower: one of
// KEPT_TYPES as its extension.
const KEPT_SHAPE = /^[0-9a-f]{16}\.[^./\\]+$/;

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("attachment: bytes must be a Uint8Array, a Buffer or an ArrayBuffer");
}

const startsWith = (b, sig, at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// The type of the bytes, from their first bytes: "png", "jpg", "gif", "webp",
// "pdf", or null for anything else.
export function typeOf(input) {
  const b = bytesOf(input);
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "webp";
  if (startsWith(b, ascii("%PDF-"))) return "pdf";
  return null;
}

// The name a kept file gets: `<16 hex>.<type>`, or null when the type is none
// of the kept ones.
export async function nameOf(input) {
  const b = bytesOf(input);
  const type = typeOf(b);
  if (!type) return null;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", b));
  let hex = "";
  for (let i = 0; i < 8; i++) hex += digest[i].toString(16).padStart(2, "0");
  return `${hex}.${type}`;
}

// Whether a file name has the kept shape (any extension).
export const isKeptShape = (name) => typeof name === "string" && KEPT_SHAPE.test(name);

// Whether a file name is one the verb writes (a kept type as its extension).
export const isWrittenName = (name) => isKeptShape(name) && KEPT_TYPES.includes(name.slice(17));

const MIB = (n) => `${n / (1024 * 1024)} MiB`;

// The words of a refusal, shared by the verb and the page:
//   refusal("type", { file })              — a file of a type not kept
//   refusal("size", { file, size })        — a file over MAX_BYTES
//   refusal("unlinked", { file, path, rel }) — a file the text does not link;
//                                            `rel` is the link from the item
export function refusal(kind, { file = "the file", size, path, rel } = {}) {
  if (kind === "type")
    return `${file}: keeps ${KEPT_TYPES.map((t) => LABEL[t])
      .join(", ")
      .replace(/, (?=[^,]*$)/, " and ")}; link other files from where they live`;
  if (kind === "size")
    return `${file}: ${size ?? "its size"} bytes is over the limit of ${MAX_BYTES} bytes (${MIB(MAX_BYTES)}) for one file`;
  if (kind === "unlinked")
    return `${file}: the text does not link ${path}; link it by a relative path with no title and no <…>${rel ? `, as ![name](${rel})` : ""}`;
  throw new Error(`attachment: no refusal named ${kind}`);
}
