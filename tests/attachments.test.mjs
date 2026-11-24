// The core's attachments (the spec "Attachments in the core: a folder named by
// the layout, content-hash names, the edit verb's --attach, the attachment edge
// and doctor's findings", alias `attachments`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { planScaffold } from "../scripts/scaffold.mjs";
import { run } from "../scripts/cli.mjs";
import { runEdit } from "../scripts/item-verbs.mjs";
import { readEvents } from "../scripts/write-record.mjs";
import { sourceHarness } from "../scripts/harness.mjs";
import { buildNodeIndex, loadLayout, loadTemplate, renderTemplate } from "../scripts/lib.mjs";
import { checkAttachments, runVaultChecks } from "../scripts/doctor.mjs";
import { spawnSync } from "node:child_process";
import { makeVaultProject } from "./fixtures/vault.mjs";
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

// ─── the edit verb's --attach (contracts 3 to 8) ──────────────────────

const STORY = "epics/PS-X/stories/story-faster-login.md";
const UP = "../../../attachments";
const SID_ENV = sourceHarness().runtime.session_id_env;
const sink = () => {
  const s = { text: "", isTTY: false, write: (c) => ((s.text += c), true) };
  return s;
};
async function cli(proj, args, { sid = null } = {}) {
  const stdout = sink();
  const stderr = sink();
  const env = { ...process.env, CI: "1" };
  delete env[SID_ENV];
  if (sid) env[SID_ENV] = sid;
  const code = await run([...args, "--json", "--project", proj], {
    env,
    cwd: proj,
    stdout,
    stderr,
    stdin: { isTTY: false },
  });
  let json = null;
  try {
    json = JSON.parse(stdout.text);
  } catch {}
  return { code, out: stdout.text, err: stderr.text, json };
}
// Every file of a folder as bytes, so a picture compares as it is.
function bytesSnapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        out[`${relative(dir, p)}/`] = "dir";
        walk(p);
      } else out[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}
async function storyVault() {
  const { proj, vault } = makeVaultProject();
  const epic = renderTemplate(loadTemplate("en", "epic"), { id: "PS-X", title: "Things", date: "2026-11-14", tags: [] })
    .split("\n")
    .filter((l) => !l.includes("](./stories/story-001.md)"))
    .join("\n");
  writeFileSync(join(vault, "epics/PS-X/epic.md"), epic);
  writeFileSync(
    join(vault, "epics", "README.md"),
    "# Epics\n\n## Index\n\n| File | Title | Status | Date |\n|------|-------|--------|------|\n",
  );
  const r = await cli(proj, ["create", "story", "PS-X", "Faster login", "--write"]);
  assert.equal(r.code, 0, r.err + r.out);
  return { proj, vault, at: (rel) => join(vault, rel) };
}
const tmpFile = (name, content) => {
  const p = join(mkdtempSync(join(tmpdir(), "att-file-")), name);
  writeFileSync(p, content);
  return p;
};
async function readStory(fx) {
  const r = await cli(fx.proj, ["edit", STORY]);
  assert.equal(r.code, 0, r.err + r.out);
  return r.json.result;
}
// An edit whose Description gains `line`, with the given files attached.
async function editWith(fx, line, attach = [], { write = true, sid = null, base = null } = {}) {
  const now = await readStory(fx);
  const text = now.body.replace("## Description\n", `## Description\n\n${line}\n`);
  const args = ["edit", STORY, "--from", tmpFile("text.md", text), "--base", base ?? now.hash];
  for (const a of attach) args.push("--attach", a);
  if (write) args.push("--write");
  return cli(fx.proj, args, { sid });
}
async function refusesAll(fx, run1, match) {
  const before = bytesSnapshot(fx.vault);
  const r = await run1();
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.json.result.error, match);
  assert.ok(!("files" in r.json.result), "a refusal has no files key");
  assert.deepEqual(bytesSnapshot(fx.vault), before, "the vault is byte-for-byte as before");
}

// [attachments#3]
test("attachments: --attach needs a text, and a path that is a readable file (failure)", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  let r = await cli(fx.proj, ["edit", STORY, "--attach", png]);
  assert.equal(r.code, 2, r.out + r.err);
  r = await editWith(fx, "x", [dirname(png)], { write: false });
  assert.equal(r.code, 2, r.out + r.err);
  assert.ok(!existsSync(fx.at("attachments")));
});

