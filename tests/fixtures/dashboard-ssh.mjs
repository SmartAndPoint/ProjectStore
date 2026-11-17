// projectstore — test fixture: a stub ssh command for the dashboard's write
// module (the spec with alias `dashboard-writes`, "Testing": the ssh case).
//
//   node dashboard-ssh.mjs <report.json> <serve|hang> [git's ssh arguments…]
//
// Set as the vault repository's `core.sshCommand` over an `ssh://` origin. It
// reports on its own process to <report.json>: whether its stdin is a
// terminal, whether it can open /dev/tty, its pid, its process group, and the
// prompt variables of its environment. `serve` then answers git from the
// local repository the command names (`git-upload-pack '<path>'`); `hang`
// starts a child in the same process group and waits for ever, for the
// budget cases. That child outlives a SIGTERM by 300 ms, as a slow ssh
// would: a call must not settle while it is still alive (on Linux the git
// call's exit and its pipes' end came first, and a run settled early). Asked `-G` (git's probe for an OpenSSH), it exits 1, so git
// speaks the simple variant to it.
import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";

const [report, mode, ...args] = process.argv.slice(2);
if (args.includes("-G")) process.exit(1);

const pgidOf = (pid) => {
  try {
    return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
};
let tty;
try {
  closeSync(openSync("/dev/tty", "r"));
  tty = "opened";
} catch (e) {
  tty = e.code || String(e);
}
const facts = {
  stdinTTY: isatty(0),
  tty,
  pid: process.pid,
  pgid: pgidOf(process.pid),
  env: Object.fromEntries(
    ["GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "SSH_ASKPASS_REQUIRE", "GIT_SSH_COMMAND"].map((k) => [
      k,
      process.env[k] ?? null,
    ]),
  ),
  args,
};

if (mode === "hang") {
  const slow = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1 << 30)";
  const child = spawn(process.execPath, ["-e", slow], { stdio: "ignore" });
  facts.grandchild = child.pid;
  writeFileSync(report, JSON.stringify(facts));
  setInterval(() => {}, 1 << 30);
} else {
  writeFileSync(report, JSON.stringify(facts));
  const command = args[args.length - 1] || "";
  const m = command.match(/^git[- ](upload-pack|receive-pack) '(.*)'$/);
  if (!m) {
    process.stderr.write(`stub ssh: cannot serve ${JSON.stringify(command)}\n`);
    process.exit(128);
  }
  const child = spawn("git", [m[1], m[2]], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}
