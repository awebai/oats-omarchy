// This computer's list of deployments, as the kernel keeps it (awebai/oats
// #1390): `oats deployments --json`, when `oats version --json` lists the
// feature `deployments-list`. The plugin only reads the list; the kernel
// fills it (every kernel command run in a deployment lists it, and
// `oats deployments add <path>` does it by hand).
//
// Only `deploymentsApi: 1` is read, and of each row only its path, name and
// state. A row the kernel marks other than `ok` is not a deployment to read
// now (gone, unmounted, not a deployment, or unreadable): it is listed, never
// read.
import { isAbsolute } from "node:path";

export const FEATURE = "deployments-list";
export const API = 1;
export const STATES = ["ok", "missing", "not-a-deployment", "unreadable"];
// What the person can do when no deployment is listed.
export const HOW_TO_LIST = "run any oats command in a deployment, or `oats deployments add <path>`";

export const listed = (features) => Array.isArray(features) && features.includes(FEATURE);

const text = (value) => typeof value === "string" && value.length > 0 && !value.includes("\0");

// `oats deployments --json`'s stdout → { ok: true, rows: [{ path, name, state }] }
// in the kernel's order, or { ok: false, reason }. The kernel's envelope
// (`{ ok, result }`) is unwrapped; its error is the reason.
export function parseList(stdout) {
  let doc;
  try { doc = JSON.parse(stdout); } catch { return { ok: false, reason: "oats deployments --json printed no JSON" }; }
  if (doc?.ok === false) return { ok: false, reason: doc.error?.message || "oats deployments reported an error" };
  const list = doc && typeof doc === "object" && "result" in doc ? doc.result : doc;
  if (list?.deploymentsApi !== API) return { ok: false, reason: `oats deployments --json is not deploymentsApi ${API}` };
  if (!Array.isArray(list.deployments)) return { ok: false, reason: "oats deployments --json has no deployments list" };
  const rows = [];
  for (const row of list.deployments) {
    if (!row || !text(row.path) || !isAbsolute(row.path) || !text(row.name) || !STATES.includes(row.state)) {
      return { ok: false, reason: "oats deployments --json has a row this plugin cannot read" };
    }
    rows.push({ path: row.path, name: row.name, state: row.state });
  }
  return { ok: true, rows };
}
