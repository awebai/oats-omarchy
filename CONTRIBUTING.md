# Developing oats-omarchy

## Layout

The repository is the plugin: Omarchy clones it whole, and nothing is built.

```
manifest.json            the plugin's manifest: id ai.aweb.oats, a bar widget and an overlay
OatsBarWidget.qml        the bar widget: the OATS icon and its panel
OatsWaiting.qml          the overlay: the waiting popup (omarchy-shell shell summon ai.aweb.oats '{}')
WaitingWindow.qml        the popup's layer-shell window (a file of its own for the QML test)
WaitingCard.qml          one agent waiting on you, the card the panel and the popup both draw
widget.mjs               everything the widget and the popup build or read, kept apart so a test can run it
setup                    the command people run: a POSIX sh launcher
bin/setup.mjs            setup's engine, which the launcher and the post-update hook run
bin/waiting.mjs          the read of the panel and the popup (--json), and a selector of the agents waiting on you
bin/omarchy-launch-oats  the agent launcher: a POSIX sh launcher, like setup, that runs bin/launch.mjs
bin/launch.mjs           the launcher's engine: the steward's window, and the flow in it
bin/steward.mjs          setup's steward lookup (lookUpSteward), in a node of its own
bin/omarchy-install-oats the installer (POSIX sh, Omarchy's --check|--now contract): OATS on this machine,
                         then the onboarding agent
bin/install.mjs          the installer's node half: the steward line and the found-list handoff
lib/onboarding-prompt.txt the onboarding agent's prompt, with {{placeholders}}
docs/found-list.md       what the installer hands the onboarding agent (schemaVersion 1)
lib/                     their modules (below)
assets/                  the icon both launcher entries use
scripts/lint.mjs         lint
test/                    node:test suites; test/fixtures holds their inputs (with
                         test/fixtures/v0.3.0, v0.4.0, v0.5.0 and v0.6.0 those
                         versions' own blocks, for the upgrade, and
                         test/fixtures/omarchy-4.0.4 Omarchy's MenuModel.js and
                         the root of its menu, for the search,
                         from basecamp/omarchy's 4.0.4 release under its MIT
                         notice, LICENSE there),
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
- **Runtime code uses Node built-ins only.** The launchers (`setup`,
  `bin/omarchy-launch-oats`) and the installer (`bin/omarchy-install-oats`)
  are POSIX sh.
- **No file names a terminal emulator.** Terminal windows open through
  Omarchy's launchers (`omarchy-launch-tui`, `omarchy-launch-or-focus-tui`,
  `omarchy-launch-floating-terminal-with-presentation`), which run the user's
  default terminal through `xdg-terminal-exec`.
  `test/no-terminal-names.test.mjs` scans every file and holds the list.
- **The README's pin command works as written.** `omarchy plugin update`
  runs `git fetch origin HEAD` and a fast-forward, which bring no tags, so
  the command fetches the release's tag before it checks it out.
  `test/pin-release.test.mjs` replays Omarchy's add and update with real
  git and runs the README's command, the same one everywhere it appears.

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
  PATH: the shim (node and CLI), the bar widget's read (node and
  `bin/waiting.mjs`), the post-update hook (node and `bin/setup.mjs
  --check`) and the launcher (node and `bin/launch.mjs`), which the agent
  key binds by its own absolute path. `--check` reports any of them gone or
  moved. It also finds the Omarchy launchers on the
  session's PATH (`systemctl --user show-environment`, else the process
  PATH), the Hyprland layout, the Desktop (a flag, an existing launcher
  entry, then an AppImage; its standard install is
  `~/.local/opt/oats-desktop/OATS-Desktop.AppImage` with an entry whose
  Exec runs it, and an entry that runs an AppImage, by path or by name on
  PATH, is treated as one, so without FUSE the key and the menu extract and
  run it), FUSE, and the bindings
  `omarchy menu keybindings --print` reports.
- `lib/keys.mjs` turns that report into the key and its snippet. The
  SUPER + O submap binds T and D (each only when that part applies) and O
  (Omarchy's pop-out), each also with SUPER held. It also has the agent
  key's lines (`agentLua`, and `agentConf` for the hyprlang snippet):
  `hl.unbind` of SUPER + SHIFT + CTRL + A, which Omarchy binds to
  `omarchy-agent --pick` ("Agent"), and a bind described "OATS agent" to
  the launcher; `agentBindLine` is that bind line alone.
- The launcher part writes `~/.local/bin/omarchy-launch-oats`
  (`discover.paths` `wrapper`; `files.launcher`, mode 0755), which is on
  Omarchy's session PATH after `/usr/share/omarchy/bin`, so its name never
  shadows one of Omarchy's. Unlike the shim and the entries, a file or link
  there that setup has no record of is never backed up or replaced: the part
  is skipped with the reason (`launcherCheck`). One that appears while setup
  checks the config makes `--apply` refuse (`E_CHANGED`), and the write
  links the file into place (`atomicCreate` in `lib/state.mjs`), which fails
  rather than replace anything there. A missing `~/.local/bin` is
  created and recorded like any directory setup creates, so `--remove`
  deletes it only when it is empty. The launcher goes only with the shim: it
  is ready only when the shim part is, so the agent key's lines are written
  only when something calls the shim (another part, or the submap's lines).
- The installer part writes `~/.local/bin/omarchy-install-oats`
  (`discover.paths` `installer`; `files.installer`, mode 0755) the same way,
  through the same check (`wrapperCheck`, which `launcherCheck` calls for the
  launcher): never over a file or link setup did not write, created only
  where nothing is. It runs the plugin's `bin/omarchy-install-oats`, which
  is sh, so it calls neither node nor the shim, and goes with any CLI setup
  accepts. `--check` reports it as new in a full setup state applied
  before it existed (`fullState`, with the shim and no installer), unless
  something setup did not write holds the path; `--only agent-key` alone
  never writes it, and its state does not expect it.
- The agent key's owner, `oats` or `omarchy` (`chooseAgentKey`), is
  `--agent-key`, else the one the state records as `agentKey`, else none
  (null). It moves only on an explicit pick: with none, `--apply` in a
  terminal asks (`AGENT_QUESTION`, Enter is OATS; `askAgentKeyFirst`) after
  the UI question, `--yes` or not; without a terminal it asks nothing,
  refuses nothing and leaves the key with Omarchy (the part's reason is
  `NOT_CHOSEN`). An `--agent-key` other than `oats` or `omarchy`, or one
  with `--check` or `--remove`, is `E_BAD_ARGS`. The state always records
  `agentKey`, and a new choice alone still rewrites it. `--plan` shows the
  choice and where it came from under "Agent key", with its lines when OATS
  is picked. One gate in `desiredParts` decides whether a choice of OATS
  moves the key, in order: the launcher part, then the steward, then the
  shim. The steward is `findSteward` (`lib/steward.mjs`), which must find
  exactly one; `stewardOf` reads it for the Lua layout only, once per run
  (memoized on the probe, as an interactive `--apply` plans more than
  once), never in `--check`. It runs in a node of its own, since
  `findSteward` is asynchronous and setup is not, through a temporary shim
  with the bytes of setup's, which a first `--apply` has not written yet;
  without the list it reads the deployment setup is applying for. It
  answers within `STEWARD_BUDGET` (`lookUpSteward`) however many
  deployments there are: at the budget the node stops itself with SIGTERM,
  on which the kernel read kills its process group, and setup's own
  deadline sends SIGTERM too, never SIGKILL, so no kernel is left running. Without
  a steward the agent-key part is skipped with findSteward's reason and the
  choice stays recorded. A key already moved keeps its lines, and the plan
  notes that no steward was found.
- `--only agent-key` (`ONLY`; with `--plan` or `--apply`) plans only what
  the agent key needs: the shim, the launcher and the key block's agent-key
  section (`desiredOnly`, which `desiredParts` hands over to). It implies
  `--agent-key oats` unless `--agent-key omarchy` gives the key back, and
  any other value, `--check`, `--remove`, `--ui` or `--desktop` with it is
  `E_BAD_ARGS`. Its text output opens with `AGENT_WHY`, the one sentence of
  why, when the key goes to OATS. An `--apply` that leaves the key with OATS,
  narrowed or full, ends with `tryAgentKey`: the key, or the launcher under
  `setsid`, since `hyprctl dispatch exec` is a Lua error under Omarchy's
  Lua config. The agent key goes through the same gate and checks as in a
  full apply (`agentGate`: the launcher, then the steward; then
  `agentKeyRefusal`, and Hyprland on the whole candidate after the
  confirmation). Over a full setup applied for this computer's list, with
  an OATS CLI that no longer keeps one, the gate fails (`blocked`): the
  launcher reads the state, which then names no deployment, so a full
  `--apply` must switch it first. The submap section is passed to
  `keysEdit` as not wanted, so a recorded one stays byte for byte and an
  absent one stays absent. The block's file stays with the "keys" part,
  which the plan does not show (`hidden`). Nothing else is planned: no
  entries, hook, menu, `plugin.json` or cache refresh, and no UI question
  or `E_UI_REQUIRED`. The shim and the launcher are written whether or not
  the key moves now (a printed snippet runs the launcher too), except when
  the key is given back, which leaves them as they are. The plan says so
  under `ONLY_HEADING`. What it records (`onlyRecord`) comes from the files
  that hold it. Over a full setup (`fullState`: a part outside
  `ONLY_PARTS` recorded) it keeps the deployment, node, plugin directory,
  Desktop and default UI the state records, which the other files were
  written from, so `--check` rebuilds them unchanged. Over its own work
  alone, or no state, the deployment is the one found (the launcher reads
  it). The node and the OATS CLI are the shim's, the node and the plugin
  directory the launcher's: recorded from what it plans there, and kept as
  recorded when it leaves the file alone (a give-back). The state alone is
  rewritten when that record changes, with no file to write. It adds its
  parts to those recorded. `--check`
  expects `plugin.json` only over a full setup, since a narrowed apply
  alone leaves the bar icon offering setup. A later full `--apply` finds the
  shim and the launcher recorded and current.
- The default UI, `tui` or `desktop` (`chooseUi` in `lib/setup.mjs`), is
  what the menu's root row "OATS" and a right click on the bar icon open.
  With one of the two set up it is that one. With both it is `--ui`, else
  the one the state records, else none is chosen (`pending`): `--plan` says
  so, `--apply` in a terminal asks (`UI_QUESTION`, Enter is the TUI;
  `askUiFirst`) before anything else, `--yes` or not, since `--yes` answers
  only "Apply it?", and without a terminal it refuses with `E_UI_REQUIRED`,
  naming `--ui` (and `--yes` when it is missing too). A `--ui` naming one
  that is not set up is `E_UI`, with why. The state records the choice as
  `ui` (`chosen`): the `--ui` or the answer, else the choice recorded
  before, kept while only one is set up, so finding the other later does
  not undo it; a `--ui` that changes only the state still writes it. A
  state from before 0.5.0 has none, and with both set up `--check` reports
  "default UI not chosen".
- `lib/bindings.mjs` is the key block: Lua between marker comments,
  appended to the end of `~/.config/hypr/bindings.lua` after a blank line.
  It has up to two sections, the SUPER + O submap and then the agent key's
  lines (which start with `AGENT_START`); `composeBlock` joins them,
  `sections` splits a recorded block. Setup writes it only for the Lua
  layout, and checks each section on its own (`keysEdit`): the submap only
  when every effective SUPER + O action (from `--print`) is Omarchy's stock
  pop-out, the user's `bindings.lua` does not bind SUPER + O, and no user
  submap is named `oats` (`keysRefusal`); the agent key only when it is
  picked, the launcher part is ready, every effective SUPER + SHIFT + CTRL +
  A action is Omarchy's stock "Agent", and the user's `bindings.lua`
  neither binds nor unbinds it (`agentKeyRefusal`, which mirrors
  `keysRefusal`; both find the user's own call with `bindsCombo`). A
  re-apply that changes a section checks the same things outside the
  block, allowing only what the block itself binds ("OATS agent" for the
  agent key); a section the recorded block holds unchanged is not checked
  again. A section that fails is skipped alone with the reason, and its
  snippet is printed; the other is still written. A recorded section whose
  update fails stays as it was recorded. When the agent key is given back
  (`--agent-key omarchy`) its section is dropped, with or without a usable
  OATS CLI (the submap's lines then stay as they are), and a block left empty is
  taken out the way `--remove` takes it out (the backup back whole, else
  the block's bytes alone), its record dropped and its backup deleted once
  the state is written. Hyprland verifies the whole candidate file, both
  sections, after the confirmation; a removal is not verified. The file is
  backed up whole. `--remove` restores the backup only
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
  `E_CONFIRM` unless `--yes` is given, as `omarchy plugin add` does. Setup
  cannot tell an agent from a person and does not try: the README tells
  coding agents never to apply or remove, and to give the person the
  command instead.
- `lib/files.mjs` renders each file (the shim, the launcher entries, the
  post-update hook, the bar widget's `plugin.json`); `lib/desktop-entry.mjs`
  reads and writes desktop entries.
- `plugin.json`, beside the state (`$XDG_STATE_HOME/oats-omarchy`), is what
  the bar widget and the popup run: `{deployment, tui, desktop, ui, waiting,
  attach, setup}`, each an argv from the same functions the key and the menu
  use (`tui` and `desktop` null when that part is not applied; `attach` ends
  at `--home`), and `ui` the default UI (null when neither is set up). A
  `plugin.json` from before 0.5.0 has no `ui`: `widget.mjs` `parsePlugin`
  reads it as the TUI, or the Desktop when only it is set up, and ignores
  v0.4.0's `agents` and `spawn`.
  It is written on every `--apply` that applies the shim, rewritten when it
  differs, removed by a complete `--remove`, and `--check` reports it
  missing. The detach key goes into `attach` when the CLI's `version --json`
  lists `session-attach-detach-key`, so a re-apply picks up a CLI that
  gained it.
- `lib/menu.mjs` is the menu block: one root row, `oats-ui`, labelled OATS,
  which runs the default UI's launch command, and the Default Agent row,
  `setup.default.agent.oats` (`AGENT_ID`), labelled OATS, which Omarchy puts
  under its own Setup > Defaults > Agent by its dotted id. That row is there
  whenever the block is, whoever has the agent key, since it is where the
  person picks OATS. Its `checked` (`agentChecked`) is a `grep -qxF` of
  `agentBindLine` in `bindings.lua`: it reads the file Hyprland loads, so it
  cannot disagree with the live binding, and a block changed by hand is
  what `--check` reports, since setup records the block's bytes. Its action
  (`agentPick`) runs `setup --apply --agent-key oats --only agent-key`, by
  the recorded node and plugin, in
  `omarchy-launch-floating-terminal-with-presentation`, where the plan shows
  and setup asks, and then the launcher only when that check passes. Picking
  OATS there never touches SUPER + O, the entries, the menu or the hook. Both ids are in `IDS`, so a user's own row with one of them
  is refused. With neither UI set up there is no block, and the menu part
  is skipped. Omarchy 4.0.4's search
  (`MenuModel.js` `searchScore`) ranks an exact label at the root above any
  other match, and `Menu.qml` lists root rows before deeper ones, the app
  launchers among those. The launcher entries are named OATS TUI and OATS
  Desktop (`TUI_NAME` and `DESKTOP_NAME` in `lib/files.mjs`), so the
  default UI's row is the only one labelled OATS, and it comes first.
  `test/menu-search.test.mjs` ranks the block with Omarchy's own
  `MenuModel.js` (basecamp/omarchy's 4.0.4 release,
  `shell/plugins/menu/MenuModel.js`, vendored unchanged with Omarchy's MIT
  notice in `test/fixtures/omarchy-4.0.4/LICENSE`, pinned by digest) and the
  root of its menu (derived from `default/omarchy/omarchy-menu.jsonc` there)
  (`test/helpers/omarchy-search.mjs` holds `Menu.qml`'s steps), and the
  container test with the real Omarchy's whole menu. It is a delimited
  block in the user's
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
  a block another version wrote (v0.3.0's, v0.5.0's and v0.6.0's menu,
  v0.4.0's menu and key block) is reported as "from another version of
  setup: run setup --apply again". So is the TUI's launcher entry, rebuilt
  the same way, which v0.3.0 to v0.5.0 named OATS. A recorded key block
  made of this version's sections, either one or both, is not: a section
  skipped by its checks is not drift. A state with no `agentKey` (v0.6.0
  and older) gets one more line, that the launcher and the agent key are
  new in this version and not applied yet, and that the agent key stays
  with Omarchy until the person picks OATS. Setup's lines for the agent key
  still in the block while the state gives the key to Omarchy are reported
  too. `--apply` then swaps only those
  blocks, a key block verified as a new one is, and rewrites the entry.
  v0.6.0's key block is this version's SUPER + O section alone, so without
  `--agent-key` it stays as it is. `test/upgrade.test.mjs` starts from
  v0.3.0's, v0.4.0's, v0.5.0's and v0.6.0's own blocks and entry
  (`test/fixtures/v0.3.0`, `v0.4.0`, `v0.5.0` and `v0.6.0`).
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

`bin/waiting.mjs --dir <deployment>` (`lib/waiting.mjs`) is a selector of the
agents waiting on you, which v0.5.0's menu ran when the popup could not open
(no menu row runs it now), for one deployment
(`--list` below is the other). Through setup's shim, it reads `oats status --json` for
the deployment, shows the instances
waiting on you in `omarchy-menu-select` (the count and the names, nothing
else), and opens the chosen one's `oats session attach` in
`omarchy-launch-floating-terminal-with-presentation`, with `--detach-key
'C-\'` (Ctrl+\, the kernel's suggested key; `DETACH_KEY`, which the
launcher uses too) when the kernel lists `session-attach-detach-key`.
The panel's and the popup's hint names the key `plugin.json` records
(`widget.mjs` `detachHint`), so a `plugin.json` from before the key changed
says Alt+O until setup is applied again. With nothing to pick it
does not open the selector, which refuses to open empty; it sends
`omarchy-notification-send` instead, or writes to stderr without it.

