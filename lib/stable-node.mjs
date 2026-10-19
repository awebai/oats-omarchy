// The kernel's rule for a node path written into something that outlives the
// process, vendored unchanged from awebai/oats lib/stable-node.mjs@v0.60.0
// (stableNode and unitPathEntries; the kernel's own kernelNode is left out).
// Setup records this node in the shim, the menu and the hook, so they keep
// running for as long as the kernel's own hooks would.
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/** A versioned Homebrew keg: <prefix>/Cellar/<formula>/<version>/…, gone at the next upgrade. */
const KEG = /^(.*)\/Cellar\/([^/]+)\/([^/]+)\//;

/** The installer's PATH entries a unit may carry. Dropped: entries inside an
 *  OATS instance home (an instance's `.oats/bin`, anything under
 *  `instanceHome`), entries inside a versioned Homebrew keg, and relative or
 *  empty entries. An entry missing today is kept: it may exist when the tick
 *  runs, and status reports it while it does not. */
export function unitPathEntries(envPath, { instanceHome = process.env.OATS_INSTANCE_HOME } = {}) {
  const home = instanceHome && isAbsolute(instanceHome) ? resolve(instanceHome) : null;
  const hazard = (entry) => {
    if (!entry || !isAbsolute(entry)) return true;
    const segments = entry.split(sep);
    if (segments.some((s, i) => s === ".oats" && segments[i + 1] === "bin")) return true;
    if (home && (resolve(entry) === home || resolve(entry).startsWith(home + sep))) return true;
    return KEG.test(entry.endsWith("/") ? entry : `${entry}/`);
  };
  return String(envPath || "").split(":").filter((entry) => !hazard(entry));
}

function realpathOrNull(p) { try { return realpathSync(p); } catch { return null; } }
/** A node path that survives a Homebrew upgrade. A keg's
 *  `<prefix>/opt/<formula>/bin/node` when it is this node, else the first
 *  `node` on the filtered PATH that is this node, else `execPath` with a
 *  warning that the path is not stable. The warning states the fact; the
 *  caller words what it loses (`consequence`) and what to do after installing
 *  a stable node (`remedy`). */
export function stableNode({ execPath = process.execPath, envPath = process.env.PATH || "", instanceHome = process.env.OATS_INSTANCE_HOME, consequence, remedy } = {}) {
  const real = realpathOrNull(execPath);
  const keg = real && KEG.exec(real);
  if (keg) {
    const opt = join(keg[1], "opt", keg[2], "bin", "node");
    if (realpathOrNull(opt) === real) return { node: opt };
  }
  for (const entry of unitPathEntries(envPath, { instanceHome })) {
    const candidate = join(entry, "node");
    if (real && realpathOrNull(candidate) === real) return { node: candidate };
  }
  return { node: execPath, warning: `the node path ${execPath} is not stable (no Homebrew opt link and no node on PATH resolves to it)${consequence ? `: ${consequence}` : ""}${remedy ? `; install a node with a stable path and ${remedy}` : ""}` };
}
