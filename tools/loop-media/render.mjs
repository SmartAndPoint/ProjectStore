// Render the main page's loop from loop.html beside it: headless Chrome draws each frame at FPS through
// window.frame(t), img2webp joins the distinct ones into a lossless animated WebP, and cwebp writes the
// still, window.still, losslessly too.
//
//   node tools/loop-media/render.mjs
//
// It writes site/assets/loop.webp and loop-still.webp: one picture, in English, for both main pages (the
// maintainer's decision of 2026-10-22). Needs Google Chrome (or CHROME=<path>), and img2webp and cwebp from
// libwebp (brew install webp). Node 22 or later, for the global fetch and WebSocket.
//
// Each render adds a full copy of the files to the git history, so re-render only when the loop's words or
// drawing change, in the same change as those words (PS-HARNESS: "The front page speaks to a beginner …").
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(here, "../../site/assets");
const NAME = "loop";
// The page is drawn at 1280×720 CSS px; 1.5 makes the file 1920×1080, sharp on a high-density screen and
// when a phone opens it full size.
const WIDTH = 1280;
const HEIGHT = 720;
const SCALE = 1.5;
const FPS = 10;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const tool of ["img2webp", "cwebp"])
  if (spawnSync(tool, ["-version"]).error) throw new Error(`${tool} is not on PATH (brew install webp)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9333 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "loop-chrome-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "loop-frames-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--allow-file-access-from-files",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let target;
for (let i = 0; i < 50 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch {
    await sleep(200);
  }
}
if (!target) throw new Error("Chrome did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const { ok, ko } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) ko(new Error(msg.error.message));
  else ok(msg.result);
});
const cdp = (method, params = {}) =>
  new Promise((ok, ko) => {
    const id = ++seq;
    pending.set(id, { ok, ko });
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expr) =>
  (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const shot = async () =>
  Buffer.from(
    (
      await cdp("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
      })
    ).data,
    "base64",
  );
const run = (tool, args) => {
  const r = spawnSync(tool, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${tool} failed: ${r.stderr}`);
};

try {
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  await cdp("Page.navigate", { url: `file://${here}/loop.html` });
  for (let i = 0; i < 100 && !(await js("typeof window.frame === 'function' && !!window.ready")); i++) await sleep(100);
  await js("window.ready");
  const duration = await js("window.duration");

  // One PNG per distinct frame, with how long it shows.
  const frames = [];
  let last = null;
  for (let f = 0; f < Math.round(duration * FPS); f++) {
    await js(`window.frame(${f / FPS})`);
    const png = await shot();
    if (!last || !png.equals(last)) {
      const file = path.join(work, `${NAME}-${String(frames.length).padStart(4, "0")}.png`);
      fs.writeFileSync(file, png);
      frames.push({ file, ms: 0 });
      last = png;
    }
    frames[frames.length - 1].ms += Math.round(1000 / FPS);
  }
  const anim = path.join(OUT, `${NAME}.webp`);
  run("img2webp", [
    "-loop",
    "0",
    "-lossless",
    "-m",
    "4",
    "-min_size",
    ...frames.flatMap((f) => ["-d", String(f.ms), f.file]),
    "-o",
    anim,
  ]);

  await js("window.frame(window.still)");
  const raw = path.join(work, `${NAME}-still.png`);
  fs.writeFileSync(raw, await shot());
  const still = path.join(OUT, `${NAME}-still.webp`);
  run("cwebp", ["-quiet", "-lossless", "-z", "9", raw, "-o", still]);
  console.log(
    `${NAME}: ${WIDTH * SCALE}×${HEIGHT * SCALE}, ${frames.length} frames,`,
    `${fs.statSync(anim).size} B; still ${fs.statSync(still).size} B`,
  );
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  for (const dir of [profile, work]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold its profile for a moment */
    }
  }
}