A row waits on you when its `waitingOnYou` is set. A null there means the
kernel makes no claim about that row, not that it is not waiting: nothing
here says that nobody is waiting. Only a status that could not be read is
unknown. `--json` prints what it read and opens nothing: `{ok, count,
rows: [{instance, home, waitingOnYou}]}` (`waitingOnYou` the kernel's
`since`, `producer`, `reason` and `message`, each a string or null, as
given), or `{ok: false, reason}` with one bounded line (the kernel's first,
when `oats status` failed). It is the only source of the bar widget and the
popup; the filter lives here alone. With `--json` the kernel's read runs in
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
gains or loses the list, and `--apply` switches either way. Without a
usable CLI setup cannot tell, so one applied for the list stays applied for
it (unless `--dir` names a deployment): giving the agent key back, for one,
needs no CLI. Setup reads the
list (`lib/deployments.mjs`, `deploymentsApi: 1`, each row's path, name and
state) only for the plan's notes; the plugin never writes it.

`waiting --list` reads `oats deployments --json`, then `oats status --json
--dir <path>` for each row whose state is `ok`, one after another, never two
at once: each read within 25 s with `--json` (30 s for the selector), and all of
them within 110 s (`LIST_BUDGET`); a
deployment not reached in time is not read. Every one of these reads, the
selector's and `bin/status.mjs`'s (`statusEvery`) included, runs
in a process group of its own, killed with it, as for `--json` above.
`--list --json` prints `{ok, count, rows: [{instance, home, waitingOnYou,
deployment, workspace}], deployments: [{path, name, workspace, ok, reason?}], note?}`.
A deployment that could not be read is unknown on its own (`ok: false` with
its reason) and the others still count; `ok` is false only when the list
could not be read or no deployment could, and `note` says how to fill an
empty list.

