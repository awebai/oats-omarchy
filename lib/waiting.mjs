// `bin/waiting.mjs`: the "Waiting on you" row of the oats menu, and the bar
// widget's panel. It asks the kernel which instances wait on you, of one
// deployment or (--list) of every deployment in this computer's list, lets
// you pick one in Omarchy's own selector, and opens its session in Omarchy's
// floating terminal. The selector shows the count and the
// instance names only; with nothing to pick it is not opened, and an Omarchy
// notification says so. With --json it only prints what it read, for the bar
// widget, which shows that and derives nothing itself. The kernel is reached
// through the shim setup wrote, which holds the node and CLI it recorded, and
// read through lib/read.mjs, as the picker's reader (lib/agents.mjs) reads it.
//
// A row waits on you when the kernel's `waitingOnYou` is set. A null there
// makes no claim about that row: it does not say the row is not waiting, so
// nothing here ever says that nobody is waiting. Only a status that could not
// be read is unknown.
import { spawn } from "node:child_process";
import * as deployments from "./deployments.mjs";
import * as discover from "./discover.mjs";
import { assertSafePath, shellQuote } from "./quote.mjs";
import { emptyAnswer, firstLine, kernelRead, listOf, readEvery, readRoster, rosterOf, shimOf, STATUS_OUTPUT_LIMIT } from "./read.mjs";
import { failureText, run, which } from "./system.mjs";

export { listOf, STATUS_OUTPUT_LIMIT };

export const USAGE = `usage: waiting [--dir <deployment> | --list] [--json]

  Lists the agents waiting on you in Omarchy's menu, and opens the one you
  pick in a floating terminal: the agents of the deployment (--dir, else the
  one at or above the working directory), or with --list those of every
  deployment in this computer's list (\`oats deployments\`), read one after
  another. The oats menu's "Waiting on you" row runs it as setup wrote it.

  --json  print what was read, and open nothing (the bar widget's panel):
          {ok, count, rows: [{instance, home, waitingOnYou}]}, or {ok: false,
          reason}; waitingOnYou is the kernel's {since, producer, reason,
          message}, as given. With --list each row also names its deployment and
          workspace, and deployments: [{path, name, workspace, ok, reason?}]
          says how each read went; ok is false only when none was read.
`;

// The key that leaves `oats session attach`: Alt+O, OATS's leader key in the
// TUI and the Desktop. Passed only when the kernel lists the feature.
export const DETACH_KEY = "M-o";
export const DETACH_FEATURE = "session-attach-detach-key";
const STATUS_TIMEOUT = 30_000;
// --json answers before the bar widget's own 30 s deadline.
const JSON_STATUS_TIMEOUT = 25_000;
// --list reads one deployment after another, each within its own timeout,
// and all of them within this: it answers before the bar widget's deadline
// for a list read (120 s). A deployment not reached in time is not read.
export const LIST_BUDGET = 110_000;
const LIST_TIMEOUT = 25_000;
const SELECT_TIMEOUT = 30 * 60_000;

export function parseArgs(argv) {
  let dir = null;
  let json = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") { json = true; continue; }
    if (argv[i] === "--list") { list = true; continue; }
    if (argv[i] === "--dir") { dir = argv[++i]; if (!dir) return { error: "--dir needs a value" }; continue; }
    if (argv[i].startsWith("--dir=")) { dir = argv[i].slice("--dir=".length); if (!dir) return { error: "--dir needs a value" }; continue; }
    return { error: `unknown argument: ${argv[i]}` };
  }
  if (list && dir !== null) return { error: "--list reads every listed deployment: it takes no --dir" };
  return { dir, json, list };
}

// `oats status --json` → the instances waiting on you, in the order listed,
// each { instance, home, waitingOnYou } with the kernel's claim as given, and
// the deployment's workspace key (null when it has none). A kernel error
// envelope, or anything without an agents list, throws.
export function readStatus(stdout) {
  const { agents, workspace } = readRoster(stdout);
  return { rows: waitingOf(agents), workspace };
}

const waitingOf = (agents) => agents.flatMap((a) => a.instances)
  .filter((row) => row.waitingOnYou !== null)
  .map(({ instance, home, waitingOnYou }) => ({ instance, home, waitingOnYou }));

export const waitingRows = (stdout) => readStatus(stdout).rows;

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
  const prep = shimOf(env);
  return prep.ok ? { ok: true, dep, shim: prep.shim } : prep;
}

