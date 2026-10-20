# Developing oats-omarchy

## Layout

The repository is the plugin: Omarchy clones it whole, and nothing is built.

```
manifest.json            the plugin's manifest: id ai.aweb.oats, one bar widget
OatsBarWidget.qml        the bar widget: the OATS icon and its panel
widget.mjs               everything the widget builds or reads, kept apart so a test can run it
setup                    the command people run: a POSIX sh launcher
bin/setup.mjs            setup's engine, which the launcher and the post-update hook run
bin/waiting.mjs          the oats menu's "Waiting on you" row, and the panel's read (--json)
lib/                     their modules (below)
assets/                  the icon both launcher entries use
scripts/lint.mjs         lint
test/                    node:test suites; test/fixtures holds their inputs,
                         test/helpers/sandbox.mjs the temporary machine they run on
ci/                      the Arch Linux + Omarchy container bootstrap and checks
.github/workflows/ci.yml
```

Rules the checks hold:

- **No symlinks anywhere.** `omarchy plugin validate` refuses a plugin that
  has one.
- **Setup writes nothing inside its own directory.** Omarchy reloads plugin
  code when a file under `~/.config/omarchy/plugins/` changes, and the
  directory is a git checkout that updates fast-forward.
- **Runtime code uses Node built-ins only.** The launcher is POSIX sh.
- **No file names a terminal emulator.** Terminal windows open through
  Omarchy's launchers (`omarchy-launch-tui`, `omarchy-launch-or-focus-tui`,
  `omarchy-launch-floating-terminal-with-presentation`), which run the user's
  default terminal through `xdg-terminal-exec`.
  `test/no-terminal-names.test.mjs` scans every file and holds the list.

## How setup is built

`setup` runs `bin/setup.mjs` with `node` from PATH, else with the node the
last `--apply` recorded (`$XDG_STATE_HOME/oats-omarchy/node`). Setup
(`lib/setup.mjs`) gathers what the machine has, works out the files it wants,
compares them with what is there, and only then writes:

- `lib/discover.mjs` finds things instead of assuming them:
  - the deployment, only when the OATS CLI keeps no list of this computer's
    deployments (see "This computer's list of deployments" below): `--dir`,
    else the nearest `oats-local.yaml` at or above
    the working directory, else the one setup's state records. With none,
    `--plan` and `--apply` in a terminal ask for its path, which must be a
    directory holding a regular `oats-local.yaml` (not a link). Nothing is
    offered or guessed; without a terminal (or with `--json`) it is
    `E_NO_DEPLOYMENT`;
  - the OATS CLI: `oats` on PATH resolved to the CLI's script (a mise shim
    through `mise which oats`), refused when it is an instance home's
    `.oats/bin` shim, and proven by `version --json`, 0.53.0 or later;
  - the node: the kernel's rule for a path that outlives the process,
    vendored unchanged in `lib/stable-node.mjs` from awebai/oats v0.60.0
    (`test/stable-node-vendored.test.mjs` pins it by digest and says how to
    re-vendor);
  - the plugin's own directory, resolved.

  Everything setup writes runs by those recorded absolute paths, never by
  PATH: the shim (node and CLI), the menu's "Waiting on you" row (node and
  `bin/waiting.mjs`) and the post-update hook (node and `bin/setup.mjs
  --check`). `--check` reports any of them gone or moved. It also finds the
  Omarchy launchers on the
  session's PATH (`systemctl --user show-environment`, else the process
  PATH), the Hyprland layout, the Desktop (a flag, an existing launcher
  entry, then an AppImage; its standard install is
  `~/.local/opt/oats-desktop/OATS-Desktop.AppImage` with an entry whose
  Exec runs it, and an entry that runs an AppImage, by path or by name on
  PATH, is treated as one, so without FUSE the key and the menu extract and
  run it), FUSE, and the bindings
  `omarchy menu keybindings --print` reports.
- `lib/keys.mjs` turns that report into the key and its snippet.
- `lib/bindings.mjs` is the key block: the Lua snippet between marker
  comments, appended to the end of `~/.config/hypr/bindings.lua` after a
  blank line. Setup writes it only for the Lua layout, and only when every
  effective SUPER + O action (from `--print`) is Omarchy's stock pop-out,
  the user's `bindings.lua` does not bind SUPER + O, and no user submap is
  named `oats`. A re-apply that changes the block checks the same things
  outside it, allowing only the OATS entry the block itself binds.
  Otherwise the part is skipped with the reason, and the snippet is
  printed. The file is backed up whole. `--remove` restores the backup only
  when the file is byte-identical to what `--apply` wrote and the user had
  not edited it before a re-apply rewrote the block (the record's
  `restorable`); otherwise it takes out the block's bytes alone, leaving the
  separator and every other byte, UTF-8 or not. A file edited while setup
  verifies the block is left alone: apply writes a block only into the
  bytes it planned and verified.