### The agent launcher

`bin/omarchy-launch-oats` runs `bin/launch.mjs` (`lib/launch.mjs`) with the
same node lookup as `setup`. Without a node it says so on stderr and with
`omarchy-notification-send` (else `notify-send`) when either is on PATH.

- **The outer process only opens the window.** It checks that setup's shim
  is there and that `omarchy-launch-tui` is on PATH, and makes the handoff:
  a private directory (0700) under `$XDG_RUNTIME_DIR` (else the temporary
  directory) that holds the prompt, if any. Then it starts
  `omarchy-launch-tui --app-id=org.omarchy.agent <node> <plugin>/bin/launch.mjs
  --in-terminal --claim-file <handoff>/claim [--prompt-file
  <handoff>/prompt]` on its own, detached, with its own output as an exec
  would give it.
  - Neither the launcher's running nor its exit says that a window opened.
    uwsm-app keeps it in the foreground while the window is open, or hands
    the window to a service and ends with 0.
  - Exactly one side claims the handoff, by creating `claim` with O_EXCL
    (`claim`). The window claims it when it starts. The launch claims it
    when the launcher fails or is signalled, or when no claim comes within
    `WINDOW_START` (30 s).
  - The window's claim is the launch's evidence that it started. It makes
    the prompt the window's, and the window removes the handoff.
  - The launch's claim means no window can send the prompt. The launch
    then removes the handoff and reports the failure on stderr and in an
    Omarchy notification.
  - A claim that is already there, or a handoff already gone, is the other
    side's.
