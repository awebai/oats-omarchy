// `oats omarchy waiting`: the "Waiting on you" row of the oats menu. It asks
// the kernel which instances of this deployment wait on you, lets you pick
// one in Omarchy's own selector, and opens its session in Omarchy's floating
// terminal. The selector shows the count and the instance names only; with
// nothing to pick it is not opened, and an Omarchy notification says so.
import { spawn } from "node:child_process";
import * as discover from "./discover.mjs";
import { assertSafePath, shellQuote } from "./quote.mjs";
import { failureText, isExecutableFile, run, which } from "./system.mjs";

export const USAGE = `usage: oats omarchy waiting

  Lists the agents of this deployment that are waiting on you in Omarchy's
  menu, and opens the one you pick in a floating terminal. The oats menu's
  "Waiting on you" row runs it.
`;

// The key that leaves `oats session attach` (Ctrl and backslash), offered
// when the kernel has the feature.
export const DETACH_KEY = "C-\\";
const STATUS_TIMEOUT = 30_000;
const SELECT_TIMEOUT = 30 * 60_000;
const NOTE_LIMIT = 200;

export function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    // The kernel resolves --soul; it reaches the command as well.
    if (argv[i] === "--soul") { if (!argv[++i]) return { error: "--soul needs a value" }; continue; }
    if (argv[i].startsWith("--soul=")) continue;
    return { error: `unknown argument: ${argv[i]}` };
  }
  return {};
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

// The command the floating terminal runs (`bash -c`): the shim when it is
// there, else the kernel by its paths.
export function attachCommand({ shim, node, cli, home, detachKey }) {
  const oats = shim ? shellQuote(shim) : `${shellQuote(node)} ${shellQuote(cli)}`;
  return `${oats} session attach --home ${shellQuote(home)}${detachKey ? ` --detach-key ${shellQuote(DETACH_KEY)}` : ""}`;
}

function hasDetachKey(node, cli, env, cwd) {
  const r = run(node, [cli, "version", "--json"], { env, cwd, timeoutMs: 15_000 });
  try { return r.ok && JSON.parse(r.stdout).features?.includes("session-attach-detach-key") === true; } catch { return false; }
}

// `statusTimeoutMs` is for tests.
export function waiting(argv, env = process.env, err = process.stderr, { statusTimeoutMs = STATUS_TIMEOUT } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err.write(`oats omarchy waiting: ${args.error}\n${USAGE}`); return 2; }
  const say = (text) => err.write(`oats-omarchy: ${text}\n`);
  const notify = (headline, description) => {
    const bin = which(discover.NOTIFY, env.PATH);
    if (!bin) { say(`${headline}${description ? `: ${description}` : ""}`); return; }
    const r = run(bin, [headline, ...(description ? [description] : [])], { env, timeoutMs: 10_000 });
    if (!r.ok) say(`${discover.NOTIFY}: ${failureText(r)}`);
  };

  const dep = discover.deployment(env);
  if (!dep.ok) { say(dep.reason); notify("Waiting on you (?)", firstLine(dep.reason)); return 1; }
  const node = env.OATS_NODE_BIN;
  const cli = env.OATS_CLI_BIN;
  if (!node || !cli) { say("OATS_NODE_BIN and OATS_CLI_BIN are not set: run this as `oats omarchy waiting`"); notify("Waiting on you (?)", "OATS_NODE_BIN and OATS_CLI_BIN are not set"); return 1; }

  const r = run(node, [cli, "status", "--json"], { env, cwd: dep.path, timeoutMs: statusTimeoutMs });
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
  const shim = discover.paths(env).shim;
  const command = attachCommand({ shim: isExecutableFile(shim) ? shim : null, node, cli, home, detachKey: hasDetachKey(node, cli, env, dep.path) });
  // The terminal outlives this command: it is started on its own.
  spawn(launcher, [command], { env, cwd: dep.path, detached: true, stdio: "ignore" }).unref();
  return 0;
}
