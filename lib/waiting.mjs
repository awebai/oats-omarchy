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

// The deployment, the shim, and the rows the kernel says wait on you.
// → { ok: true, rows, shim, dep } | { ok: false, reason, status? } (status:
// the kernel's `oats status` itself failed, and `reason` is its message).
function readWaiting(args, env, statusTimeoutMs) {
  const dep = discover.deployment({ dir: args.dir });
  if (!dep.ok) return { ok: false, reason: dep.reason };
  let shim;
  try { shim = discover.paths(env).shim; } catch (e) { return { ok: false, reason: e.message }; }
  if (!isExecutableFile(shim)) return { ok: false, reason: `setup's shim ${shim} is missing: run setup --apply` };
  const r = run(shim, ["status", "--json"], { env, cwd: dep.path, timeoutMs: statusTimeoutMs });
  if (!r.ok) return { ok: false, status: true, reason: statusError(r) };
  try { return { ok: true, rows: waitingRows(r.stdout), shim, dep }; } catch (e) { return { ok: false, status: true, reason: e.message }; }
}

// --json: what was read, nothing opened. A failed read is the only unknown,
// and its reason is one bounded line (the kernel's first, when it failed).
function waitingJson(args, env, out, statusTimeoutMs) {
  const read = readWaiting(args, env, statusTimeoutMs);
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

// `statusTimeoutMs` is for tests.
export function waiting(argv, env = process.env, err = process.stderr, { statusTimeoutMs = STATUS_TIMEOUT, out = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err.write(`waiting: ${args.error}\n${USAGE}`); return 2; }
  if (args.json) return waitingJson(args, env, out, statusTimeoutMs);
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