- **The window runs the flow** (`inTerminal`), so a failure shows where the
  person is looking: one line naming the step, then it waits for Enter. The
  steps are `version --json`, `findSteward`, `session start --home H
  --json` (success or `E_SESSION_RUNNING` both count as started), the
  prompt, then `session attach`. Enter is read straight from fd 0
  (`waitForEnter`), leaving the terminal as it was for the attach.
- **Every kernel call** goes through setup's shim (`discover.paths().shim`)
  and runs in `waiting.mjs` `statusRead`, bounded, in a process group of
  its own that is killed with it (`TIMEOUTS`). The exception is the
  attach, which owns the terminal.
- **The attach and `--inline`'s `omarchy-agent` run through `runChild`.**
  Node cannot exec, so `runChild` gives the child the terminal. It ignores
  SIGINT and SIGQUIT, which the terminal sends the child itself. It passes
  SIGTERM and SIGHUP on. `bin/launch.mjs` `exit` then exits with the
  child's status, or raises the child's signal again.
- **`lib/steward.mjs` `findSteward`** is the only code that knows how to
  find the steward. It reads every `ok` deployment of `oats deployments
  --json`, or without `deployments-list` the deployment setup's state
  records. For each one it runs `oats status --json`, with that deployment
  as the working directory. The steward is an instance of the steward
  soul's agent (`isStewardAgent`): the agent row whose `key` is
  `STEWARD_KEY`, `oats.machine/steward` (desktop-cli-api's key on soul and
  agent rows); a row without a key is matched by its name, `STEWARD_AGENT`,
  `oats-machine--steward`, the name the kernel's `packageSoulAgentName`
  gives that soul. Exactly one is
  used. With several, they are listed and none is picked. With none, the
  line says how to spawn one. A deployment that cannot be read is named
  (`unread`, printed in the window, or in the reason), and never hides a
  steward found in another.
  - The launcher passes `recordedFirst`: with the list, the deployment
    setup's state records (`--dir`) is read first, and when its status lists
    exactly one steward that one is used, with no list read and no other
    status read. Anything else falls back to the full scan, which reuses
    that read. The fast path can miss a second steward in another
    deployment; setup's agent-key gate (one steward per machine) and the
    README make that acceptable. Setup's own lookup always scans.
