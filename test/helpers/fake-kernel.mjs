// A stand-in for the OATS CLI behind setup's shim, for `omarchy-launch-oats`
// (test/launch.test.mjs, test/steward.test.mjs): every call it gets is logged
// (argv, working directory, and the bytes `session input` read on stdin),
// and each command answers as a test sets it, with the real CLI's shapes:
// its JSON envelope ({schemaVersion, ok, result} or {ok: false, error:
// {code, message}}), `E_SESSION_RUNNING` with the kernel's own message, and
// a hang with a child of its own (lesson: a fake that hangs must have a
// child), both pids logged. It never starts or attaches to anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeExecutable } from "./sandbox.mjs";

export const ALL_FEATURES = ["deployments-list", "session-attach-detach-key", "session-inspect-running", "waiting-on-you"];

// The CLI. <k> is its directory; a test writes there:
//   version.json            `version --json` (else 0.67.1 with ALL_FEATURES)
//   deployments.json        `deployments --json`'s result (else none)
//   <cmd>.mode              for version, deployments, start, inspect, input:
//                           "hang", "stderr" (exit 1, a line on stderr) or
//                           "envelope:<CODE>" (exit 1, the kernel's error
//                           envelope); start also "running" (E_SESSION_RUNNING)
//   <cwd>/status.json       `status --json` run there (else no agents), and
//   <cwd>/status.mode       its mode, as above
//   inspect.json            `session inspect`'s results, one per call, the
//                           last repeated (else running, not waiting on you)
//   inspect.modes           `session inspect`'s modes, one per call, the last
//                           repeated ("" answers), in place of inspect.mode
//   inspect.delay           ms each `session inspect` takes to answer
//   input.json              `session input`'s result (else submitted, verified)
//   attach.status           `session attach`'s exit status (else 0), or
//   attach.signal           a signal it kills itself with
// It logs to calls.log (a JSON line per call: {argv, cwd, stdin?}), and a
// hang's two pids to <cmd>.pids.
const cli = (k) => `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const K = ${JSON.stringify(k)};
const argv = process.argv.slice(2);
const file = (name) => { try { return readFileSync(name.startsWith("/") ? name : K + "/" + name, "utf8"); } catch { return null; } };
const sub = argv[0] === "session" ? argv[1] : argv[0];
const entry = { argv, cwd: process.cwd() };
if (sub === "input") entry.stdin = readFileSync(0).toString("base64");
appendFileSync(K + "/calls.log", JSON.stringify(entry) + "\\n");
const ok = (result) => { console.log(JSON.stringify({ schemaVersion: 1, ok: true, result })); process.exit(0); };
const fail = (code, message) => { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } })); process.exit(1); };
const home = argv[argv.indexOf("--home") + 1];
async function mode(m, cmd) {
  m = (m || "").trim();
  if (m === "hang") {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    appendFileSync(K + "/" + cmd + ".pids", process.pid + " " + child.pid + "\\n");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (m === "stderr") { console.error("node:internal/modules/cjs/loader: Cannot find module '/gone/oats.mjs'"); process.exit(1); }
  if (m.startsWith("envelope:")) fail(m.slice("envelope:".length), "the kernel refused " + cmd + " (" + m.slice("envelope:".length) + ")");
  return m;
}
const version = JSON.parse(file("version.json") || JSON.stringify({ schemaVersion: 1, name: "@awebai/oats", version: "0.67.1", features: ${JSON.stringify(ALL_FEATURES)} }));
if (argv.join(" ") === "--version") { console.log("@awebai/oats " + version.version + " (desktop API v1)"); process.exit(0); }
if (argv.join(" ") === "version --json") { await mode(file("version.mode"), "version"); console.log(JSON.stringify(version)); process.exit(0); }
if (argv.join(" ") === "deployments --json") {
  if (!version.features?.includes("deployments-list")) fail("E_UNKNOWN_COMMAND", "unknown command: deployments");
  await mode(file("deployments.mode"), "deployments");
  ok(JSON.parse(file("deployments.json") || JSON.stringify({ deploymentsApi: 1, file: "/h/.oats/config/deployments.json", deployments: [], imports: {} })));
}
if (argv.join(" ") === "status --json") {
  await mode(file(process.cwd() + "/status.mode"), "status");
  process.stdout.write(file(process.cwd() + "/status.json") || JSON.stringify({ root: process.cwd() + "/agents", agents: [] }));
  process.exit(0);
}
if (argv[0] === "session" && sub === "start" && argv.includes("--json")) {
  if (await mode(file("start.mode"), "start") === "running") fail("E_SESSION_RUNNING", home.split("/").pop() + " is running (unknown); nothing was started");
  ok({ home, started: true });
}
if (argv[0] === "session" && sub === "inspect" && argv.includes("--json")) {
  const n = Number(file("inspect.n") || 0);
  writeFileSync(K + "/inspect.n", String(n + 1));
  const modes = JSON.parse(file("inspect.modes") || "null");
  await mode(Array.isArray(modes) ? modes[Math.min(n, modes.length - 1)] : file("inspect.mode"), "inspect");
  const delay = Number(file("inspect.delay") || 0);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const seq = JSON.parse(file("inspect.json") || "null");
  const given = Array.isArray(seq) ? seq[Math.min(n, seq.length - 1)] : {};
  ok({ home, backend: "tmux", present: true, state: "unknown", running: true, waitingOnYou: null, ...given });
}
if (argv[0] === "session" && sub === "input" && argv.includes("--json")) {
  await mode(file("input.mode"), "input");
  ok({ home, backend: "tmux", present: true, state: "unknown", submitted: true, verified: true, ...JSON.parse(file("input.json") || "{}") });
}
if (argv[0] === "session" && sub === "attach") {
  const signal = (file("attach.signal") || "").trim();
  if (signal) process.kill(process.pid, signal);
  process.exit(Number(file("attach.status") || 0));
}
console.error("fake kernel: " + argv.join(" ")); process.exit(2);
`;

// Writes the CLI and setup's shim to it (discover.paths(env).shim, under
// XDG_DATA_HOME). → { k, shim, calls(), stdinOf(i) }.
export function fakeKernel(s) {
  const k = join(s.root, "fake-kernel");
  writeExecutable(join(k, "oats.mjs"), cli(k));
  const shim = join(s.env.XDG_DATA_HOME, "oats-omarchy", "oats");
  writeExecutable(shim, `#!/bin/sh\nexec '${process.execPath}' '${join(k, "oats.mjs")}' "$@"\n`);
  const calls = () => {
    let text = "";
    try { text = readFileSync(join(k, "calls.log"), "utf8"); } catch { /* none yet */ }
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  return { k, shim, calls };
}

// Whether every pid has exited within `ms`.
export async function gone(pids, ms = 5000) {
  const dead = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const end = Date.now() + ms;
  while (!pids.every(dead) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return pids.every(dead);
}
