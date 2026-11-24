// The core's attachments (the spec "Attachments in the core: a folder named by
// the layout, content-hash names, the edit verb's --attach, the attachment edge
// and doctor's findings", alias `attachments`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planScaffold } from "../scripts/scaffold.mjs";
import { MAX_BYTES, KEPT_TYPES, typeOf, nameOf, isKeptShape, isWrittenName, refusal } from "../scripts/attachment.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// The first bytes of each kept type, padded so each fixture is a few hundred bytes.
const pad = (head, n = 300) => {
  const b = new Uint8Array(n);
  b.set(head);
  for (let i = head.length; i < n; i++) b[i] = (i * 31) & 0xff;
  return b;
};
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
export const FIXTURES = {
  png: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: pad([0xff, 0xd8, 0xff, 0xe0]),
  gif: pad(ascii("GIF89a")),
  gif87: pad(ascii("GIF87a")),
  webp: pad([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")]),
  pdf: pad(ascii("%PDF-1.7\n")),
};

const sha16 = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// A copy of a folder tree (fs.cpSync is experimental before Node 22.3).
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(join(from, e.name), join(to, e.name));
    else writeFileSync(join(to, e.name), readFileSync(join(from, e.name)));
  }
}

// [attachments#1]
test("attachments: the plan of init is equal with and without the layout's attachments key, and makes no folder for it", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-att-root-"));
  mkdirSync(join(root, "scaffold/layouts"), { recursive: true });
  copyTree(join(REPO, "templates"), join(root, "templates"));
  const layout = JSON.parse(readFileSync(join(REPO, "scaffold/layouts/engineering.json"), "utf8"));
  assert.deepEqual(layout.attachments, { path: "attachments" }, "the engineering layout names the folder");
  const without = { ...layout };
  delete without.attachments;
  writeFileSync(join(root, "scaffold/layouts/engineering.json"), JSON.stringify(without));
  const vault = join(mkdtempSync(join(tmpdir(), "ps-att-vault-")), "vault");
  const withKey = planScaffold(vault, { layout: "engineering", language: "en", root: REPO });
  const withoutKey = planScaffold(vault, { layout: "engineering", language: "en", root });
  assert.equal(withKey.ok, true, JSON.stringify(withKey.refusals));
  assert.deepEqual(withKey, withoutKey);
  assert.ok(!JSON.stringify(withKey).includes("attachments"), "init makes no attachments folder and no README for it");
});

// [attachments#2]
test("attachments: typeOf reads the first bytes, never the name, and knows five types", () => {
  assert.deepEqual(KEPT_TYPES, ["png", "jpg", "gif", "webp", "pdf"]);
  assert.equal(typeOf(FIXTURES.png), "png");
  assert.equal(typeOf(FIXTURES.jpg), "jpg");
  assert.equal(typeOf(FIXTURES.gif), "gif");
  assert.equal(typeOf(FIXTURES.gif87), "gif");
  assert.equal(typeOf(FIXTURES.webp), "webp");
  assert.equal(typeOf(FIXTURES.pdf), "pdf");
  assert.equal(typeOf(Buffer.from(FIXTURES.png)), "png", "a Buffer is read too");
  assert.equal(typeOf(FIXTURES.png.buffer), "png", "an ArrayBuffer is read too");
});