- **The prompt** (`--prompt`) travels in a 0600 file in the handoff,
  passed as `--prompt-file`. It never goes in argv, which uwsm writes to the journal.
  The window reads the file and deletes it first. `deliverPrompt` then:
  - checks that the kernel lists `session-inspect-running` and
    `waiting-on-you`, and sends nothing otherwise;
  - polls `session inspect --home H --json` until `running`, at most once
    a second and at most 20 s in all. Each read is bounded by what is left
    of the 20 s, and an answer after it is not taken. A failed read (an
    error envelope, a non-zero exit, a read that timed out) is tried again
    after the poll interval until the 20 s are up, which then name the last
    failure. That last read is the fresh `waitingOnYou`;
  - sends nothing to a steward waiting on the person, because a pasted
    Enter could answer its prompt;
  - otherwise pipes the text to `session input --home H --json` on stdin
    (`--text-file -` would be a file named `-`).

  The answer is reported as given, and an input is never sent again.
  `--inline` passes the prompt to `omarchy-agent` as one argv element.

### The installer

`bin/omarchy-install-oats` makes an Omarchy machine an OATS machine, with
the contract of Omarchy's own agent installers: `--check` exits 0 only when
OATS is ready, `--now` installs, and the `omarchy:` header comments describe
it. It is POSIX sh, because it runs before node may exist; node does only
what needs it, through `bin/install.mjs` (`lib/install.mjs`): the steward
line (`findSteward` through the `oats` it found, since setup's shim does
not exist yet), whether the agent key opens OATS (`agentKeyMoved`, and
`agentKeyResult` for setup's answer) and the handoff.

- **The consent screen** (`consent`), after the harness is known and before
  anything is installed. The person's own acts, which Claude's auto mode
  refuses an agent, are listed together, each with why, what and its undo
  on a line of its own, and one `[y/N]` that only an explicit `y` answers:
  - the GitHub sign-in, unless `github_state` finds gh signed in to
    github.com with every scope in `GH_SCOPES`. It reads `gh auth status
    --json hosts --jq …` (gh 2.81.0 and later, `GH_MIN`), so it needs no
    node;
  - the agent key, unless `key_moved` finds it with OATS: setup's state
    records `agentKey: "oats"` and `bindings.lua` holds `agentBindLine`, as
    the Default Agent row's `checked` reads it. Without node setup has never
    run, so it is on the screen.

  An act already done is left off; with none, there is no screen.
- **The acts** run as the person, in their terminal, after the tools:
  - step 6 (`github`): `gh auth login --web --scopes $GH_SCOPES`, or `gh
    auth refresh --scopes` with only the missing ones, then `gh auth
    setup-git`, each with stdin from `/dev/null`. Without a terminal gh asks
    nothing (no protocol, no "Authenticate Git", no Enter; cli/cli
    `pkg/cmd/auth/shared/login_flow.go`): it prints the one-time code and
    waits for the approval. The installer opens the device page with
    `xdg-open`, then reads the sign-in back;
  - step 7 (`agent_key`): `setup --apply --only agent-key --agent-key oats
    --steward-pending --yes --json`, before onboarding spawns the steward.
    A key setup leaves with Omarchy is said, and onboarding still starts.
  - The onboarding prompt states what they did (`consentFacts`), never the
    person's consent: an agent passing a yes on is refused as an auto-mode
    bypass, and the prompt test holds that it never says "consent".

- **Found first.** `detect` resolves each tool on PATH (`readlink -f`; a
  mise shim through `mise which`), names its origin from the resolved path
  (`origin_of`: mise's npm installs are under `node_modules` too, so they
  are told apart first), and asks its version without running anything
  else. A tool at or above its minimum is used as it is; one below stops
  the run with `upgrade_of`'s command for its origin (an npm install under
  another prefix than `npm prefix -g` gets `--prefix`). Nothing is replaced,
  and nothing is installed in front of the person's own copy. Only a missing
  tool is installed: with `mise use -g`, and tmux with `omarchy-pkg-add`.
