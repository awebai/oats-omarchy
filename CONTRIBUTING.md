# Developing oats-omarchy

## Layout

The repository separates the package from the tooling that checks it:

```
oats-package/            the payload: everything the kernel copies, nothing else
  oats-package.json      the package manifest (one capability)
  capabilities/oats-omarchy/
    oats.json            capability oats.omarchy, command namespace `omarchy`
    bin/oats-omarchy.mjs the one executable: `oats omarchy <command>` runs it
    skills/              the skills a soul with the capability receives
schemas/                 kernel schemas the manifests are validated against
scripts/                 lint and manifest validation
test/                    node:test suites; test/fixtures holds their inputs
ci/                      the Arch Linux + Omarchy container bootstrap and checks
.github/workflows/ci.yml
```

Rules the checks hold:

- **Only `oats-package/` ships.** Every path a manifest names resolves, after
  symlinks, inside it, and a capability's paths inside its own directory. An
  `oats.json` or `oats-package.json` anywhere else is refused.
- **Runtime code uses Node built-ins only** and never hardcodes the payload
  directory's name.
- **No file names a terminal emulator.** Terminal windows open through
  Omarchy's launchers (`omarchy-launch-tui`, `omarchy-launch-or-focus-tui`,
  `omarchy-launch-floating-terminal-with-presentation`), which run the user's
  default terminal through `xdg-terminal-exec`.
  `test/no-terminal-names.test.mjs` scans every file and holds the list.

## Commands

```bash
npm run lint       # node --check, bash -n (and shellcheck when installed), JSON parse
npm run validate   # manifests against schemas/, containment, no stray manifests
npm test           # every test/**/*.test.mjs
```

The `lint` job of CI runs all three on Node 22. There are no dependencies to
install.

## The Omarchy job

CI's `omarchy` job runs in a pinned `archlinux:base` container:

- `ci/omarchy-bootstrap.sh` (as root) installs `omarchy` from Omarchy's own
  repository, with signatures required and Omarchy's packaging key trusted by
  its pinned fingerprint. It also creates the unprivileged user `ci`, because
  Hyprland refuses to run as root.
- `ci/verify-hypr-config.sh --expect ok|error <config> [home]` (as `ci`) checks
  a config with `Hyprland --verify-config`, which needs no compositor.
  `test/fixtures/hypr/` holds known-good and known-bad submaps in both layouts:
  Lua (`bindings.lua`, Omarchy 4) and hyprlang (`bindings.conf`).

Installing `omarchy` in a container works as it is: Limine's post-transaction
hooks report that there is no FAT32 boot partition, which pacman treats as
non-fatal.

A running Hyprland is not available there. Without a DRM device, or a parent
Wayland compositor with a GPU render node, Hyprland stops at start
(`CBackend::create() failed!`), and its headless backend is only a fallback
beside those. So nothing that needs `hyprctl` (for example
`omarchy menu keybindings --print`) runs against a live Hyprland in CI.
Tests feed captured output instead.

## Testing on a desktop machine

Tests and manual runs never touch a real desktop configuration. Omarchy's
menu and its hook runner read `$HOME/.config/...` and ignore
`XDG_CONFIG_HOME`. So every run sets `HOME` to a temporary directory, together
with `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`.
