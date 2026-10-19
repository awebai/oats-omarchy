// Reading the kernel: the one place the plugin runs `oats` for what it shows.
// `waiting` (the menu's row, the bar panel) and `agents` (the picker) read
// through here, so a read is bounded, stoppable and parsed the same way
// whoever asks.
//
// Every read runs in a process group of its own that this process ends with
// it: on the read's own timeout, and when this process is told to stop (the
// bar widget and the picker stop it at their deadline, on a reload or a
// disable), so no kernel process outlives the read.
import { spawn } from "node:child_process";
import { basename } from "node:path";
import * as deployments from "./deployments.mjs";
import * as discover from "./discover.mjs";
import { isExecutableFile } from "./system.mjs";

const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
// As run() bounds a command's output: more than this ends the read.
export const STATUS_OUTPUT_LIMIT = 8 * 1024 * 1024;
const NOTE_LIMIT = 200;

// One kernel command, `args` (`status --json` by default), in its own process
// group. With `inherit` the kernel writes to this process's own output (the
// Status row's terminal) and nothing is collected. → a promise of
// { ok, status, stdout, stderr, error }.
export function kernelRead(shim, env, cwd, timeoutMs, limit = STATUS_OUTPUT_LIMIT, args = ["status", "--json"], { inherit = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(shim, args, { env, cwd, detached: true, stdio: ["ignore", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"] });
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

// The kernel's own message for a failed command.
export function kernelError(r) {
  try { const out = JSON.parse(r.stdout); if (out?.ok === false && out.error?.message) return out.error.message; } catch { /* not an envelope */ }
  return r.error || (r.stderr || r.stdout).trim() || `exit ${r.status}`;
}

// One bounded line: the first that is not blank.
export const firstLine = (text) => {
  const line = String(text).split("\n").find((l) => l.trim()) || "";
  return line.length > NOTE_LIMIT ? `${line.slice(0, NOTE_LIMIT - 1)}…` : line;
};

// setup's shim. → { ok: true, shim } | { ok: false, reason }.
export function shimOf(env) {
  let shim;
  try { shim = discover.paths(env).shim; } catch (e) { return { ok: false, reason: e.message }; }
  if (!isExecutableFile(shim)) return { ok: false, reason: `setup's shim ${shim} is missing: run setup --apply` };
  return { ok: true, shim };
}

// `oats status --json` → every instance of every agent, in the order listed,
// and the deployment's workspace key (null when it has none). An instance is
// { agent, instance, home, running, waitingOnYou }: `waitingOnYou` is the
// kernel's claim as given, or null, which makes no claim (it does not say the
// row is not waiting). `key` is the agent's soul key (feature
// launch-preference), null when the kernel gives none. A kernel error
// envelope, or anything without an agents list, throws.
export function readRoster(stdout) {
  const status = JSON.parse(stdout);
  if (status?.ok === false) throw new Error(status.error?.message || "oats status reported an error");
  if (!Array.isArray(status?.agents)) throw new Error("oats status --json has no agents list");
  const agents = status.agents.filter((a) => a && typeof a === "object").map((a) => ({
    name: typeof a.name === "string" ? a.name : "",
    key: typeof a.key === "string" && a.key ? a.key : null,
    instances: (Array.isArray(a.instances) ? a.instances : [])
      .filter((row) => row && typeof row.instance === "string" && row.instance && typeof row.home === "string")
      .map((row) => ({
        agent: typeof a.name === "string" ? a.name : "",
        instance: row.instance,
        home: row.home,
        running: typeof row.running === "boolean" ? row.running : null,
        waitingOnYou: waitingClaim(row.waitingOnYou),
      })),
  }));
  const key = status.workspace?.key;
  return { agents, workspace: typeof key === "string" && key ? key : null };
}

// A `waitingOnYou` as the kernel gives it, its four fields kept as they are
// (each a string or null), or null when there is no claim.
function waitingClaim(w) {
  if (w == null || typeof w !== "object") return null;
  const field = (v) => (typeof v === "string" ? v : null);
  return { since: field(w.since), producer: field(w.producer), reason: field(w.reason), message: field(w.message) };
}

// `oats status --json`'s result → the roster, or why not.
// → { ok: true, agents, workspace } | { ok: false, reason }.
export function rosterOf(r) {
  if (!r.ok) return { ok: false, reason: kernelError(r) };
  try { return { ok: true, ...readRoster(r.stdout) }; } catch (e) { return { ok: false, reason: e.message }; }
}

// `oats deployments --json`'s result → parseList's answer. A CLI without
// the list says so in words a person can act on.
export function listOf(r) {
  if (r.ok) return deployments.parseList(r.stdout);
  let code = null;
  try { code = JSON.parse(r.stdout)?.error?.code; } catch { /* not an envelope */ }
  if (code === "E_UNKNOWN_COMMAND") return { ok: false, reason: `this OATS CLI keeps no list of deployments (it lacks the feature ${deployments.FEATURE}): update it, or run setup --apply again` };
  return { ok: false, reason: kernelError(r) };
}

// `oats souls --json` (`soulsApi: 1`, in the kernel's envelope) → the souls
// the deployment offers, each { key, name, description, spawnable, problem }:
// `key` is what `oats spawn` takes (the qualified name of a package soul),
// `problem` the kernel's { code, message } when it cannot be spawned.
// → { ok: true, souls } | { ok: false, reason }.
export const SOULS_API = 1;
export function soulsOf(r) {
  if (!r.ok) return { ok: false, reason: kernelError(r) };
  let doc;
  try { doc = JSON.parse(r.stdout); } catch { return { ok: false, reason: "oats souls --json printed no JSON" }; }
  const result = doc && typeof doc === "object" && "result" in doc ? doc.result : doc;
  if (result?.soulsApi !== SOULS_API) return { ok: false, reason: `oats souls --json is not soulsApi ${SOULS_API}` };
  if (!Array.isArray(result.souls)) return { ok: false, reason: "oats souls --json has no souls list" };
  const souls = result.souls.filter((s) => s && typeof s.name === "string" && s.name).map((s) => {
    const key = typeof s.key === "string" && s.key ? s.key : typeof s.qualifiedName === "string" && s.qualifiedName ? s.qualifiedName : s.name;
    const problem = s.problem && typeof s.problem === "object"
      ? { code: typeof s.problem.code === "string" ? s.problem.code : null, message: typeof s.problem.message === "string" ? s.problem.message : null }
      : null;
    return { key, name: s.name, description: typeof s.description === "string" ? s.description : null, spawnable: s.spawnable === true, problem };
  });
  return { ok: true, souls };
}

// One deployment: its roster, and with `souls` the souls it offers, each
// with how many instances its agent has now (by the roster's agent `key`,
// when `counts`; null otherwise). Each read within `ms()`, what is left of
// the read's own limit and of the budget. → { path, name, workspace, ok,
// agents | reason, souls?, soulsReason? }.
async function readDeployment(read, d, ms, { souls = false, counts = false } = {}) {
  const base = { path: d.path, name: d.name };
  const limit = ms();
  if (limit <= 0) return { ...base, workspace: null, ok: false, reason: d.outOfTime };
  const roster = rosterOf(await read(["status", "--json", "--dir", d.path], d.path, limit));
  if (!roster.ok) return { ...base, workspace: null, ok: false, reason: firstLine(roster.reason) };
  const out = { ...base, workspace: roster.workspace, ok: true, agents: roster.agents };
  if (!souls) return out;
  const left = ms();
  const listed = left <= 0 ? { ok: false, reason: d.outOfTime } : soulsOf(await read(["souls", "--json", "--dir", d.path], d.path, left));
  if (!listed.ok) return { ...out, souls: null, soulsReason: firstLine(listed.reason) };
  const instancesOf = (key) => roster.agents.filter((a) => a.key === key).reduce((n, a) => n + a.instances.length, 0);
  return { ...out, souls: listed.souls.map((s) => ({ ...s, instances: counts ? instancesOf(s.key) : null })) };
}

// The deployments to read, then each one's reads, one after another, never
// two at once. `read(args, cwd, timeoutMs)` runs the kernel (a promise or
// not). Each read has `perReadMs`, and all of them `budgetMs`; a deployment
// not reached by then is not read. With `dir` that one deployment alone
// (setup is for one deployment); otherwise this computer's list, from `home`,
// and only its `ok` rows. → { ok: false, reason } when the list could not be
// read, else { ok: true, deployments: [{ path, name, workspace, ok, agents |
// reason, souls?, soulsReason? }] }.
export async function readEvery(read, home, { perReadMs, budgetMs, dir = null, souls = false, counts = false }) {
  const start = Date.now();
  const left = () => budgetMs - (Date.now() - start);
  const ms = () => Math.min(perReadMs, left());
  const outOfTime = `not read: the ${Math.round(budgetMs / 1000)} s for every deployment ran out`;
  let rows;
  if (dir !== null) rows = [{ path: dir, name: basename(dir) }];
  else {
    const list = listOf(await read(["deployments", "--json"], home, ms()));
    if (!list.ok) return list;
    rows = list.rows.filter((row) => row.state === "ok");
  }
  const out = [];
  for (const d of rows) out.push(await readDeployment(read, { ...d, outOfTime }, ms, { souls, counts }));
  return { ok: true, deployments: out };
}

// readEvery's deployments → the answer's: { ok: true, ... } unless none was
// read. → null when there is something to show, else { ok: false, reason }
// (no deployment could be read) or { ok: true, note } (the list is empty).
export function emptyAnswer(every) {
  if (!every.deployments.length) return { ok: true, note: `This computer's list holds no deployment to read: ${deployments.HOW_TO_LIST}.` };
  if (!every.deployments.some((d) => d.ok)) return { ok: false, reason: firstLine(`no deployment could be read: ${every.deployments[0].name}: ${every.deployments[0].reason}`) };
  return null;
}
