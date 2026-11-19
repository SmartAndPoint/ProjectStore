// projectstore — tests/fixtures/dashboard-stub-server.mjs: a stand-in for
// dashboard/server.mjs, for the launcher's tests (tests/dashboard-verb.test.mjs).
// It takes the launcher's arguments, listens on 127.0.0.1, prints the one ready
// line, answers "stub", and stops on SIGINT, SIGTERM or the end of stdin when
// --watch-stdin is given. It writes its arguments to $STUB_MARKER when that is
// set, so a test can see whether it was started and with what.
//
//   STUB_MODE=version  says the versions differ on stderr and exits 1
//   STUB_MODE=silent   prints nothing and waits (the start timeout)
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
if (process.env.STUB_MARKER) writeFileSync(process.env.STUB_MARKER, JSON.stringify(argv));
if (process.env.STUB_MODE === "version") {
  process.stderr.write("the core is 9.9.9 and the dashboard is 0.0.1: they must be the same version\n");
  process.exit(1);
}
if (process.env.STUB_MODE === "silent") setInterval(() => {}, 1000);
else {
  // The test names a port; a range is listened on as port 0, so a test never
  // takes the launcher's own range on a machine where a real page runs.
  const port = arg("--port") !== null ? Number(arg("--port")) : 0;
  const server = createServer((req, res) => res.end("stub"));
  const stop = () => server.close(() => process.exit(0));
  server.on("error", (e) => {
    process.stderr.write(e.code === "EADDRINUSE" ? `port ${port} is in use\n` : `${e.message}\n`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const p = server.address().port;
    process.stdout.write(
      JSON.stringify({ ready: true, url: `http://127.0.0.1:${p}/`, port: p, vault: arg("--project") }) + "\n",
    );
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (argv.includes("--watch-stdin")) {
    process.stdin.on("end", stop);
    process.stdin.resume();
  }
}
