# Developing oats-omarchy

## Layout

The repository separates the package from the tooling that checks it:

```
oats-package/            the payload: everything the kernel copies, nothing else
  oats-package.json      the package manifest (one capability)
  capabilities/oats-omarchy/
    oats.json            capability oats.omarchy, command namespace `omarchy`
    bin/oats-omarchy.mjs the one executable: `oats omarchy <command>` runs it
    lib/                 its modules (below)
    assets/              the icon both launcher entries use
    skills/              the skills a soul with the capability receives
schemas/                 kernel schemas the manifests are validated against
scripts/                 lint and manifest validation
test/                    node:test suites; test/fixtures holds their inputs,
                         test/helpers/sandbox.mjs the temporary machine they run on
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

## How setup is built

`oats omarchy setup` (`lib/setup.mjs`) gathers what the machine has, works out
the files it wants, compares them with what is there, and only then writes:

- `lib/discover.mjs` finds things instead of assuming them: the deployment
  and soul from the kernel's environment, the Omarchy launchers on the
  session's PATH (`systemctl --user show-environment`, else the process
  PATH), the Hyprland layout, the Desktop (a flag, an existing launcher
  entry, then an AppImage; its standard install is
  `~/.local/opt/oats-desktop/OATS-Desktop.AppImage` with an entry whose
  Exec runs it, and an entry that runs an AppImage, by path or by name on
  PATH, is treated as one, so without FUSE the key and the menu extract and
  run it), FUSE, and the bindings
  `omarchy menu keybindings --print` reports.
- `lib/keys.mjs` turns that report into the suggested key and its snippet.
  Setup never writes key bindings.
- `lib/files.mjs` renders each file (the shim, the launcher entries, the
  post-update hook); `lib/desktop-entry.mjs` reads and writes desktop
  entries.
- `lib/menu.mjs` is the `oats` submenu: a delimited block in the user's
  `~/.config/omarchy/extensions/omarchy-menu.jsonc`, the one file setup edits
  rather than writes whole. Only the block's bytes, and a separating comma
  when the user's last entry had none, are added and taken out; the rest of
  the file is never rewritten. The block goes where Omarchy reads items (into
  `items` when the file wraps them there). `omarchyParse` reads the file by
  the rules of Omarchy's `MenuModel.js` (whole-line `//` comments and
  trailing commas only): setup leaves a file Omarchy cannot read alone, and
  after an edit checks that Omarchy reads the user's items unchanged and
  every row of the block as written.
- `lib/state.mjs` writes atomically and keeps the state file under
  `$XDG_STATE_HOME/oats-omarchy`: every file written, its digest, what was
  there before (backed up beside it) and the directories setup created; for
  the menu block, its exact bytes and whether setup added the comma or
  created the file. `--remove` restores from it and deletes only those
  directories, only when empty. The state file is the user's to edit, so
  `--remove` checks every entry before it touches anything: an entry whose
  path is not one setup manages for its role, or whose backup is not recorded
  as `backup/<name>`, a regular file in a `backup/` that is a directory (not
  a link), is refused by name (`E_STATE_REFUSED`) and the rest is restored.
  The path that check returns is the one `--remove` reads and deletes
  (`managedPaths`, `backupPath` and `refusal` in `lib/setup.mjs`).
- `lib/system.mjs` runs commands with a timeout and a given environment.

`oats omarchy waiting` (`lib/waiting.mjs`) is the menu's "Waiting on you"
row: it reads `oats status --json` for the deployment, shows the instances
waiting on you in `omarchy-menu-select` (the count and the names, nothing
else), and opens the chosen one's `oats session attach` in
`omarchy-launch-floating-terminal-with-presentation`. With nothing to pick it
does not open the selector, which refuses to open empty; it sends
`omarchy-notification-send` instead, or writes to stderr without it.

### Quoting

A launch command can be read three times: by its outer reader (`sh -c` for a
Hyprland exec or a menu action, GLib for a desktop entry's `Exec`, Lua or
hyprlang for the snippet), then by `omarchy-launch-or-focus`, which runs
`eval exec setsid $LAUNCH_COMMAND` unquoted, so bash word-splits and may glob
it before the eval. `lib/quote.mjs` has one function per layer, and a value
is quoted for the eval first and for the outer reader second. A path with a
single quote or a control character is refused (`E_UNSAFE_PATH`).

Omarchy's menu runs an action with `bash -lc`. Its TUI and Desktop actions
are the same launch commands as the keys, so they go through
`omarchy-launch-or-focus[-tui]` and its eval as above. The waiting and status
actions, and the attach command (which the floating terminal joins and runs
with `bash -c`), have no eval layer: they are single-quoted shell words.

## Commands

```bash
npm run lint       # node --check, bash -n (and shellcheck when installed), JSON parse
npm run validate   # manifests against schemas/, containment, no stray manifests
npm test           # every test/**/*.test.mjs
```

The `lint` job of CI runs all three on Node 22. There are no dependencies to
install.

Tests run on a temporary machine (`test/helpers/sandbox.mjs`): a temporary
HOME and XDG directories, a stand-in for Omarchy's menu definition
(`OMARCHY_PATH`), a PATH of fakes (the Omarchy launchers, the menu's
selector, notifier and floating terminal, `omarchy`, `systemctl`,
`ldconfig`, `tmux`) before a private directory of basic tools, and a
stand-in for the kernel that dispatches `oats omarchy` to the package with
the environment the kernel gives a dispatched command, and answers
`status --json` and `version --json` from files a test writes. Each fake
models the real tool's refusals too (the selector never opens empty, the
notifier needs a headline). Nothing on the host's PATH leaks in, so a test
sees only what it set up.

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
- `test/omarchy-container.test.mjs` (as `ci`, with `OATS_OMARCHY_CONTAINER=1`;
  it skips without it) runs setup against the real Omarchy: its launchers,
  through `gio launch` and `sh -c`, its hook runner, `--verify-config` on
  the user's whole configuration with the printed snippet added, Omarchy's
  own `MenuModel.js` reading the menu block (it is plain functions, so it
  runs as a script in a `vm` context), and `oats omarchy waiting` opening a
  session through the real floating terminal. Only the selector is a fake:
  the real one needs a running Omarchy shell.

Installing `omarchy` in a container works as it is: Limine's post-transaction
hooks report that there is no FAT32 boot partition, which pacman treats as
non-fatal.

A running Hyprland is not available there. Without a DRM device, or a parent
Wayland compositor with a GPU render node, Hyprland stops at start
(`CBackend::create() failed!`), and its headless backend is only a fallback
beside those. So nothing that needs `hyprctl` (for example
`omarchy menu keybindings --print`) runs against a live Hyprland in CI.
Tests serve `--print` from captured output in `test/fixtures/print/`, taken
from a machine with Omarchy's default bindings.

## Testing on a desktop machine

Tests and manual runs never touch a real desktop configuration. Omarchy's
menu and its hook runner read `$HOME/.config/...` and ignore
`XDG_CONFIG_HOME`. So every run sets `HOME` to a temporary directory, together
with `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`.
