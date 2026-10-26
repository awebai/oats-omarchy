// Finding this machine's steward: the one instance of oats.machine's steward
// soul (awebai/oats-machine) on this computer, which `omarchy-launch-oats`
// opens. This is the only place that knows how. Nothing is recorded: the
// steward is found again on every launch, so a respawn is never stale.
//
// The deployments come from this computer's list (`oats deployments --json`)
// when the kernel lists the feature `deployments-list`, else the one
// deployment setup's state records. The launcher reads that recorded
// deployment first (recordedFirst, recordedSteward), and the list only when
// it does not settle it. Each `ok` deployment's `oats status
// --json` is read, one after another, with the deployment as the working
// directory; the steward is an instance of the steward's agent row
// (isStewardAgent: its soul key, else its name). Every
// kernel call runs in a process group of its own, bounded and killed with it
// (waiting.mjs statusRead).
import { isAbsolute, join } from "node:path";
import * as deployments from "./deployments.mjs";
import * as discover from "./discover.mjs";
import { readState } from "./state.mjs";
import { isExecutableFile } from "./system.mjs";
import { isStewardAgent } from "./steward-agent.mjs";
import { listOf, statusRead } from "./waiting.mjs";

export const SPAWN_HINT = "spawn one with `oats spawn oats.machine/steward` in the machine's deployment";
// Each kernel read: `deployments --json` and every `status --json`.
export const READ_TIMEOUT = 30_000;

const NOTE_LIMIT = 200;
const firstLine = (text) => {
  const line = String(text).split("\n").find((l) => l.trim()) || "";
  return line.length > NOTE_LIMIT ? `${line.slice(0, NOTE_LIMIT - 1)}…` : line;
};

// A failed kernel call's reason: the envelope's message, else its error
// (a timeout), else the first line it printed, else its exit status.
export function kernelMessage(r) {
  try { const out = JSON.parse(r.stdout); if (out?.ok === false && out.error?.message) return out.error.message; } catch { /* not an envelope */ }
  return r.error || firstLine(r.stderr || r.stdout) || `exit ${r.status}`;
}

// The kernel feature whose status rows carry `identityAddress`.
export const ADDRESS_FEATURE = "desktop-facts";

// `oats status --json`'s stdout and the kernel's `version --json` features →
// the steward instances it lists, each { instance, home, address }.
// `address` is the row's `identityAddress` when the features include
// desktop-facts: an address only when the kernel reports one in
// namespace/alias form; a bare alias is not an address, and it is null. A
// kernel error envelope, or anything without an agents list, throws.
export function stewardsIn(stdout, features) {
  const addresses = Array.isArray(features) && features.includes(ADDRESS_FEATURE);
  const status = JSON.parse(stdout);
  if (status?.ok === false) throw new Error(status.error?.message || "oats status reported an error");
  if (!Array.isArray(status?.agents)) throw new Error("oats status --json has no agents list");
  return status.agents
    .filter((agent) => isStewardAgent(agent) && Array.isArray(agent.instances))
    .flatMap((agent) => agent.instances)
    .filter((row) => row && typeof row.instance === "string" && row.instance && typeof row.home === "string" && isAbsolute(row.home))
    .map((row) => ({ instance: row.instance, home: row.home, address: addresses && typeof row.identityAddress === "string" && row.identityAddress.includes("/") ? row.identityAddress : null }));
}

// The deployments to read: { ok: true, rows: [{ path, name }] } | { ok: false, reason }.
async function deploymentsToRead(shim, env, features, timeoutMs, deployment) {
  if (deployments.listed(features)) {
    const list = listOf(await statusRead(shim, env, env.HOME, timeoutMs, undefined, ["deployments", "--json"]));
    if (!list.ok) return list;
    return { ok: true, rows: list.rows.filter((row) => row.state === "ok").map(({ path, name }) => ({ path, name })) };
  }
  if (deployment) return { ok: true, rows: [{ path: deployment, name: deployment }] };
  const stateFile = join(discover.paths(env).stateDir, "state.json");
  let state;
  try { state = readState(stateFile); } catch (e) { return { ok: false, reason: `${stateFile} cannot be read: ${e.message}` }; }
  if (!state || typeof state.deployment !== "string" || !isAbsolute(state.deployment)) {
    return { ok: false, reason: "this OATS CLI keeps no list of deployments, and setup's state records none: run setup --apply" };
  }
  return { ok: true, rows: [{ path: state.deployment, name: state.deployment }] };
}

