// `bin/waiting.mjs`: the "Waiting on you" row of the oats menu, and the bar
// widget's count. It asks the kernel which instances of the deployment wait
// on you, lets you pick one in Omarchy's own selector, and opens its session
// in Omarchy's floating terminal. The selector shows the count and the
// instance names only; with nothing to pick it is not opened, and an Omarchy
// notification says so. With --json it only prints what it read, for the bar
// widget, which shows that and derives nothing itself. The kernel is reached
// through the shim setup wrote, which holds the node and CLI it recorded.
//
// A row waits on you when the kernel's `waitingOnYou` is set. A null there
// makes no claim about that row: it does not say the row is not waiting, so
// nothing here ever says that nobody is waiting. Only a status that could not
// be read is unknown.
import { spawn } from "node:child_process";
import * as discover from "./discover.mjs";
import { assertSafePath, shellQuote } from "./quote.mjs";
import { failureText, isExecutableFile, run, which } from "./system.mjs";

export const USAGE = `usage: waiting [--dir <deployment>] [--json]

  Lists the agents of the deployment that are waiting on you in Omarchy's
  menu, and opens the one you pick in a floating terminal. The oats menu's
  "Waiting on you" row runs it, with the deployment setup is applied for.

  --json  print {ok, count, rows: [{instance, home}]}, or {ok: false,
          reason}, and open nothing (the bar widget's count and panel)
`;

// The key that leaves `oats session attach`: Alt+O, OATS's leader key in the
// TUI and the Desktop. Passed only when the kernel lists the feature.
export const DETACH_KEY = "M-o";
export const DETACH_FEATURE = "session-attach-detach-key";
const STATUS_TIMEOUT = 30_000;
// --json answers before the bar widget's own 30 s deadline.
const JSON_STATUS_TIMEOUT = 25_000;
const SELECT_TIMEOUT = 30 * 60_000;
const NOTE_LIMIT = 200;

export function parseArgs(argv) {
  let dir = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") { json = true; continue; }
    if (argv[i] === "--dir") { dir = argv[++i]; if (!dir) return { error: "--dir needs a value" }; continue; }
    if (argv[i].startsWith("--dir=")) { dir = argv[i].slice("--dir=".length); if (!dir) return { error: "--dir needs a value" }; continue; }
    return { error: `unknown argument: ${argv[i]}` };
  }
  return { dir, json };
}

// `oats status --json` → the instances waiting on you, in the order listed.
// A kernel error envelope, or anything without an agents list, throws.
export function waitingRows(stdout) {
  const status = JSON.parse(stdout);
  if (status?.ok === false) throw new Error(status.error?.message || "oats status reported an error");
  if (!Array.isArray(status?.agents)) throw new Error("oats status --json has no agents list");
  return status.agents
    .flatMap((agent) => (Array.isArray(agent?.instances) ? agent.instances : []))
    .filter((row) => row && row.waitingOnYou != null && typeof row.instance === "string" && row.instance)
    .map((row) => ({ instance: row.instance, home: row.home }));
}

// The kernel's own message for a failed `oats status`.
function statusError(r) {
  try { const out = JSON.parse(r.stdout); if (out?.ok === false && out.error?.message) return out.error.message; } catch { /* not an envelope */ }
  return r.error || (r.stderr || r.stdout).trim() || `exit ${r.status}`;
}

const firstLine = (text) => {
  const line = String(text).split("\n").find((l) => l.trim()) || "";
  return line.length > NOTE_LIMIT ? `${line.slice(0, NOTE_LIMIT - 1)}…` : line;
};

// `oats session attach` up to the home, which comes last: the menu's and the
// bar widget's (setup records it for the widget) are the same argv.
export const attachPrefix = ({ shim, detachKey }) =>
  [shim, "session", "attach", ...(detachKey ? ["--detach-key", DETACH_KEY] : []), "--home"];

// The command the floating terminal runs (`bash -c`).
export const attachCommand = ({ shim, home, detachKey }) =>
  [...attachPrefix({ shim, detachKey }), home].map(shellQuote).join(" ");

export const hasDetachFeature = (features) => Array.isArray(features) && features.includes(DETACH_FEATURE);

// The deployment and the shim. → { ok: true, dep, shim } | { ok: false, reason }.
function prepare(args, env) {
  const dep = discover.deployment({ dir: args.dir });
  if (!dep.ok) return { ok: false, reason: dep.reason };
  let shim;
  try { shim = discover.paths(env).shim; } catch (e) { return { ok: false, reason: e.message }; }
  if (!isExecutableFile(shim)) return { ok: false, reason: `setup's shim ${shim} is missing: run setup --apply` };
  return { ok: true, dep, shim };
}

// `oats status --json`'s result → the rows the kernel says wait on you.
// → { ok: true, rows } | { ok: false, status: true, reason } (the kernel's
// `oats status` itself failed, and `reason` is its message).
function rowsOf(r) {
  if (!r.ok) return { ok: false, status: true, reason: statusError(r) };
  try { return { ok: true, rows: waitingRows(r.stdout) }; } catch (e) { return { ok: false, status: true, reason: e.message }; }
}