- **Omarchy's lazy wrappers.** `~/.local/bin/{claude,codex,pi}` may be
  Omarchy's wrapper, which runs `mise use -g` on first use. `user_install`
  is omarchy-default-agent's rule for telling it from the person's own
  install; a wrapper counts only when mise has the agent, and it is never
  run.
- **An instance's shim** (`*/.oats/bin/oats`) is not the CLI, on PATH or
  behind a link: the installer refuses it without running it, as setup
  does.
- **Claude's channel plugin** is read from `claude plugin list --json`,
  run in `~/Work` (in HOME before `~/Work` exists), since `enabled` is the
  merged settings of the directory claude runs in; then node
  (`channelState`) picks the copy that applies: a user-scoped one counts, a project or local one
  only when it is `~/Work`'s, since the list names other projects' copies
  too. A disabled copy stops the run with the command that enables it; it
  is never enabled or installed over.
- **The handoff.** `--now`'s last step writes the found-list
  (`docs/found-list.md`; a deployment whose status cannot be read stops
  it, so a `steward: false` is never a guess; a deployment that is not `ok` has
  `steward: null`) and prints the prompt: `lib/onboarding-prompt.txt`
  with its placeholders filled (`renderPrompt`). The prompt states facts
  only (the skill, the harness, the plugin, the found-list); the bootstrap's
  steps are getting-started's, and the test holds a list of command names it
  must not contain. `aw whoami` runs in `~/Work` only when `~/Work/.aw`
  exists, without any `AWEB_*` or `AW_*` variable, so an agent session's own
  identity never answers for it. The harness then replaces the installer
  (`exec`) in `~/Work`, the prompt one argv element, with
  `omarchy-agent`'s unattended flags.
