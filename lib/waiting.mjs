// `bin/waiting.mjs`: the "Waiting on you" selector of the oats menu (when the
// waiting popup cannot open), and the read of the bar widget's panel and the
// popup. It asks the kernel which instances wait on you, of one
// deployment or (--list) of every deployment in this computer's list, lets
// you pick one in Omarchy's own selector, and opens its session in Omarchy's
// floating terminal. The selector shows the count and the
// instance names only; with nothing to pick it is not opened, and an Omarchy
// notification says so. With --json it only prints what it read, for the bar
// widget and the popup, which show that and derive nothing themselves. The kernel is reached
// through the shim setup wrote, which holds the node and CLI it recorded.
//
// A row waits on you when the kernel's `waitingOnYou` is set. A null there
// makes no claim about that row: it does not say the row is not waiting, so
// nothing here ever says that nobody is waiting. Only a status that could not
// be read is unknown.
import { spawn } from "node:child_process";
import * as deployments from "./deployments.mjs";
import * as discover from "./discover.mjs";
import { assertSafePath, shellQuote } from "./quote.mjs";
import { isStewardAgent } from "./steward-agent.mjs";
import { failureText, isExecutableFile, run, which } from "./system.mjs";

export const USAGE = `usage: waiting [--dir <deployment> | --list] [--json]

  Lists the agents waiting on you in Omarchy's menu, and opens the one you
  pick in a floating terminal: the agents of the deployment (--dir, else the
  one at or above the working directory), or with --list those of every
  deployment in this computer's list (\`oats deployments\`), read one after
  another. The oats menu's "Waiting on you" row runs it as setup wrote it.

  --json  print what was read, and open nothing (the bar widget's panel and
          the waiting popup): {ok, count, rows: [{instance, home,
          waitingOnYou, steward}]}, or {ok: false, reason}; waitingOnYou is the
          kernel's {since, producer, reason, message}, as given, and steward
          is true for this machine's steward. With --list each row also names its deployment and
          workspace, and deployments: [{path, name, workspace, ok, reason?}]
          says how each read went; ok is false only when none was read.
`;

// The key that leaves `oats session attach`: Ctrl+\\, the kernel's suggested
// one, the same for the panel, the popup and `omarchy-launch-oats`
// (lib/launch.mjs). Passed only when the kernel lists the feature.
export const DETACH_KEY = "C-\\";
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
const NOTE_LIMIT = 200;

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
// each { instance, home, waitingOnYou, steward } with the kernel's claim's
// four fields as given (null when the claim is not an object), `steward`
// true for an instance of the steward's agent (isStewardAgent), and the deployment's
// workspace key (null when it has none). A kernel error envelope, or
// anything without an agents list, throws.
export function readStatus(stdout) {
  const status = JSON.parse(stdout);
  if (status?.ok === false) throw new Error(status.error?.message || "oats status reported an error");
  if (!Array.isArray(status?.agents)) throw new Error("oats status --json has no agents list");
  const rows = status.agents
    .flatMap((agent) => (Array.isArray(agent?.instances) ? agent.instances.map((row) => ({ row, steward: isStewardAgent(agent) })) : []))
    .filter(({ row }) => row && row.waitingOnYou != null && typeof row.instance === "string" && row.instance)
    .map(({ row, steward }) => ({ instance: row.instance, home: row.home, waitingOnYou: claim(row.waitingOnYou), steward }));
  const key = status.workspace?.key;
  return { rows, workspace: typeof key === "string" && key ? key : null };
}

export const waitingRows = (stdout) => readStatus(stdout).rows;

// A `waitingOnYou`'s since, producer, reason and message, each a string or
// null, as the kernel gave them; null when it is not an object.
function claim(w) {
  if (w === null || typeof w !== "object") return null;
  const field = (v) => (typeof v === "string" ? v : null);
  return { since: field(w.since), producer: field(w.producer), reason: field(w.reason), message: field(w.message) };
}

