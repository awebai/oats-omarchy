// Which agent row of `oats status --json` is the steward's: the agent of
// oats.machine's steward soul (awebai/oats-machine). lib/steward.mjs finds
// the steward with it, and lib/waiting.mjs marks the steward's row with it,
// so the bar's card opens the steward through the launcher.
//
// Its `key` is the soul's exact key, `oats.machine/steward`, whenever an
// instance records a workspace soul (feature launch-preference; awebai/oats
// docs/desktop-cli-api.md, "key on soul and agent rows"). Only a row
// without one (`key` absent or null) is matched by its name: the agent name
// the kernel gives that package soul, lib/workspace.mjs
// `packageSoulAgentName(id, soul)` (0.67.1), the package id with every
// character outside [a-z0-9-] made "-", then "--", then the soul's name.
// Neither the instance's name nor the soul path is matched.
export const STEWARD_KEY = "oats.machine/steward";
export const STEWARD_AGENT = "oats-machine--steward";
export const isStewardAgent = (agent) =>
  (agent?.key !== undefined && agent?.key !== null ? agent.key === STEWARD_KEY : agent?.name === STEWARD_AGENT);