// [attachments#2]
test("attachments: an HTML file named shot.png, a RIFF that is not WebP and short bytes have no type (edge)", async () => {
  const html = new TextEncoder().encode("<!doctype html><title>shot.png</title>");
  assert.equal(typeOf(html), null);
  assert.equal(await nameOf(html), null);
  const wav = pad([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")]);
  assert.equal(typeOf(wav), null);
  assert.equal(typeOf(new Uint8Array([0x89, 0x50])), null);
  assert.equal(typeOf(new Uint8Array(0)), null);
  assert.throws(() => typeOf("not bytes"), /bytes must be/);
});

// [attachments#2]
test("attachments: nameOf is the first 16 hex of the SHA-256 and the type, equal to node:crypto's", async () => {
  for (const [key, bytes] of Object.entries(FIXTURES)) {
    const type = key === "gif87" ? "gif" : key;
    const name = await nameOf(bytes);
    assert.equal(name, `${sha16(bytes)}.${type}`, key);
    assert.ok(isKeptShape(name) && isWrittenName(name), key);
  }
  assert.equal(await nameOf(Buffer.from(FIXTURES.png)), await nameOf(FIXTURES.png), "a Buffer names the same");
});

// [attachments#2]
test("attachments: the limit is 5 MiB, and a file one byte over it is over (edge)", () => {
  assert.equal(MAX_BYTES, 5_242_880);
  assert.ok(!(MAX_BYTES > MAX_BYTES), "5,242,880 bytes is within the limit");
  assert.ok(MAX_BYTES + 1 > MAX_BYTES, "5,242,881 bytes is over it");
  assert.match(
    refusal("size", { file: "big.png", size: MAX_BYTES + 1 }),
    /5242881 bytes is over the limit of 5242880 bytes \(5 MiB\)/,
  );
});

// [attachments#2]
test("attachments: the kept shape takes any extension, a written name only the five types", () => {
  assert.ok(isKeptShape("0123456789abcdef.png"));
  assert.ok(isKeptShape("0123456789abcdef.svg"), "the kept shape takes any extension");
  assert.ok(!isWrittenName("0123456789abcdef.svg"), "a written name is one of the five");
  for (const n of [
    "0123456789ABCDEF.png",
    "0123456789abcde.png",
    "0123456789abcdef",
    "x/0123456789abcdef.png",
    "0123456789abcdef.tar.gz",
  ])
    assert.ok(!isKeptShape(n), n);
});

// [attachments#2]
test("attachments: the refusals' words name the file, the types, the limit and the link to use", () => {
  assert.equal(
    refusal("type", { file: "clip.mp4" }),
    "clip.mp4: keeps PNG, JPEG, GIF, WebP and PDF; link other files from where they live",
  );
  assert.match(
    refusal("unlinked", {
      file: "shot.png",
      path: "attachments/0123456789abcdef.png",
      rel: "../../../attachments/0123456789abcdef.png",
    }),
    /does not link attachments\/0123456789abcdef\.png; link it by a relative path with no title and no <…>, as !\[name\]\(\.\.\/\.\.\/\.\.\/attachments/,
  );
  assert.throws(() => refusal("other"), /no refusal named other/);
});

// [attachments#2]
test("attachments: the module imports nothing, so the page can load it as it is", () => {
  const src = readFileSync(join(REPO, "scripts/attachment.mjs"), "utf8");
  assert.ok(!/^\s*import\s/m.test(src), "no static import");
  assert.ok(!/\bimport\s*\(/.test(src), "no dynamic import");
  assert.ok(!/\brequire\s*\(/.test(src), "no require");
});

// A small vault: one epic, one story linking a kept file, a missing kept file,
// a file of another name in the folder, and a picture beside the note.
async function linkVault() {
  const vault = mkdtempSync(join(tmpdir(), "ps-att-links-"));
  const put = (rel, text) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  const name = await nameOf(FIXTURES.png);
  put(`attachments/${name}`, Buffer.from(FIXTURES.png));
  put("attachments/notes.txt", "kept elsewhere\n");
  put("epics/PS-A/epic.md", "---\ntype: epic\nid: PS-A\ntitle: A\nstatus: planned\n---\n\n# A\n");
  put(
    "epics/PS-A/stories/story-a.md",
    [
      "---",
      "type: story",
      "id: story-a",
      "title: Story A",
      "status: planned",
      "---",
      "",
      "# Story A",
      "",
      "## Description",
      "",
      `![shot](../../../attachments/${name})`,
      "![gone](../../../attachments/0000000000000000.png)",
      "[notes](../../../attachments/notes.txt)",
      "![beside](./pic.png)",
      "",
    ].join("\n"),
  );
  put("epics/PS-A/stories/pic.png", Buffer.from(FIXTURES.png));
  return { vault, name };
}

// [attachments#9]
test("attachments: a kept link is an attachment edge, a missing kept file is dead, other links are as before", async () => {
  const { buildGraph } = await import("../scripts/graph.mjs");
  const { loadLayout } = await import("../scripts/lib.mjs");
  const { vault, name } = await linkVault();
  const g = buildGraph({ vault_path: vault, layout: "engineering" }, loadLayout("engineering", REPO));
  const from = "epics/PS-A/stories/story-a.md";
  const of = (kind) =>
    g.edges
      .filter((e) => e.from === from && e.kind === kind)
      .map((e) => e.to)
      .sort();
  assert.deepEqual(of("attachment"), [`attachments/${name}`]);
  assert.deepEqual(of("dead"), ["../../../attachments/0000000000000000.png"]);
  assert.deepEqual(of("out-of-scope"), ["attachments/notes.txt", "epics/PS-A/stories/pic.png"]);
  assert.ok(!g.nodes.some((n) => n.path.startsWith("attachments/")), "a kept file is never a node");
  assert.ok(g.content.includes(`attachments/${name}`), "graph.md renders the edge");
});

// [attachments#9]
test("attachments: with a layout that keeps no attachments, the same link is out-of-scope, as before (edge)", async () => {
  const { buildGraph } = await import("../scripts/graph.mjs");
  const { loadLayout } = await import("../scripts/lib.mjs");
  const { vault, name } = await linkVault();
  const layout = { ...loadLayout("engineering", REPO) };
  delete layout.attachments;
  const g = buildGraph({ vault_path: vault, layout: "engineering" }, layout);
  const kinds = g.edges.filter((e) => e.to === `attachments/${name}`).map((e) => e.kind);
  assert.deepEqual(kinds, ["out-of-scope"]);
  assert.ok(!g.edges.some((e) => e.kind === "attachment"));
});