// The launcher's fast path (findSteward's `recordedFirst`). With the list,
// setup's state can record the deployment it was applied for (`--dir`):
// when that deployment's status lists exactly one steward, it is the
// machine's, and neither the list nor the other deployments are read (one
// kernel read instead of one per listed deployment). This can miss a second
// steward in another deployment, which only the full scan reports ("several
// stewards"). That is acceptable: setup moves the agent key only while the
// machine has one steward, and the README names one steward per machine.
// Anything else (no record, an unreadable status, none or several there)
// leaves it to the full scan, unchanged. → { found, read }: the answer, or
// null, and the status read made, for the scan to reuse.
async function recordedSteward(shim, env, timeoutMs, features) {
  let state;
  try { state = readState(join(discover.paths(env).stateDir, "state.json")); } catch { return { found: null, read: null }; }
  const path = state?.deployment;
  if (typeof path !== "string" || !isAbsolute(path)) return { found: null, read: null };
  const r = await statusRead(shim, env, path, timeoutMs, undefined, ["status", "--json"]);
  const read = { path, r };
  if (!r.ok) return { found: null, read };
  let rows;
  try { rows = stewardsIn(r.stdout, features); } catch { return { found: null, read }; }
  return { found: rows.length === 1 ? { ok: true, ...rows[0], deployment: { path, name: path }, unread: [] } : null, read };
}

// → { ok: true, instance, home, deployment: { path, name }, unread } for
// exactly one steward, else { ok: false, reason }: none (with `none: true`), or several, listed,
// of which none is picked. A deployment that could not be read never hides
// a steward found in another one, and is named either way: in `unread`
// ("<name> (<path>): <why>"), or in the reason. `shim` is setup's (discover.paths), and
// `features` the kernel's `version --json` features, read when not given.
// Without the list, `deployment` is the one to read (setup passes the one it
// is applying for, before its state records it), else the state's. With the
// list, `recordedFirst` (the launcher) tries the deployment setup's state
// records first (recordedSteward).
export async function findSteward(env, { shim = discover.paths(env).shim, features, timeoutMs = READ_TIMEOUT, deployment, recordedFirst = false } = {}) {
  if (!isExecutableFile(shim)) return { ok: false, reason: `setup's shim ${shim} is missing: run setup --apply` };
  if (features === undefined) {
    const v = await statusRead(shim, env, env.HOME, timeoutMs, undefined, ["version", "--json"]);
    if (!v.ok) return { ok: false, reason: `oats version --json failed: ${kernelMessage(v)}` };
    try { features = JSON.parse(v.stdout).features; } catch { return { ok: false, reason: "oats version --json printed no JSON" }; }
  }
  let known = null;
  if (recordedFirst && deployments.listed(features)) {
    const fast = await recordedSteward(shim, env, timeoutMs, features);
    if (fast.found) return fast.found;
    known = fast.read;
  }
  const list = await deploymentsToRead(shim, env, features, timeoutMs, deployment);
  if (!list.ok) return { ok: false, reason: firstLine(list.reason) };

  const found = [];
  const failed = [];
  for (const d of list.rows) {
    // The recorded deployment's status, when the fast path read it already.
    const r = known?.path === d.path ? known.r : await statusRead(shim, env, d.path, timeoutMs, undefined, ["status", "--json"]);
    let rows;
    try {
      if (!r.ok) throw new Error(kernelMessage(r));
      rows = stewardsIn(r.stdout, features);
    } catch (e) { failed.push(`${d.name} (${d.path}): ${firstLine(e.message)}`); continue; }
    for (const row of rows) found.push({ ...row, deployment: d });
  }
  const unread = failed.length ? `; not read: ${failed.join("; ")}` : "";
  if (found.length === 1) return { ok: true, ...found[0], unread: failed };
  if (found.length > 1) return { ok: false, reason: `several stewards on this machine, and none is chosen: ${found.map((s) => `${s.instance} @ ${s.deployment.name}`).join(", ")}${unread}` };
  const empty = list.rows.length ? "" : ` (this computer's list holds no deployment: ${deployments.HOW_TO_LIST})`;
  // None is known only when every deployment was read: one that could not
  // be read may hold a steward, or several.
  return { ok: false, ...(failed.length ? {} : { none: true }), reason: `no steward on this machine: ${SPAWN_HINT}${empty}${unread}` };
}