// [attachments#3]
test("attachments: the plan lists each file as to-create, and writes nothing", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  const before = bytesSnapshot(fx.vault);
  const r = await editWith(fx, `![shot](${UP}/${name})`, [png], { write: false });
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(r.json.result.files, [
    { path: `attachments/${name}`, type: "png", size: FIXTURES.png.length, state: "to-create" },
  ]);
  assert.equal(r.json.result.gitattributes, "to-change");
  assert.deepEqual(bytesSnapshot(fx.vault), before);
});

// [attachments#4]
test("attachments: a link at the wrong depth, a wikilink and an MP4 are refused, writing nothing (edge, failure)", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  await refusesAll(fx, () => editWith(fx, `![shot](../attachments/${name})`, [png]), /does not link attachments\//);
  await refusesAll(
    fx,
    () => editWith(fx, `![[attachments/${name}]]`, [png]),
    /as a wikilink; link a kept file by a relative Markdown link/,
  );
  const mp4 = tmpFile("clip.mp4", Buffer.from([0, 0, 0, 0x18, ...ascii("ftypmp42")]));
  await refusesAll(fx, () => editWith(fx, `![clip](${UP}/x.mp4)`, [mp4]), /keeps PNG, JPEG, GIF, WebP and PDF/);
  const big = tmpFile("big.png", Buffer.concat([Buffer.from(FIXTURES.png), Buffer.alloc(MAX_BYTES)]));
  await refusesAll(fx, () => editWith(fx, `![big](${UP}/x.png)`, [big]), /over the limit of 5242880 bytes/);
});

// [attachments#4]
test("attachments: a kept link to a missing file is refused on any edit, attached or not (edge)", async () => {
  const fx = await storyVault();
  await refusesAll(
    fx,
    () => editWith(fx, `![gone](${UP}/0000000000000000.png)`),
    /links attachments\/0000000000000000\.png, which is not in attachments\/ and not attached/,
  );
  const ok = await editWith(fx, "![beside](./pic.png)");
  assert.equal(ok.code, 0, "a picture beside the note is no attachment check's business");
  assert.ok(!("files" in ok.json.result), "a result without --attach has no files key");
});

// [attachments#4]
test("attachments: a symbolic-link folder, and a same-named file of another size, are refused in the plan and the write (failure)", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  mkdirSync(fx.at("attachments"));
  writeFileSync(fx.at(`attachments/${name}`), "not the same bytes");
  for (const write of [false, true])
    await refusesAll(fx, () => editWith(fx, `![shot](${UP}/${name})`, [png], { write }), /there with another size/);
  const elsewhere = mkdtempSync(join(tmpdir(), "att-elsewhere-"));
  const fx2 = await storyVault();
  symlinkSync(elsewhere, fx2.at("attachments"));
  for (const write of [false, true])
    await refusesAll(fx2, () => editWith(fx2, `![shot](${UP}/${name})`, [png], { write }), /is a symbolic link/);
});

// [attachments#5]
test("attachments: --write creates the file once, adds the .gitattributes line, then writes the text", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const copy = tmpFile("again.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  const r = await editWith(fx, `![shot](${UP}/${name})`, [png, copy]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(
    r.json.result.files.map((f) => [f.path, f.state]),
    [[`attachments/${name}`, "created"]],
  );
  assert.equal(r.json.result.gitattributes, "changed");
  assert.deepEqual(readFileSync(fx.at(`attachments/${name}`)), Buffer.from(FIXTURES.png));
  assert.equal(readFileSync(fx.at(".gitattributes"), "utf8"), "attachments/** -text\n");
  assert.ok(readFileSync(fx.at(STORY), "utf8").includes(`![shot](${UP}/${name})`));
});

// [attachments#5]
test("attachments: a changed text whose files are all found still adds the missing .gitattributes line (edge)", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  mkdirSync(fx.at("attachments"));
  writeFileSync(fx.at(`attachments/${name}`), Buffer.from(FIXTURES.png));
  const r = await editWith(fx, `![shot](${UP}/${name})`, [png]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(
    r.json.result.files.map((f) => f.state),
    ["found"],
  );
  assert.equal(r.json.result.gitattributes, "changed");
  assert.equal(readFileSync(fx.at(".gitattributes"), "utf8"), "attachments/** -text\n");
});

