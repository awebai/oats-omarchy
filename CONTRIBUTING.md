# Developing oats-omarchy

## Layout

The repository is the plugin: Omarchy clones it whole, and nothing is built.

```
manifest.json            the plugin's manifest: id ai.aweb.oats, a bar widget and an overlay
OatsBarWidget.qml        the bar widget: the OATS icon and its panel
widget.mjs               everything the widget builds or reads, kept apart so a test can run it
OatsPicker.qml           the overlay: the OATS picker
PickerWindow.qml         the picker's layer-shell window (a file of its own for the QML test)
picker.mjs               everything the picker decides, kept apart so a test can run it
setup                    the command people run: a POSIX sh launcher
bin/setup.mjs            setup's engine, which the launcher and the post-update hook run
bin/waiting.mjs          the menu's fallback "Waiting on you" selector, and the panel's read (--json)
bin/agents.mjs           the picker's read (--json)
bin/spawn.mjs            the picker's "start an agent from this soul"
bin/status.mjs           the menu's Status row with the list of deployments
lib/                     their modules (below)
assets/                  the icon both launcher entries use
scripts/lint.mjs         lint
test/                    node:test suites; test/fixtures holds their inputs (and
                         test/fixtures/v0.3.0 v0.3.0's own blocks, for the upgrade),
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
- `lib/keys.mjs` turns that report into the key and its snippet. The
  SUPER + O submap binds Space (the picker, `omarchy-shell shell toggle
  ai.aweb.oats '{}'`), T and D (each only when that part applies) and O
  (Omarchy's pop-out), each also with SUPER held.
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
  the bar widget and the picker run: `{deployment, tui, desktop, waiting,
  attach, setup, agents, spawn}`, each an argv from the same functions the
  key and the menu use (`tui` and `desktop` null when that part is not
  applied; `attach` ends at `--home`; `agents` is `bin/agents.mjs` with
  `--dir` or `--list`, and `spawn` is `bin/spawn.mjs`, by the recorded node).
  A `plugin.json` from before 0.4.0 has no `agents` and `spawn`:
  `widget.mjs` `parsePlugin` reads both as null (both or neither), and the
  picker then offers setup only.
  It is written on every `--apply` that applies the shim, rewritten when it
  differs, removed by a complete `--remove`, and `--check` reports it
  missing. The detach key goes into `attach` when the CLI's `version --json`
  lists `session-attach-detach-key`, so a re-apply picks up a CLI that
  gained it.
- `lib/menu.mjs` is the `oats` submenu: Open OATS, Waiting on you, Agents,
  Souls, Open OATS TUI, Open OATS Desktop and Status, each with `aliases`
  ("oats", "agents", "instances", "souls", "waiting") that Omarchy's menu
  search reads. Open OATS, Waiting on you, Agents and Souls summon the picker
  (`omarchy-shell shell summon ai.aweb.oats '{"section": ...}'`), which
  answers `ok` when the picker opened. Otherwise (the plugin is disabled, or
  no shell runs) Waiting on you runs `bin/waiting.mjs`, the selector the menu
  had before the picker, and the other rows say why in a notification
  (`pickerAction`). It is a delimited block in the user's
  `~/.config/omarchy/extensions/omarchy-menu.jsonc`, the one file setup edits
  rather than writes whole. Only the block's bytes, and a separating comma
  when the user's last entry had none, are added and taken out; the rest of
  the file is never rewritten. The block goes where Omarchy reads items (into
  `items` when the file wraps them there). `omarchyParse` reads the file by
  the rules of Omarchy's `MenuModel.js` (whole-line `//` comments and
  trailing commas only): setup leaves a file Omarchy cannot read alone, and
  after an edit checks that Omarchy reads the user's items unchanged and
  every row of the block as written.
