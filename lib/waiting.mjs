// `bin/waiting.mjs`: the "Waiting on you" row of the oats menu. It asks the
// kernel which instances of the deployment wait on you, lets you pick one in
// Omarchy's own selector, and opens its session in Omarchy's floating
// terminal. The selector shows the count and the instance names only; with
// nothing to pick it is not opened, and an Omarchy notification says so. The
// kernel is reached through the shim setup wrote, which holds the node and
// CLI it recorded.
import { spawn } from "node:child_process";
import * as discover from "./discover.mjs";
import { assertSafePath, shellQuote } from "./quote.mjs";
import { failureText, isExecutableFile, run, which } from "./system.mjs";

export const USAGE = `usage: waiting [--dir <deployment>]

  Lists the agents of the deployment that are waiting on you in Omarchy's
  menu, and opens the one you pick in a floating terminal. The oats menu's
  "Waiting on you" row runs it, with the deployment setup is applied for.
`;

// The key that leaves `oats session attach` (Ctrl and backslash), offered
// when the kernel has the feature.
export const DETACH_KEY = "C-\\";
const STATUS_TIMEOUT = 30_000;
const SELECT_TIMEOUT = 30 * 60_000;
const NOTE_LIMIT = 200;

export function parseArgs(argv) {
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") { dir = argv[++i]; if (!dir) return { error: "--dir needs a value" }; continue; }
    if (argv[i].startsWith("--dir=")) { dir = argv[i].slice("--dir=".length); if (!dir) return { error: "--dir needs a value" }; continue; }
    return { error: `unknown argument: ${argv[i]}` };
  }
  return { dir };
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

// The command the floating terminal runs (`bash -c`).
export function attachCommand({ shim, home, detachKey }) {
  return `${shellQuote(shim)} session attach --home ${shellQuote(home)}${detachKey ? ` --detach-key ${shellQuote(DETACH_KEY)}` : ""}`;
}

function hasDetachKey(shim, env, cwd) {
  const r = run(shim, ["version", "--json"], { env, cwd, timeoutMs: 15_000 });
  try { return r.ok && JSON.parse(r.stdout).features?.includes("session-attach-detach-key") === true; } catch { return false; }
}

// `statusTimeoutMs` is for tests.
export function waiting(argv, env = process.env, err = process.stderr, { statusTimeoutMs = STATUS_TIMEOUT } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err.write(`waiting: ${args.error}\n${USAGE}`); return 2; }
  const say = (text) => err.write(`oats-omarchy: ${text}\n`);
  const notify = (headline, description) => {
    const bin = which(discover.NOTIFY, env.PATH);
    if (!bin) { say(`${headline}${description ? `: ${description}` : ""}`); return; }
    const r = run(bin, [headline, ...(description ? [description] : [])], { env, timeoutMs: 10_000 });
    if (!r.ok) say(`${discover.NOTIFY}: ${failureText(r)}`);
  };

  const dep = discover.deployment({ dir: args.dir });
  if (!dep.ok) { say(dep.reason); notify("Waiting on you (?)", firstLine(dep.reason)); return 1; }
  let shim;
  try { shim = discover.paths(env).shim; } catch (e) { say(e.message); return 1; }
  if (!isExecutableFile(shim)) {
    const reason = `setup's shim ${shim} is missing: run setup --apply`;
    say(reason); notify("Waiting on you (?)", firstLine(reason)); return 1;
  }

  const r = run(shim, ["status", "--json"], { env, cwd: dep.path, timeoutMs: statusTimeoutMs });
  let rows;
  let error = r.ok ? null : statusError(r);
  if (!error) { try { rows = waitingRows(r.stdout); } catch (e) { error = e.message; } }
  if (error) {
    say(`oats status failed: ${error}`);
    notify("Waiting on you (?)", firstLine(error));
    return 1;
  }
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