// `oats status --json`'s result → the rows the kernel says wait on you.
// → { ok: true, rows, workspace } | { ok: false, status: true, reason } (the
// kernel's `oats status` itself failed, and `reason` is its message).
function rowsOf(r) {
  const roster = rosterOf(r);
  return roster.ok ? { ok: true, rows: waitingOf(roster.agents), workspace: roster.workspace } : { ok: false, status: true, reason: roster.reason };
}

function readWaiting(args, env, statusTimeoutMs) {
  const prep = prepare(args, env);
  if (!prep.ok) return prep;
  const read = rowsOf(run(prep.shim, ["status", "--json"], { env, cwd: prep.dep.path, timeoutMs: statusTimeoutMs }));
  return read.ok ? { ...read, shim: prep.shim, dep: prep.dep } : read;
}

// --json: what was read, nothing opened. A failed read is the only unknown,
// and its reason is one bounded line (the kernel's first, when it failed).
// The kernel's read runs in a process group of its own (lib/read.mjs).
async function waitingJson(args, env, out, statusTimeoutMs, outputLimit) {
  const prep = prepare(args, env);
  const read = prep.ok ? rowsOf(await kernelRead(prep.shim, env, prep.dep.path, statusTimeoutMs, outputLimit)) : prep;
  const result = read.ok
    ? { ok: true, count: read.rows.length, rows: read.rows }
    : { ok: false, reason: firstLine(read.reason) };
  out.write(`${JSON.stringify(result)}\n`);
  return read.ok ? 0 : 1;
}

export function hasDetachKey(shim, env, cwd) {
  const r = run(shim, ["version", "--json"], { env, cwd, timeoutMs: 15_000 });
  try { return r.ok && hasDetachFeature(JSON.parse(r.stdout).features); } catch { return false; }
}

// ---------------------------------------------------------------------------
// --list: every deployment in this computer's list (lib/read.mjs readEvery).

// readEvery's answer → what --list says: { ok, count, rows, deployments,
// note? } or { ok: false, reason }. Only when no deployment was read is the
// whole unknown; a deployment that failed is unknown on its own.
export function listResult(every) {
  if (!every.ok) return { ok: false, reason: firstLine(every.reason) };
  const read = every.deployments.filter((d) => d.ok);
  const rows = read.flatMap((d) => waitingOf(d.agents).map((row) => ({ ...row, deployment: d.path, workspace: d.workspace })));
  const summary = every.deployments.map(({ agents: _, ...d }) => d);
  const empty = emptyAnswer(every);
  if (empty) return empty.ok ? { ok: true, count: 0, rows, deployments: summary, note: empty.note } : { ...empty, deployments: summary };
  return { ok: true, count: rows.length, rows, deployments: summary };
}

// The selector's text for each row: the instance, and the workspace when
// more than one deployment was read (the path when that is not enough).
export function labels(rows, many) {
  const first = rows.map((row) => (many ? `${row.instance} (${row.workspace || row.deployment})` : row.instance));
  return first.map((label, i) => (first.indexOf(label) !== first.lastIndexOf(label) ? `${rows[i].instance} (${rows[i].deployment})` : label));
}