- `lib/verify.mjs` checks the change before it goes live, because Hyprland
  reloads as soon as `bindings.lua` changes. It copies `~/.config/hypr` and
  the state Lua the shipped config loads (the theme's modules, the Hyprland
  toggles, the saved workspace layouts) into a private temporary HOME,
  bounded at 50 MB, and runs `Hyprland --verify-config` there. It checks the
  unchanged copy first, then the copy with the block. Omarchy's
  `bootstrap.lua` builds `package.path` from `$HOME`, so the copy is only
  read when HOME points at it.
- `--apply` and `--remove` change files in the person's home. In a terminal
  they show what they will do and ask; otherwise they refuse with
  `E_CONFIRM` unless `--yes` is given, as `omarchy plugin add` does.
- `lib/files.mjs` renders each file (the shim, the launcher entries, the
  post-update hook, the bar widget's `plugin.json`); `lib/desktop-entry.mjs`
  reads and writes desktop entries.
- `plugin.json`, beside the state (`$XDG_STATE_HOME/oats-omarchy`), is what
  the bar widget runs: `{deployment, tui, desktop, waiting, attach, setup}`,
  each an argv from the same functions the key and the menu use (`tui` and
  `desktop` null when that part is not applied; `attach` ends at `--home`).
  It is written on every `--apply` that applies the shim, rewritten when it
  differs, removed by a complete `--remove`, and `--check` reports it
  missing. The detach key goes into `attach` when the CLI's `version --json`
  lists `session-attach-detach-key`, so a re-apply picks up a CLI that
  gained it.
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

`bin/waiting.mjs --dir <deployment>` (`lib/waiting.mjs`) is the menu's
"Waiting on you" row for one deployment (`--list` below is the other). Through setup's shim, it reads `oats status --json` for
the deployment, shows the instances
waiting on you in `omarchy-menu-select` (the count and the names, nothing
else), and opens the chosen one's `oats session attach` in
`omarchy-launch-floating-terminal-with-presentation`, with `--detach-key
M-o` (Alt+O, OATS's leader key in the TUI and the Desktop) when the kernel
lists `session-attach-detach-key`. With nothing to pick it
does not open the selector, which refuses to open empty; it sends
`omarchy-notification-send` instead, or writes to stderr without it.

A row waits on you when its `waitingOnYou` is set. A null there means the
kernel makes no claim about that row, not that it is not waiting: nothing
here says that nobody is waiting. Only a status that could not be read is
unknown. `--json` prints what it read and opens nothing: `{ok, count,
rows: [{instance, home}]}`, or `{ok: false, reason}` with one bounded line
(the kernel's first, when `oats status` failed). It is the bar widget's only
source; the filter lives here alone. With `--json` the kernel's read runs in
a process group of its own, which waiting kills on its own timeout (25 s,
inside the widget's 30 s) and when it is stopped by SIGTERM, SIGINT or
SIGHUP, so a stopped read leaves no kernel process behind.

### This computer's list of deployments

When the OATS CLI setup checked lists the feature `deployments-list` in
`oats version --json` (awebai/oats#1390), setup is for no deployment of its
own. Its state and `plugin.json` record `deployment: null`. The launchers,
the panel's buttons, the menu and setup's own argv carry no `--dir`, and the
post-update hook does not `cd` anywhere. Without the feature, all of that is
for the one deployment, exactly as above; `--check` reports when the CLI
gains or loses the list, and `--apply` switches either way. Setup reads the
list (`lib/deployments.mjs`, `deploymentsApi: 1`, each row's path, name and
state) only for the plan's notes; the plugin never writes it.

`waiting --list` reads `oats deployments --json`, then `oats status --json
--dir <path>` for each row whose state is `ok`, one after another, never two
at once: each read within 25 s with `--json` (30 s in the menu), and all of
them within 110 s (`LIST_BUDGET`); a
deployment not reached in time is not read. Every one of these reads, the
menu's and the Status row's (`bin/status.mjs`, `statusEvery`) included, runs
in a process group of its own, killed with it, as for `--json` above.
`--list --json` prints `{ok, count, rows: [{instance, home, deployment,
workspace}], deployments: [{path, name, workspace, ok, reason?}], note?}`.
A deployment that could not be read is unknown on its own (`ok: false` with
its reason) and the others still count; `ok` is false only when the list
could not be read or no deployment could, and `note` says how to fill an
empty list.

### The bar widget

`OatsBarWidget.qml` displays; `widget.mjs` decides. The QML reads
`plugin.json` (Quickshell's `FileView`), runs the panel's read (`plugin.json`'s
`waiting` argv plus `--json`) as argv through one Quickshell `Process`, and
hands every other command to the bar's `run`, which runs `bash -lc <line>`:
`widget.mjs` builds those lines from `plugin.json`'s argv, every word
single-quoted, and quotes them again for the floating terminal's `bash -c`.
`test/widget.test.mjs` runs each line through bash with stand-ins that log
their argv. `test/widget-qml.test.mjs` loads the widget itself in Quickshell,
offscreen, with Omarchy's own `Ui` and `Commons` and a stand-in only for the
panel's layer-shell window (`KeyboardPanel`, which needs a compositor): the
layout with more rows than fit, a `plugin.json` change, a destroy during a
read, a program that cannot start, and that nothing is read before the panel
opens. It runs in CI's Omarchy container. The icon shows no count. With the
list, the panel groups the rows by workspace (`widget.mjs` `groups`): a
deployment that could not be read is a group of its own, keyed by its path
and titled by its name, and a row's label names its deployment, or its
path, when that is what tells two rows apart. The panel shows the read as
failed only when no deployment could be read.

Nothing is read in the background: there is no timer and no interval
setting. The read runs only when the panel opens, fresh each time, after
`plugin.json` is read again: the widget takes the file's contents when its
read completes (`onLoaded`), and the read waits for that. Until the read
answers, the panel lists nobody and says it is reading. `widget.mjs`'s read
state keeps one read pending from its start to its output or its deadline
(30 s; 120 s for a `--list` read, `readTimeoutMs`), whether or
not its program started (Quickshell reports nothing for a program that
cannot start), so opening the panel again neither overlaps a read nor
moves its deadline; at the deadline the read is stopped and the panel says
why. The widget also stops it
when it is destroyed (a hot reload or a disable). The panel's rows scroll in
what the failed read's reason and the launchers leave of the panel, so the
launchers stay in view however many rows there are. With a bar on each
monitor there is one widget per bar, and one of them reads for all: the
first that the bar's `moduleWidgets` lists, which hands each result to the
others (a widget the bar does not list reads for itself). A read costs about
1.2 s of CPU on a real deployment (`oats status`), so it is once per
opening, not once per bar, and never in the background.

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
npm run lint       # node --check, sh -n/bash -n (and shellcheck when installed), JSON parse
npm test           # every test/**/*.test.mjs
```

The `lint` job of CI runs both on Node 22. There are no dependencies to
install.

Tests run on a temporary machine (`test/helpers/sandbox.mjs`): a temporary
HOME and XDG directories, a stand-in for Omarchy's menu definition
(`OMARCHY_PATH`), a PATH of fakes (the Omarchy launchers, the menu's
selector, notifier and floating terminal, `omarchy`, `systemctl`,
`ldconfig`, `tmux`, and a `Hyprland` whose `--verify-config` logs the
environment it got and refuses on cue) before a private directory of basic
tools, and `oats`
on PATH: a stand-in for the CLI that answers `status --json` and
`version --json` from files a test writes. It can also be one that fails, an
instance home's shim, or a mise shim that `mise which oats` resolves. Each fake
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
  it skips without it) runs setup through `./setup`, with the container's
  node and the CLI stand-in on PATH, against the real Omarchy: its launchers,
  through `gio launch` and `sh -c`, its hook runner, `--verify-config` on
  the user's whole configuration with the printed snippet added, the key
  block written, refused and removed with the real Hyprland, Omarchy's
  own `MenuModel.js` reading the menu block (it is plain functions, so it
  runs as a script in a `vm` context), and `bin/waiting.mjs` opening a
  session through the real floating terminal, as does the bar panel's row.
  Only the selector is a fake: the real one needs a running Omarchy shell.
- `test/widget-qml.test.mjs` (as `ci`, with `OATS_OMARCHY_CONTAINER=1`) loads
  the bar widget in the container's Quickshell with `QT_QPA_PLATFORM=offscreen`
  (see "The bar widget").

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