function readWaiting(args, env, statusTimeoutMs) {
  const prep = prepare(args, env);
  if (!prep.ok) return prep;
  const read = rowsOf(run(prep.shim, ["status", "--json"], { env, cwd: prep.dep.path, timeoutMs: statusTimeoutMs }));
  return read.ok ? { ...read, shim: prep.shim, dep: prep.dep } : read;
}

// `oats status --json` for --json, in a process group of its own that this
// process ends with it: on the read's own timeout, and when this process is
// told to stop (the bar widget stops it at its deadline, on a reload or a
// disable), so no kernel process outlives the read. → a promise of what
// run() returns.
const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
// As run() bounds a command's output: more than this ends the read.
export const STATUS_OUTPUT_LIMIT = 8 * 1024 * 1024;
function statusRead(shim, env, cwd, timeoutMs, limit = STATUS_OUTPUT_LIMIT) {
  return new Promise((resolve) => {
    const child = spawn(shim, ["status", "--json"], { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let error = null;
    const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const collect = (into) => (b) => {
      if (error) return;
      bytes += b.length;
      if (bytes > limit) { error = `oats status printed more than ${limit} bytes`; killGroup(); return; }
      into.push(b);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const stop = (signal) => { killGroup(); process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15)); };
    for (const signal of STOP_SIGNALS) process.on(signal, stop);
    const timer = setTimeout(() => { error ??= `timed out after ${timeoutMs} ms`; killGroup(); }, timeoutMs);
    const settle = (status, spawnError) => {
      clearTimeout(timer);
      for (const signal of STOP_SIGNALS) process.off(signal, stop);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      const e = error || (spawnError ? spawnError.message : null);
      resolve({ ok: !e && status === 0, status, stdout: out, stderr: err, error: e });
    };
    child.on("error", (e) => settle(null, e));
    child.on("close", (status) => settle(status, null));
  });
}

// --json: what was read, nothing opened. A failed read is the only unknown,
// and its reason is one bounded line (the kernel's first, when it failed).
async function waitingJson(args, env, out, statusTimeoutMs, outputLimit) {
  const prep = prepare(args, env);
  const read = prep.ok ? rowsOf(await statusRead(prep.shim, env, prep.dep.path, statusTimeoutMs, outputLimit)) : prep;
  const result = read.ok
    ? { ok: true, count: read.rows.length, rows: read.rows }
    : { ok: false, reason: firstLine(read.reason) };
  out.write(`${JSON.stringify(result)}\n`);
  return read.ok ? 0 : 1;
}

function hasDetachKey(shim, env, cwd) {
  const r = run(shim, ["version", "--json"], { env, cwd, timeoutMs: 15_000 });
  try { return r.ok && hasDetachFeature(JSON.parse(r.stdout).features); } catch { return false; }
}

// `statusTimeoutMs` and `statusOutputLimit` are for tests.
// → the exit code; with --json, a promise of it.
export function waiting(argv, env = process.env, err = process.stderr, { statusTimeoutMs, statusOutputLimit = STATUS_OUTPUT_LIMIT, out = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err.write(`waiting: ${args.error}\n${USAGE}`); return 2; }
  if (args.json) return waitingJson(args, env, out, statusTimeoutMs ?? JSON_STATUS_TIMEOUT, statusOutputLimit);
  statusTimeoutMs ??= STATUS_TIMEOUT;
  const say = (text) => err.write(`oats-omarchy: ${text}\n`);
  const notify = (headline, description) => {
    const bin = which(discover.NOTIFY, env.PATH);
    if (!bin) { say(`${headline}${description ? `: ${description}` : ""}`); return; }
    const r = run(bin, [headline, ...(description ? [description] : [])], { env, timeoutMs: 10_000 });
    if (!r.ok) say(`${discover.NOTIFY}: ${failureText(r)}`);
  };

  const read = readWaiting(args, env, statusTimeoutMs);
  if (!read.ok) {
    say(read.status ? `oats status failed: ${read.reason}` : read.reason);
    notify("Waiting on you (?)", firstLine(read.reason));
    return 1;
  }
  const { rows, shim, dep } = read;
  if (!rows.length) { notify("Waiting on you (0)"); return 0; }

  const select = which("omarchy-menu-select", env.PATH);
  const launcher = which("omarchy-launch-floating-terminal-with-presentation", env.PATH);
  if (!select || !launcher) { say(`not on PATH: ${[!select && "omarchy-menu-select", !launcher && "omarchy-launch-floating-terminal-with-presentation"].filter(Boolean).join(", ")}`); return 1; }
  const choice = run(select, [`Waiting on you (${rows.length})`, ...rows.map((row) => row.instance)], { env, timeoutMs: SELECT_TIMEOUT });
  if (!choice.ok) return 0; // cancelled: nothing opens
  const name = choice.stdout.replace(/\n$/, "");
  const row = rows.find((x) => x.instance === name);
  if (!row) { say(`the menu returned ${JSON.stringify(name)}, which is not an instance waiting on you`); return 1; }

  let home;
  try { home = assertSafePath(`the home of ${row.instance}`, row.home); } catch (e) { say(e.message); return 1; }
  const command = attachCommand({ shim, home, detachKey: hasDetachKey(shim, env, dep.path) });
  // The terminal outlives this command: it is started on its own.
  spawn(launcher, [command], { env, cwd: dep.path, detached: true, stdio: "ignore" }).unref();
  return 0;
}