async function listJson(env, out, statusTimeoutMs, outputLimit, budgetMs) {
  const prep = shimOf(env);
  const result = prep.ok
    ? listResult(await readEvery((args, cwd, ms) => kernelRead(prep.shim, env, cwd, ms, outputLimit, args), env.HOME, { perReadMs: statusTimeoutMs, budgetMs }))
    : { ok: false, reason: firstLine(prep.reason) };
  out.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

async function listMenu(env, say, notify, statusTimeoutMs, budgetMs) {
  const prep = shimOf(env);
  const every = prep.ok ? await readEvery((args, cwd, ms) => kernelRead(prep.shim, env, cwd, ms, STATUS_OUTPUT_LIMIT, args), env.HOME, { perReadMs: statusTimeoutMs, budgetMs }) : prep;
  const result = listResult(every);
  if (!result.ok) {
    say(result.reason);
    notify("Waiting on you (?)", result.reason);
    return 1;
  }
  const failed = result.deployments.filter((d) => !d.ok);
  for (const d of failed) say(`${d.name} (${d.path}) could not be read: ${d.reason}`);
  if (!result.rows.length) {
    notify("Waiting on you (0)", result.note || (failed.length ? firstLine(`Not read: ${failed.map((d) => d.name).join(", ")}`) : undefined));
    return 0;
  }
  const many = result.deployments.filter((d) => d.ok).length > 1;
  return pick(env, say, prep.shim, result.rows, labels(result.rows, many), (row) => row.deployment);
}

// The selector, then the chosen row's session in the floating terminal.
// `cwdOf(row)` is the deployment the attach runs in.
function pick(env, say, shim, rows, names, cwdOf) {
  const select = which("omarchy-menu-select", env.PATH);
  const launcher = which("omarchy-launch-floating-terminal-with-presentation", env.PATH);
  if (!select || !launcher) { say(`not on PATH: ${[!select && "omarchy-menu-select", !launcher && "omarchy-launch-floating-terminal-with-presentation"].filter(Boolean).join(", ")}`); return 1; }
  const choice = run(select, [`Waiting on you (${rows.length})`, ...names], { env, timeoutMs: SELECT_TIMEOUT });
  if (!choice.ok) return 0; // cancelled: nothing opens
  const name = choice.stdout.replace(/\n$/, "");
  const row = rows[names.indexOf(name)];
  if (!row) { say(`the menu returned ${JSON.stringify(name)}, which is not an instance waiting on you`); return 1; }

  let home;
  try { home = assertSafePath(`the home of ${row.instance}`, row.home); } catch (e) { say(e.message); return 1; }
  const cwd = cwdOf(row);
  const command = attachCommand({ shim, home, detachKey: hasDetachKey(shim, env, cwd) });
  // The terminal outlives this command: it is started on its own.
  spawn(launcher, [command], { env, cwd, detached: true, stdio: "ignore" }).unref();
  return 0;
}

// `statusTimeoutMs`, `statusOutputLimit` and `listBudgetMs` are for tests.
// → the exit code; with --json, a promise of it.
export function waiting(argv, env = process.env, err = process.stderr, { statusTimeoutMs, statusOutputLimit = STATUS_OUTPUT_LIMIT, listBudgetMs = LIST_BUDGET, out = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err.write(`waiting: ${args.error}\n${USAGE}`); return 2; }
  if (args.json && args.list) return listJson(env, out, statusTimeoutMs ?? LIST_TIMEOUT, statusOutputLimit, listBudgetMs);
  if (args.json) return waitingJson(args, env, out, statusTimeoutMs ?? JSON_STATUS_TIMEOUT, statusOutputLimit);
  statusTimeoutMs ??= STATUS_TIMEOUT;
  const say = (text) => err.write(`oats-omarchy: ${text}\n`);
  const notify = (headline, description) => {
    const bin = which(discover.NOTIFY, env.PATH);
    if (!bin) { say(`${headline}${description ? `: ${description}` : ""}`); return; }
    const r = run(bin, [headline, ...(description ? [description] : [])], { env, timeoutMs: 10_000 });
    if (!r.ok) say(`${discover.NOTIFY}: ${failureText(r)}`);
  };

  if (args.list) return listMenu(env, say, notify, statusTimeoutMs, listBudgetMs);
  const read = readWaiting(args, env, statusTimeoutMs);
  if (!read.ok) {
    say(read.status ? `oats status failed: ${read.reason}` : read.reason);
    notify("Waiting on you (?)", firstLine(read.reason));
    return 1;
  }
  const { rows, shim, dep } = read;
  if (!rows.length) { notify("Waiting on you (0)"); return 0; }
  return pick(env, say, shim, rows, rows.map((row) => row.instance), () => dep.path);
}

// The oats menu's "Status" row with the list (`bin/status.mjs`): the
// kernel's own `oats status` of each `ok` deployment, one after another, in
// the floating terminal it runs in. Each kernel runs in a process group this
// process ends with it, as the reads above. → a promise of the exit code: 1
// when the list could not be read or a status failed. `timeoutMs` is for tests.
export async function statusEvery(env = process.env, err = process.stderr, { timeoutMs = STATUS_TIMEOUT } = {}) {
  const prep = shimOf(env);
  if (!prep.ok) { err.write(`oats-omarchy: ${prep.reason}\n`); return 1; }
  const list = listOf(await kernelRead(prep.shim, env, env.HOME, timeoutMs, STATUS_OUTPUT_LIMIT, ["deployments", "--json"]));
  if (!list.ok) { err.write(`oats-omarchy: ${list.reason}\n`); return 1; }
  const ok = list.rows.filter((row) => row.state === "ok");
  if (!ok.length) { err.write(`oats-omarchy: this computer's list holds no deployment to read: ${deployments.HOW_TO_LIST}\n`); return 0; }
  let code = 0;
  for (const [i, d] of ok.entries()) {
    if (i) err.write("\n");
    const r = await kernelRead(prep.shim, env, d.path, timeoutMs, STATUS_OUTPUT_LIMIT, ["status", "--dir", d.path], { inherit: true });
    if (!r.ok) { code = 1; if (r.error) err.write(`oats-omarchy: oats status --dir ${d.path}: ${r.error}\n`); }
  }
  return code;
}