- **No terminal.** From the menu or a key, `--now` runs itself again in
  Omarchy's floating terminal, marked with `OMARCHY_INSTALL_OATS_TERMINAL=1`
  (which the tests set to run inline). Without `--harness` there it is
  refused first, since nobody can be asked.
- **The bar icon.** Before setup has run, the icon's set-up line
  (`widget.mjs` `setupCommand`) asks `--check` first, inside the line, so it
  runs once per click and never otherwise, and runs the installer instead of
  setup when it fails.

`test/install.test.mjs` runs the installer on a temporary machine: a HOME,
XDG directories and a PATH of stand-ins laid out the way each origin is
(mise installs and its shims, an npm prefix, `~/.local/bin`, nvm, a link
into `/usr`, an instance's shim), each logging what it was asked and
modelling refusals. The stand-in `mise use -g` lays out an install only
when it runs. gh's stand-in answers `auth status --json` from a file and
signs in as `auth login` and `auth refresh` would, logging whether stdin
was a terminal. `ALL` leaves both of the person's acts done, so a test sees
the consent screen only when it undoes one; the screen's tests run a copy
of the plugin whose `bin/setup.mjs` logs its argv, so no real setup runs
there (setup's `--steward-pending` is `test/agent-key.test.mjs`'s). No
real install, mise, gh or harness runs.

### The bar widget and the waiting popup

`OatsBarWidget.qml` and `OatsWaiting.qml` display; `widget.mjs` decides.
Both draw an agent waiting on you with `WaitingCard.qml`: its name, the
kernel's message, then reason, producer and age, as given (`widget.mjs`
`card`, its age worked out once, when the read answered; nothing ticks),
and the exact `since` in its tooltip. The popup is the plugin's overlay,
in the shape of Omarchy's own pickers and its `[menu]` theme: the panel's
read (`plugin.json`'s `waiting` argv plus `--json`), run when it opens, with
one Quickshell `Process` and the read's deadline as its only `Timer`, which
does not repeat; its cards in one list (`popupRows`, each group's title as
the list's section; `popupNotes` the deployments not read), Up/Down or
Ctrl+J/K, Enter running `attachArgv` through Omarchy's `Util.execArgv` (no
shell), Esc closing it. With no `plugin.json` it offers setup only; with
nothing waiting it says "No agent has said it is waiting on you", which
claims nothing about the others.

The bar widget's QML reads
`plugin.json` (Quickshell's `FileView`), runs the panel's read (`plugin.json`'s
`waiting` argv plus `--json`) as argv through one Quickshell `Process`, and
hands every other command to the bar's `run`, which runs `bash -lc <line>`:
`widget.mjs` builds those lines from `plugin.json`'s argv, every word
single-quoted, and quotes them again for the floating terminal's `bash -c`.
`test/widget.test.mjs` runs each line through bash with stand-ins that log
their argv. `test/widget-qml.test.mjs` loads the widget and the popup
themselves in Quickshell, offscreen, with Omarchy's own `Ui` and `Commons`
and stand-ins only for their layer-shell windows (`KeyboardPanel` and
`WaitingWindow`, which need a compositor): the layout with more rows than
fit, the cards, a `plugin.json` change, a destroy during a read, a program
that cannot start, that nothing is read before the panel or the popup
opens, and the popup's keys. It runs in CI's Omarchy container. Nothing
there is started: the bar's `run` and the popup's argv runner log what
they were given. The icon shows no count. With the
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

The launcher's tests (`test/launch.test.mjs`, `test/steward.test.mjs`) put
setup's shim in front of `test/helpers/fake-kernel.mjs`, a stand-in for the
CLI. It logs every call with its argv, working directory and the bytes
`session input` read. It answers in the kernel's envelopes, and each
command can be set to fail, to answer `E_SESSION_RUNNING`, or to hang with a
child of its own. Its `status --json` and `deployments --json` come from
`test/fixtures/steward`, trimmed from a real 0.67.1 CLI's output with the
field names kept. A stand-in `omarchy-launch-tui` logs its argv, or runs the
window's command for the end-to-end test. Nothing starts a terminal, the
TUI, a harness or a real session.

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
  block written, refused and removed with the real Hyprland, the block with
  each of its sections alone and both, the agent key picked, given back and
  removed with `bindings.lua` checked byte for byte, `--only agent-key` on
  a fresh home and over a full setup (SUPER + O's section, the menu, the
  hook and the entry byte for byte), Omarchy's
  own `MenuModel.js` reading the menu block (it is plain functions, so it
  runs as a script in a `vm` context), the Default Agent row under
  Omarchy's real Setup > Defaults > Agent included, and ranking the
  default UI's row first in a search over its whole menu, and `bin/waiting.mjs` opening a
  session through the real floating terminal, as does the bar panel's row.
  Only the selector is a fake: the real one needs a running Omarchy shell.
- `test/widget-qml.test.mjs` (as `ci`, with `OATS_OMARCHY_CONTAINER=1`) loads
  the bar widget and the popup in the container's Quickshell with
  `QT_QPA_PLATFORM=offscreen` (see "The bar widget and the waiting popup").

Installing `omarchy` in a container works as it is: Limine's post-transaction
hooks report that there is no FAT32 boot partition, which pacman treats as
non-fatal.

A running Hyprland is not available there. Without a DRM device, or a parent
Wayland compositor with a GPU render node, Hyprland stops at start
(`CBackend::create() failed!`), and its headless backend is only a fallback
beside those. So nothing that needs `hyprctl` (for example
`omarchy menu keybindings --print`) runs against a live Hyprland in CI.
Tests serve `--print` from captured output in `test/fixtures/print/`, taken
from a machine with Omarchy's default bindings. That output does not change
when setup writes its block, so CI cannot read back from `--print` that the
agent key runs "OATS agent", or "Agent" again once it is given back: the
container test checks the block's bytes and `--verify-config` instead.

## Testing on a desktop machine

Tests and manual runs never touch a real desktop configuration. Omarchy's
menu and its hook runner read `$HOME/.config/...` and ignore
`XDG_CONFIG_HOME`. So every run sets `HOME` to a temporary directory, together
with `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`.