// [attachments#6]
test("attachments: a write refused after the files leaves none of this run's files, and keeps another run's (failure)", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  const now = await readStory(fx);
  const text = tmpFile("text.md", now.body.replace("## Description\n", `## Description\n\n![shot](${UP}/${name})\n`));
  const before = bytesSnapshot(fx.vault);
  const cfg = { vault_path: fx.vault, layout: "engineering", language: "en" };
  const r = await runEdit({
    values: { from: text, base: now.hash, attach: [png], write: true },
    positionals: [STORY],
    cfg,
    project: fx.proj,
    env: { ...process.env, CI: "1" },
    afterCompute: () =>
      writeFileSync(
        fx.at(STORY),
        readFileSync(fx.at(STORY), "utf8").replace("## Description\n", "## Description\n\nTheirs.\n"),
      ),
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.result.error, /changed after it was read/);
  const after = bytesSnapshot(fx.vault);
  delete after[STORY];
  const want = { ...before };
  delete want[STORY];
  assert.deepEqual(after, want, "no file, no folder and no .gitattributes of this run are left");

  // Another run's file in the folder stays when this run takes its own back.
  const fx2 = await storyVault();
  const now2 = await readStory(fx2);
  const text2 = tmpFile("text.md", now2.body.replace("## Description\n", `## Description\n\n![shot](${UP}/${name})\n`));
  const r2 = await runEdit({
    values: { from: text2, base: now2.hash, attach: [png], write: true },
    positionals: [STORY],
    cfg: { ...cfg, vault_path: fx2.vault },
    project: fx2.proj,
    env: { ...process.env, CI: "1" },
    afterCompute: () => {
      writeFileSync(fx2.at("attachments/1111111111111111.png"), Buffer.from(FIXTURES.png));
      writeFileSync(
        fx2.at(STORY),
        readFileSync(fx2.at(STORY), "utf8").replace("## Description\n", "## Description\n\nTheirs.\n"),
      );
    },
  });
  assert.equal(r2.code, 1, r2.text);
  assert.ok(existsSync(fx2.at("attachments/1111111111111111.png")), "the other run's file stays");
  assert.ok(!existsSync(fx2.at(`attachments/${name}`)), "this run's file is taken back");
});

// [attachments#7]
test("attachments: the same text with a missing linked file attached writes the file alone (edge)", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  const first = await editWith(fx, `![shot](${UP}/${name})`, [png]);
  assert.equal(first.code, 0, first.out + first.err);
  const storyBytes = readFileSync(fx.at(STORY));
  rmSync(fx.at(`attachments/${name}`));
  const now = await readStory(fx);
  const r = await cli(fx.proj, [
    "edit",
    STORY,
    "--from",
    tmpFile("t.md", now.body),
    "--base",
    now.hash,
    "--attach",
    png,
    "--write",
  ]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.result.same, true);
  assert.equal(r.json.result.written, true);
  assert.deepEqual(
    r.json.result.files.map((f) => f.state),
    ["created"],
  );
  assert.deepEqual(readFileSync(fx.at(STORY)), storyBytes, "the story's bytes are unchanged");
  assert.ok(existsSync(fx.at(`attachments/${name}`)));
  const again = await cli(fx.proj, [
    "edit",
    STORY,
    "--from",
    tmpFile("t.md", now.body),
    "--base",
    now.hash,
    "--attach",
    png,
    "--write",
  ]);
  assert.equal(again.json.result.written, false, "nothing to create: the answer is today's");
  assert.equal(again.json.result.gitattributes, null);
});

// [attachments#8]
test("attachments: each created file and the .gitattributes write are events of edit; without a session id nothing is recorded (edge)", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  const r = await editWith(fx, `![shot](${UP}/${name})`, [png], { sid: "s-att" });
  assert.equal(r.code, 0, r.out + r.err);
  const rels = readEvents(fx.proj, "s-att")
    .filter((e) => e.tool === "edit")
    .map((e) => e.rel)
    .sort();
  assert.deepEqual(rels, [".gitattributes", `attachments/${name}`, STORY].sort());
  const fx2 = await storyVault();
  const r2 = await editWith(fx2, `![shot](${UP}/${name})`, [png]);
  assert.equal(r2.code, 0);
  assert.ok(existsSync(fx2.at(`attachments/${name}`)));
});

