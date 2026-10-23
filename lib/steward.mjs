// Finding this machine's steward: the one instance of oats.machine's steward
// soul (awebai/oats-machine) on this computer, which `omarchy-launch-oats`
// opens. This is the only place that knows how. Nothing is recorded: the
// steward is found again on every launch, so a respawn is never stale.
//
// The deployments come from this computer's list (`oats deployments --json`)
// when the kernel lists the feature `deployments-list`, else the one
// deployment setup's state records. Each `ok` deployment's `oats status
// --json` is read, one after another, with the deployment as the working
// directory; the steward is an instance of the agent STEWARD_AGENT. Every
// kernel call runs in a process group of its own, bounded and killed with it
// (waiting.mjs statusRead).
import { isAbsolute, join } from "node:path";
import * as deployments from "./deployments.mjs";
import * as discover from "./discover.mjs";
import { readState } from "./state.mjs";
import { isExecutableFile } from "./system.mjs";
import { listOf, statusRead } from "./waiting.mjs";

// The agent name the kernel gives the package soul `oats.machine/steward`
// in `oats status --json` (`agents[].name`): awebai/oats lib/workspace.mjs
// `packageSoulAgentName(id, soul)` (0.67.1), the package id with every
// character outside [a-z0-9-] made "-", then "--", then the soul's name.
// Neither the instance's name nor the soul path is matched.
export const STEWARD_AGENT = "oats-machine--steward";
export const SPAWN_HINT = "spawn one with `oats spawn oats.machine/steward --name steward` in the machine's deployment";
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

// `oats status --json`'s stdout → the steward instances it lists, each
// { instance, home }. A kernel error envelope, or anything without an
// agents list, throws.
export function stewardsIn(stdout) {
  const status = JSON.parse(stdout);
  if (status?.ok === false) throw new Error(status.error?.message || "oats status reported an error");
  if (!Array.isArray(status?.agents)) throw new Error("oats status --json has no agents list");
  return status.agents
    .filter((agent) => agent?.name === STEWARD_AGENT && Array.isArray(agent.instances))
    .flatMap((agent) => agent.instances)
    .filter((row) => row && typeof row.instance === "string" && row.instance && typeof row.home === "string" && isAbsolute(row.home))
    .map((row) => ({ instance: row.instance, home: row.home }));
}

// The deployments to read: { ok: true, rows: [{ path, name }] } | { ok: false, reason }.
async function deploymentsToRead(shim, env, features, timeoutMs) {
  if (deployments.listed(features)) {
    const list = listOf(await statusRead(shim, env, env.HOME, timeoutMs, undefined, ["deployments", "--json"]));
    if (!list.ok) return list;
    return { ok: true, rows: list.rows.filter((row) => row.state === "ok").map(({ path, name }) => ({ path, name })) };
  }
  const stateFile = join(discover.paths(env).stateDir, "state.json");
  let state;
  try { state = readState(stateFile); } catch (e) { return { ok: false, reason: `${stateFile} cannot be read: ${e.message}` }; }
  if (!state || typeof state.deployment !== "string" || !isAbsolute(state.deployment)) {
    return { ok: false, reason: "this OATS CLI keeps no list of deployments, and setup's state records none: run setup --apply" };
  }
  return { ok: true, rows: [{ path: state.deployment, name: state.deployment }] };
}

// → { ok: true, instance, home, deployment: { path, name } } for exactly one
// steward, else { ok: false, reason }: none (with the deployments that could
// not be read, which never hide a steward found in another one), or several,
// listed, of which none is picked. `shim` is setup's (discover.paths), and
// `features` the kernel's `version --json` features, read when not given.
export async function findSteward(env, { shim = discover.paths(env).shim, features, timeoutMs = READ_TIMEOUT } = {}) {
  if (!isExecutableFile(shim)) return { ok: false, reason: `setup's shim ${shim} is missing: run setup --apply` };
  if (features === undefined) {
    const v = await statusRead(shim, env, env.HOME, timeoutMs, undefined, ["version", "--json"]);
    if (!v.ok) return { ok: false, reason: `oats version --json failed: ${kernelMessage(v)}` };
    try { features = JSON.parse(v.stdout).features; } catch { return { ok: false, reason: "oats version --json printed no JSON" }; }
  }
  const list = await deploymentsToRead(shim, env, features, timeoutMs);
  if (!list.ok) return { ok: false, reason: firstLine(list.reason) };

  const found = [];
  const failed = [];
  for (const d of list.rows) {
    const r = await statusRead(shim, env, d.path, timeoutMs, undefined, ["status", "--json"]);
    let rows;
    try {
      if (!r.ok) throw new Error(kernelMessage(r));
      rows = stewardsIn(r.stdout);
    } catch (e) { failed.push(`${d.name} (${d.path}): ${firstLine(e.message)}`); continue; }
    for (const row of rows) found.push({ ...row, deployment: d });
  }
  if (found.length === 1) return { ok: true, ...found[0] };
  if (found.length > 1) return { ok: false, reason: `several stewards on this machine, and none is chosen: ${found.map((s) => `${s.instance} @ ${s.deployment.name}`).join(", ")}` };
  const unread = failed.length ? `; not read: ${failed.join("; ")}` : "";
  const empty = list.rows.length ? "" : ` (this computer's list holds no deployment: ${deployments.HOW_TO_LIST})`;
  return { ok: false, reason: `no steward on this machine: ${SPAWN_HINT}${empty}${unread}` };
}