// The kernel's own message for a failed command.
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
// → { ok: true, rows, workspace } | { ok: false, status: true, reason } (the
// kernel's `oats status` itself failed, and `reason` is its message).
function rowsOf(r) {
  if (!r.ok) return { ok: false, status: true, reason: statusError(r) };
  try { return { ok: true, ...readStatus(r.stdout) }; } catch (e) { return { ok: false, status: true, reason: e.message }; }
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
// disable), so no kernel process outlives the read. Every --list read runs
// here too, the menu's and the Status row's included; with `inherit` the
// kernel writes to this process's own output (the Status row's terminal)
// and nothing is collected. `input`, when given, is written to the
// kernel's stdin, which is otherwise closed. `omarchy-launch-oats` runs
// every kernel call of its own here too (lib/launch.mjs, lib/steward.mjs).
// → a promise of what run() returns.
const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
// As run() bounds a command's output: more than this ends the read.
export const STATUS_OUTPUT_LIMIT = 8 * 1024 * 1024;
export function statusRead(shim, env, cwd, timeoutMs, limit = STATUS_OUTPUT_LIMIT, args = ["status", "--json"], { inherit = false, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(shim, args, { env, cwd, detached: true, stdio: [input === undefined ? "ignore" : "pipe", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"] });
    if (input !== undefined) {
      // A kernel that exits before reading it all is answered by its status.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let error = null;
    const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const collect = (into) => (b) => {
      if (error) return;
      bytes += b.length;
      if (bytes > limit) { error = `oats ${args[0]} printed more than ${limit} bytes`; killGroup(); return; }
      into.push(b);
    };
    if (!inherit) {
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
    }
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

// ---------------------------------------------------------------------------
// --list: every deployment in this computer's list.

// setup's shim, for --list. → { ok: true, shim } | { ok: false, reason }.
function listShim(env) {
  let shim;
  try { shim = discover.paths(env).shim; } catch (e) { return { ok: false, reason: e.message }; }
  if (!isExecutableFile(shim)) return { ok: false, reason: `setup's shim ${shim} is missing: run setup --apply` };
  return { ok: true, shim };
}

// `oats deployments --json`'s result → parseList's answer. A CLI without
// the list says so in words a person can act on.
export function listOf(r) {
  if (r.ok) return deployments.parseList(r.stdout);
  let code = null;
  try { code = JSON.parse(r.stdout)?.error?.code; } catch { /* not an envelope */ }
  if (code === "E_UNKNOWN_COMMAND") return { ok: false, reason: `this OATS CLI keeps no list of deployments (it lacks the feature ${deployments.FEATURE}): update it, or run setup --apply again` };
  return { ok: false, reason: statusError(r) };
}

// The list, then each `ok` deployment's `oats status --json --dir <path>`,
// one after another, never two at once. `read(args, cwd, timeoutMs)` runs
// the kernel (a promise or not). Each read has `perReadMs`, and all of them
// `budgetMs`; a deployment not reached by then is not read.
// → { ok: false, reason } when the list could not be read, else
// { ok: true, deployments: [{ path, name, workspace, ok, rows | reason }] }.
export async function readEvery(read, home, { perReadMs, budgetMs }) {
  const start = Date.now();
  const left = () => budgetMs - (Date.now() - start);
  const list = listOf(await read(["deployments", "--json"], home, Math.min(perReadMs, left())));
  if (!list.ok) return list;
  const out = [];
  for (const d of list.rows.filter((row) => row.state === "ok")) {
    const base = { path: d.path, name: d.name };
    const ms = Math.min(perReadMs, left());
    if (ms <= 0) { out.push({ ...base, workspace: null, ok: false, reason: `not read: the ${Math.round(budgetMs / 1000)} s for every deployment ran out` }); continue; }
    const r = rowsOf(await read(["status", "--json", "--dir", d.path], d.path, ms));
    out.push(r.ok ? { ...base, workspace: r.workspace, ok: true, rows: r.rows } : { ...base, workspace: null, ok: false, reason: firstLine(r.reason) });
  }
  return { ok: true, deployments: out };
}

// readEvery's answer → what --list says: { ok, count, rows, deployments,
// note? } or { ok: false, reason }. Only when no deployment was read is the
// whole unknown; a deployment that failed is unknown on its own.
export function listResult(every) {
  if (!every.ok) return { ok: false, reason: firstLine(every.reason) };
  const read = every.deployments.filter((d) => d.ok);
  const rows = read.flatMap((d) => d.rows.map((row) => ({ ...row, deployment: d.path, workspace: d.workspace })));
  const summary = every.deployments.map(({ rows: _, ...d }) => d);
  if (!every.deployments.length) return { ok: true, count: 0, rows, deployments: summary, note: `This computer's list holds no deployment to read: ${deployments.HOW_TO_LIST}.` };
  if (!read.length) return { ok: false, reason: firstLine(`no deployment could be read: ${every.deployments[0].name}: ${every.deployments[0].reason}`), deployments: summary };
  return { ok: true, count: rows.length, rows, deployments: summary };
}

// The selector's text for each row: the instance, and the workspace when
// more than one deployment was read (the path when that is not enough).
export function labels(rows, many) {
  const first = rows.map((row) => (many ? `${row.instance} (${row.workspace || row.deployment})` : row.instance));
  return first.map((label, i) => (first.indexOf(label) !== first.lastIndexOf(label) ? `${rows[i].instance} (${rows[i].deployment})` : label));
}

async function listJson(env, out, statusTimeoutMs, outputLimit, budgetMs) {
  const prep = listShim(env);
  const result = prep.ok
    ? listResult(await readEvery((args, cwd, ms) => statusRead(prep.shim, env, cwd, ms, outputLimit, args), env.HOME, { perReadMs: statusTimeoutMs, budgetMs }))
    : { ok: false, reason: firstLine(prep.reason) };
  out.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

async function listMenu(env, say, notify, statusTimeoutMs, budgetMs) {
  const prep = listShim(env);
  const every = prep.ok ? await readEvery((args, cwd, ms) => statusRead(prep.shim, env, cwd, ms, STATUS_OUTPUT_LIMIT, args), env.HOME, { perReadMs: statusTimeoutMs, budgetMs }) : prep;
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
  const prep = listShim(env);
  if (!prep.ok) { err.write(`oats-omarchy: ${prep.reason}\n`); return 1; }
  const list = listOf(await statusRead(prep.shim, env, env.HOME, timeoutMs, STATUS_OUTPUT_LIMIT, ["deployments", "--json"]));
  if (!list.ok) { err.write(`oats-omarchy: ${list.reason}\n`); return 1; }
  const ok = list.rows.filter((row) => row.state === "ok");
  if (!ok.length) { err.write(`oats-omarchy: this computer's list holds no deployment to read: ${deployments.HOW_TO_LIST}\n`); return 0; }
  let code = 0;
  for (const [i, d] of ok.entries()) {
    if (i) err.write("\n");
    const r = await statusRead(prep.shim, env, d.path, timeoutMs, STATUS_OUTPUT_LIMIT, ["status", "--dir", d.path], { inherit: true });
    if (!r.ok) { code = 1; if (r.error) err.write(`oats-omarchy: oats status --dir ${d.path}: ${r.error}\n`); }
  }
  return code;
}