- `--check` rebuilds the menu and key blocks this version would write from
  what the state records (`blocksFor`, the same function the plan uses), so
  a block an older version wrote (v0.3.0's, without the picker) is reported
  as "from an older setup ...: run setup --apply again", as is a
  `plugin.json` without the picker's commands. `--apply` then replaces only
  the marked blocks, the key block verified on a copy first as for a new
  one, and `--remove` still restores exactly what was there before the first
  setup. `test/upgrade.test.mjs` starts from v0.3.0's own bytes
  (`test/fixtures/v0.3.0/blocks.mjs`).
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
rows: [{instance, home, waitingOnYou}]}` (the kernel's claim as given, which
the panel's cards show), or `{ok: false, reason}` with one bounded line
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
`--list --json` prints `{ok, count, rows: [{instance, home, waitingOnYou,
deployment, workspace}], deployments: [{path, name, workspace, ok,
reason?}], note?}`. The reads are `lib/read.mjs`, which the picker's reader
shares.
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
opens. It runs in CI's Omarchy container. The icon shows no count. Each
row is a card (`widget.mjs` `card`, the picker's too): the kernel's
`message` as given, then `reason · producer · age`, each as given, the age
worked out once from `since` when the read answers (nothing ticks), and the
exact `since` in its tooltip. The plugin words nothing of its own about why
an agent waits. The panel's Open OATS summons the picker. With the
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

### The OATS picker

`OatsPicker.qml` is the plugin's overlay (`entryPoints.overlay`). The shell
loads it on `omarchy-shell shell summon|toggle ai.aweb.oats '<json>'`, calls
its `open(payloadJson)` and `close()`, and destroys it when it is hidden.
The payload's `section` (`waiting`, `agents` or `souls`) is where it opens;
without one it opens on Waiting on you when an agent waits, else on Agents
(`picker.mjs` `defaultSection`). Omarchy enables a third-party plugin only
while its widget sits in the bar layout; disabled, a summon answers
`unknown`, which the menu rows handle (above).

`OatsPicker.qml` displays; `picker.mjs` decides, and runs in node too
(`test/picker.test.mjs`). It reads only when it opens: `plugin.json` again,
then `plugin.json`'s `agents` argv plus `--json` through one `Process`, with
one `Timer`, not repeating, as its deadline (120 s, after the reader's own
110 s budget). There is no other timer, and nothing reads in the background.
It runs every command as argv through Omarchy's `Util.execArgv` (`bash -lc
'exec "$@"'`, which re-reads no word): an agent's session in the floating
terminal (`widget.mjs` `attachArgv`), a soul's spawn (`spawnArgv`), or setup
(`setupArgv`). Its colours are the `[menu]` tokens omarchy.clipboard and
omarchy.emojis use (`Color.menu.*`), secondary text faded by opacity as
theirs is; its keys go through `keyPressed(event)`, which the QML test calls
with plain objects. `PickerWindow.qml` is its full-screen layer-shell
window, a file of its own so that `test/widget-qml.test.mjs`, offscreen
where no layer-shell window exists, stands in for it alone.

`bin/agents.mjs (--dir <deployment> | --list) --json` (`lib/agents.mjs`) is
the picker's read, the one answer the picker shows: `{ok, features:
{waitingOnYou, soulCounts}, deployments: [{path, name, workspace, ok,
reason?, agents: [{agent, instance, home, running, waitingOnYou}], souls:
[{key, name, description, spawnable, problem, instances}] | null,
soulsReason?}], note?}`, or `{ok: false, reason}`. It reads `oats version
--json` first, then for each deployment (one after another, as `waiting
--list`, the same 25 s and 110 s) `oats status --json --dir` and `oats souls
--json --dir`. One feature gate per contract: `waiting-on-you` (without it
every `waitingOnYou` is null and `features.waitingOnYou` false, so the
picker says the CLI does not report it), `launch-preference` (the roster's
agent `key`, which counts a soul's instances; without it `instances` is
null), and the souls answer must be `soulsApi: 1`, or that deployment's
souls are unknown on their own. A deployment whose roster cannot be read is
`ok: false` with its reason, and the rest are listed.

In the picker, rows are grouped by workspace when more than one deployment
is listed. When two deployments of one workspace both have an instance name
or a soul, each such row's label names its deployment (by name, or by path
when their names match too), and every row is found by its deployment's
name: Enter spawns in, or attaches from, the row's own deployment.

`bin/spawn.mjs` (`lib/spawn.mjs`) starts an agent from a soul in two steps,
so the task never passes through a shell:

1. `spawn --dir <deployment> <soul>`, from the picker, with the deployment
   the soul was listed from (never guessed, never the working directory):
   asks for the task with `omarchy-menu-input "Task for <soul>"`. A cancel or
   an empty answer runs nothing. The text, untrusted, goes as typed into a
   file of mode 0600 in a directory of mode 0700 of its own (under the
   system's temporary directory, named `oats-omarchy-task-*`), and the
   floating terminal runs step 2 with a line naming that file, never the
   task. Step 1 keeps the file until step 2 has claimed it: the launcher
   hands off on its own (`setsid`, `uwsm-app`), so its exit proves nothing.
   When the launcher fails, or nothing claims the file within 60 s
   (`HANDOFF_MS`), step 1 withdraws the file, removes it and says so in a
   notification.
2. `spawn --run --dir <deployment> --task-file <file> <soul>`, in the
   terminal: first claims the file by renaming it to `claimed` (step 1
   withdraws it by renaming it too, so exactly one of them has it, and a
   terminal that starts after a withdrawal runs nothing), then runs the
   kernel's `oats spawn <soul> --dir <deployment> --task-file <claimed
   file> --json`, as argv, in that deployment, with no other flag (the
   relation is top-level, and the deployment's own resolution picks the
   harness). Its progress shows as it runs, and it is not retried. A
   refusal prints the kernel's code and message (and `details.unconfirmed`
   when set), and Omarchy's "press any key" keeps the terminal open on it.
   Otherwise it attaches to the instance by the home the spawn answered,
   never by "the newest instance".

The task file goes on every path: withdrawn by step 1 when no terminal
claims it, and in step 2 once the spawn answers, in a `finally`,
on exit, and on SIGTERM, SIGINT or SIGHUP (then 128 + the signal). The
kernel runs in step 2's process group, so a signal the terminal sends
reaches it too, and a SIGTERM sent to step 2 alone is passed on. If step 2 is killed outright, the terminal's line removes
the directory after it (`terminalLine`). `test/spawn.test.mjs` covers each
of these, a hostile task included.

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
selector, input, notifier and floating terminal, `omarchy-shell` when a
test asks for it, `omarchy`, `systemctl`,
`ldconfig`, `tmux`, and a `Hyprland` whose `--verify-config` logs the
environment it got and refuses on cue) before a private directory of basic
tools, and `oats`
on PATH: a stand-in for the CLI that answers `status --json` and
`version --json` from files a test writes, `souls --json` from each
deployment's `souls.json`, and `spawn --json` by logging what it was given
(the task file's text and mode included). It can also be one that fails, an
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
  runs as a script in a `vm` context, and its search finding the rows by
  their aliases), and `bin/waiting.mjs` opening a session through the real
  floating terminal, as do the bar panel's row and the picker's agent and
  soul rows (the soul's task reaching the kernel as typed). Only the
  selector and the input are fakes: the real ones need a running Omarchy
  shell.
- `test/widget-qml.test.mjs` (as `ci`, with `OATS_OMARCHY_CONTAINER=1`) loads
  the bar widget and the picker in the container's Quickshell with
  `QT_QPA_PLATFORM=offscreen` (see "The bar widget" and "The OATS picker").

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
