# The found-list (schemaVersion 1)

What `omarchy-install-oats --now` hands the onboarding agent, which follows
OATS's getting-started: the tools it found or installed, the identity in
`~/Work` and the deployments on this machine, so that the agent reads them
instead of detecting them again, and adopts what is there instead of
recreating it. `lib/install.mjs` (`foundList`, `handoff`) writes it.

## Where it is

`${XDG_STATE_HOME:-~/.local/state}/oats-omarchy/found.json`, written
atomically with mode 0600 just before the onboarding agent starts, and
rewritten on every `--now`. The onboarding prompt (`lib/onboarding-prompt.txt`)
names its absolute path.

## What it holds

One JSON object, with no secrets:

```json
{
  "schemaVersion": 1,
  "writtenAt": "2026-10-23T12:00:00.000Z",
  "machine": { "hostname": "merak", "platform": "omarchy", "omarchyVersion": "4.0.4-1" },
  "harness": "claude",
  "plugin": { "dir": "/home/u/.config/omarchy/plugins/ai.aweb.oats", "version": "0.7.0" },
  "gettingStartedSkill": "/abs/path/@awebai/oats/skills/oats-getting-started/SKILL.md",
  "tools": [
    { "name": "node",   "version": "26.8.2",  "origin": "mise",       "path": "/abs/node",         "state": "found" },
    { "name": "tmux",   "version": "3.5a",    "origin": "pacman",     "path": "/usr/bin/tmux",     "state": "found" },
    { "name": "aw",     "version": "1.36.47", "origin": "mise",       "path": "/abs/aw",           "state": "installed" },
    { "name": "oats",   "version": "0.67.1",  "origin": "npm-global", "path": "/abs/bin/oats.mjs", "state": "found" },
    { "name": "claude", "version": "2.1.308", "origin": "other",      "path": "/abs/claude",       "state": "found" },
    { "name": "aweb-channel@awebai-marketplace", "version": null, "origin": "claude-plugin", "path": null, "state": "found" }
  ],
  "awIdentity": { "dir": "/home/u/Work/.aw", "alias": "merak", "address": "juan.aweb.ai/merak", "role": "work" },
  "deployments": [
    { "dir": "/home/u/Agents/merak", "name": "merak", "steward": true }
  ]
}
```

- **`machine.omarchyVersion`** is what `omarchy-version` prints, or null
  without it.
- **`gettingStartedSkill`** is the skill inside the `@awebai/oats` package the
  found `oats` belongs to.
- **`tools[]`** lists every tool the installer checked, in the order above.
  The harness appears under its own name; the channel plugin only when the
  harness is `claude`.
  - **`origin`** is one of `mise`, `npm-global`, `pacman`, `nvm`,
    `local-bin`, `claude-plugin` or `other`, taken from the resolved path.
  - **`path`** is the resolved path (a mise shim resolved to what mise runs).
  - **`state`** is `found` (it was there at or above its minimum, and is
    reused) or `installed` (this run installed it: with mise, tmux with
    `omarchy-pkg-add`, the plugin with `claude plugin install`). The installer
    stops on a tool that is too old or not usable, so a found-list holds only
    these two states.
- **`awIdentity`** is the `.aw` in `~/Work` (from `aw whoami --json` run
  there, without any `AWEB_*` or `AW_*` variable), or null when there is none.
  `alias` and `address` are null when `aw` does not say them.
  - **`role`** is `work`: the person's own `~/Work` identity. When `~/Work` or
    a directory above it holds `oats-local.yaml`, it is `deployment-root`
    instead, and getting-started must never use it as an agent's identity.
    No other `.aw` is listed.
- **`deployments[]`** is `oats deployments --json` as listed. `steward` is
  true when the deployment's `oats status --json` lists an instance of the
  steward's agent (`lib/steward.mjs` `isStewardAgent`: the agent row whose
  `key` is `oats.machine/steward`, or, on a row without a key, the agent
  named `oats-machine--steward`); false for a deployment that is not `ok`.
  When an `ok` deployment's status cannot be read, no found-list is written
  and the installer stops, naming it: for an `ok` deployment, `steward:
  false` always means its status was read.

## Versioning

A field may be added within schemaVersion 1. Removing a field, or changing
what one means, takes schemaVersion 2.

## What getting-started does with it

- Tools at or above their minimum are reused.
- A deployment with `steward: true` is the machine workspace, and nothing
  more is needed.
- An existing `.aw` is left untouched; the machine team's identity is minted
  beside it, in its own directory.