// [attachments#9]
test("attachments: with a layout that keeps no attachments, the same link is out-of-scope, as before (edge)", async () => {
  const { buildGraph } = await import("../scripts/graph.mjs");

  const { vault, name } = await linkVault();
  const layout = { ...loadLayout("engineering", REPO) };
  delete layout.attachments;
  const g = buildGraph({ vault_path: vault, layout: "engineering" }, layout);
  const kinds = g.edges.filter((e) => e.to === `attachments/${name}`).map((e) => e.kind);
  assert.deepEqual(kinds, ["out-of-scope"]);
  assert.ok(!g.edges.some((e) => e.kind === "attachment"));
});

// ─── doctor's findings (contract 10) ─────────────────────────────────

const fsOf = (fx) => ({ vault_path: fx.vault, layout: "engineering", language: "en" });
const nodeIndexOf = (fx) => buildNodeIndex(fsOf(fx), loadLayout("engineering", REPO));
const byCheck = (findings) =>
  findings
    .filter((f) => f.check.startsWith("attachment-"))
    .map((f) => `${f.check} ${f.file}`)
    .sort();

// [attachments#10]
test("attachments: doctor names an orphan, a wrong type and an over-limit file, and nothing for a file of another shape", async () => {
  const fx = await storyVault();
  const png = tmpFile("shot.png", Buffer.from(FIXTURES.png));
  const name = await nameOf(FIXTURES.png);
  const r = await editWith(fx, `![shot](${UP}/${name})`, [png]);
  assert.equal(r.code, 0, r.out + r.err);
  writeFileSync(fx.at("attachments/0000000000000000.png"), Buffer.from(FIXTURES.png));
  writeFileSync(fx.at("attachments/0123456789abcdef.svg"), "<svg/>");
  writeFileSync(fx.at("attachments/1111111111111111.pdf"), Buffer.alloc(MAX_BYTES + 1));
  writeFileSync(fx.at("attachments/notes.txt"), "a note");
  const calls = [];
  const git = (cwd, args) => (calls.push(args), { kind: "answer", status: 1, stdout: Buffer.alloc(0) });
  assert.deepEqual(byCheck(checkAttachments(fsOf(fx), nodeIndexOf(fx), { git })), [
    "attachment-orphan attachments/0000000000000000.png",
    "attachment-orphan attachments/0123456789abcdef.svg",
    "attachment-orphan attachments/1111111111111111.pdf",
    "attachment-over-limit attachments/1111111111111111.pdf",
    "attachment-type attachments/0123456789abcdef.svg",
  ]);
  assert.equal(calls.length, 1, "one batched git run");
  assert.ok(!calls[0].includes("attachments/notes.txt"), "a file of another shape is no kept file");
  const all = runVaultChecks(fsOf(fx), { proj: fx.proj });
  assert.ok(byCheck(all).includes("attachment-type attachments/0123456789abcdef.svg"), "doctor --vault runs the check");
  for (const f of all.filter((x) => x.check === "attachment-orphan")) assert.equal(f.level, "info");
});

// [attachments#10]
test("attachments: with no attachments folder doctor says nothing and starts no git process (edge)", async () => {
  const fx = await storyVault();
  let called = false;
  const git = () => ((called = true), { kind: "answer", status: 1, stdout: Buffer.alloc(0) });
  assert.deepEqual(checkAttachments(fsOf(fx), nodeIndexOf(fx), { git }), []);
  assert.equal(called, false);
});

// [attachments#10]
test("attachments: a vault whose .gitignore lists the folder gives each kept file attachment-ignored (failure)", async () => {
  const fx = await storyVault();
  const init = spawnSync("git", ["init", "-q"], { cwd: fx.vault });
  assert.equal(init.status, 0, String(init.stderr));
  mkdirSync(fx.at("attachments"));
  writeFileSync(fx.at("attachments/0000000000000000.png"), Buffer.from(FIXTURES.png));
  writeFileSync(fx.at("attachments/2222222222222222.gif"), Buffer.from(FIXTURES.gif));
  writeFileSync(fx.at(".gitignore"), "attachments/\n");
  const ignored = checkAttachments(fsOf(fx), nodeIndexOf(fx)).filter((f) => f.check === "attachment-ignored");
  assert.deepEqual(
    ignored.map((f) => [f.file, f.level]),
    [
      ["attachments/0000000000000000.png", "warn"],
      ["attachments/2222222222222222.gif", "warn"],
    ],
  );
});
