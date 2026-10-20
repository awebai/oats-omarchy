# oats-omarchy

An [Omarchy](https://omarchy.org) plugin that makes
[OATS](https://github.com/awebai/oats) feel native there. Both OATS clients,
the terminal UI (`oats tui`) and OATS Desktop, become Omarchy apps with a
launcher entry (**OATS TUI** and **OATS Desktop**), an icon and a key. You
choose a default UI, the TUI or the Desktop: typing "oats" in SUPER + SPACE
puts it first, as the row **OATS**, and a right click on the bar icon opens
it. The OATS icon in the bar opens a panel with a card for each agent
waiting on you, read when you open it. With an OATS CLI that keeps this computer's list of deployments (`oats deployments`),
all of that covers every listed deployment; with an older one, the one
deployment setup is applied for.

It is set up with one command, `setup --plan | --apply | --remove | --check`,
run from the plugin's directory. Setup finds what it needs on the machine
instead of assuming paths, and applies each part only where Omarchy offers
it. On Omarchy's Lua layout it writes the key, SUPER + O, into your
`bindings.lua` as a marked block, but only over Omarchy's stock binding and
only after Hyprland has checked a copy of your config with it. Otherwise it
prints the snippet for you to add. `--remove` restores exactly what was
there before.

## Installing with a coding agent

This section is written to you, the coding agent asked to install this
plugin. Follow the steps in order. Every command here is checked against
v0.6.0.

> **Never pass `--yes` to `setup --apply` or `setup --remove` until the
> person has said yes in the chat to what you showed them.** You have no
> terminal, so `setup` refuses to apply or remove without `--yes`. That flag
> stands in for the person's own answer to its `Apply it? [y/N]` question.
> The person's request to install the plugin is consent for step 3 only.

**1. Check the prerequisites.** Stop at the first one that fails, and tell the
person how to fix it. Don't install system packages yourself.

- **Omarchy:** `command -v omarchy` finds it. Without it, this plugin does
  not apply: it is for Omarchy only.
- **Node.js:** `node --version` runs. Without it, the person installs Node.js
  (for example with `mise use -g node`).
- **The OATS CLI, 0.53.0 or later:** `oats version --json` prints a
  `version` of at least `0.53.0`. (Setup checks the CLI itself, on the
  person's session PATH. If the plan's "oats CLI" line says it is refused,
  follow the fix it gives.)
  - `readlink -f "$(command -v oats)"` must end in
    `@awebai/oats/bin/oats.mjs`. If it ends in `mise`, the same must hold for
    `readlink -f "$(mise which oats)"`.
  - A wrapper script, or an agent's own `.oats/bin/oats`, is not the CLI:
    setup runs the CLI with node directly and records its path.
  - Fix: `npm install -g @awebai/oats`.
- **tmux:** `command -v tmux` finds it. The TUI and attaching to an agent
  need it. Fix: the person runs `sudo pacman -S tmux`.

**2. The deployments.** Setup uses this computer's list of deployments
when two things hold:
- `oats version --json` lists the feature `deployments-list`;
- the plugin you install has the list: after step 3,
  `~/.config/omarchy/plugins/ai.aweb.oats/setup --help` mentions
  `oats deployments` (from v0.3.0). An older pin does not, so with one,
  ask for the deployment as below.

With both, setup needs no deployment, and you pass no `--dir` in the steps
below.
- Show the person `oats deployments`. The kernel adds a deployment to it
  whenever any `oats` command runs in it.
- If one they use is missing, they run `oats deployments add <path>` (or
  you do, once they agree). Setup never writes the list.

Otherwise, ask for the deployment: the directory that directly holds
`oats-local.yaml`.
- Ask the person which directory it is, unless they have already named it.
- If the current directory or one of its parents holds `oats-local.yaml`,
  offer that directory as a suggestion for them to confirm, never as a
  default.
- Never guess.
- Check that the directory holds a regular `oats-local.yaml` before you
  pass it as `--dir`.

**3. Add the plugin.** First tell the person what Omarchy's installer would
warn them, since `--yes` skips that warning: plugins run as unsandboxed code
inside the Omarchy shell, so add only repos they trust. If they hesitate,
don't run it.

```bash
omarchy plugin add https://github.com/awebai/oats-omarchy --enable --yes
```

This clones the default branch into
`~/.config/omarchy/plugins/ai.aweb.oats/`. `--enable` loads the plugin's bar
icon into the Omarchy shell at once; it runs no setup. `--yes` is needed
because you have no terminal, and the person's request to install the plugin
is their consent to it.

To install the released v0.6.0 rather than the tip of the default branch,
pin it before the shell loads it. Add the plugin without `--enable`, check
out the tag, then enable it:

```bash
omarchy plugin add https://github.com/awebai/oats-omarchy --yes
git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout v0.6.0
omarchy plugin enable ai.aweb.oats
```

**4. Ask which UI opens first.** Typing "oats" in SUPER + SPACE shows the
default UI first, and a right click on the bar icon opens it. Check what
setup finds:

```bash
~/.config/omarchy/plugins/ai.aweb.oats/setup --plan --json --dir <deployment>
```

Its `result.ui.found` lists the UIs setup can open, `tui`, `desktop` or
both.
- **Both:** ask the person "Open which OATS first: TUI or Desktop?". The
  usual answer is the TUI. Pass the answer as `--ui tui` or `--ui desktop` in
  steps 5 and 6. Without `--ui`, `setup --apply` refuses here, since you have
  no terminal for it to ask in.
- **One:** that one is the default. Pass no `--ui`, and don't ask.
- **None:** there is no default UI, and no OATS row. The plan's parts say
  why.

**5. Show the plan.** Leave out `--dir <deployment>` here and in step 6
only when both checks in step 2 hold, and `--ui <ui>` when step 4 says so.

```bash
~/.config/omarchy/plugins/ai.aweb.oats/setup --plan --dir <deployment> --ui <ui>
```

It changes none of the person's files: to check the key block it only
works on a temporary copy, as below. Show the person the whole plan, and
point out:
- every file it will write, and any it replaces: the plan marks those
  "(replaces an existing file, backed up; --remove restores it)";
- the key change: SUPER + O becomes a prefix, and Omarchy's "pop window out"
  moves to SUPER + O, then O;
- the default UI, under "Default UI";
- that to check the key block, setup ran `Hyprland --verify-config` on a
  temporary copy of their Hyprland config, which runs their config's own
  commands (its `io.popen` calls), on the copy;
- any fixes it suggests, such as `sudo pacman -S fuse2`, for the person to
  run;
- with the list, its notes: that the list holds no deployment yet, or that a
  `--dir` you passed is not in it, and what to run.

Then ask whether to apply it.

**6. Apply, only after the person's yes in the chat.**

```bash
~/.config/omarchy/plugins/ai.aweb.oats/setup --apply --yes --dir <deployment> --ui <ui>
```

If they say no, or ask for changes, stop here: setup has written nothing.
The plugin itself stays installed unless they want it removed
(`omarchy plugin remove ai.aweb.oats --yes`, once they agree).

**7. Report.** Say what was applied and what was skipped, with the reasons
setup gives. If the plan printed the key snippet instead of writing it (for
example, SUPER + O was already bound to something of the person's), show
them the snippet and let them paste it into their Hyprland bindings
themselves.

**8. Tell the person how to look after it.** Here `setup` is
`~/.config/omarchy/plugins/ai.aweb.oats/setup`.
- **Check:** `setup --check` reports drift. Omarchy runs it after each
  `omarchy update`. When the OATS CLI gains the list of deployments, it says
  so: `setup --apply` again (without `--dir`) switches to it. After an
  upgrade from v0.3.0 or v0.4.0 it reports the menu (and v0.4.0's key block)
  as from another version of setup, and with both UIs "default UI not
  chosen": ask the person which UI, as in step 4, then `setup --apply --ui
  <ui>` once they agree.
- **Update:** `omarchy plugin update ai.aweb.oats`, then `setup --check`.
  Updating moves a pinned checkout to the tip of the default branch.
- **Pin a release:** `git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout <tag>`, for
  example `v0.6.0`. Pin again after any `omarchy plugin update`.
- **Remove:** `setup --remove` first, then `omarchy plugin remove ai.aweb.oats`.
  The other order leaves the launchers, the menu and the hook behind.

When you run any of these yourself, add `--yes` (you have no terminal) only
after the person has agreed in the chat. `setup --check` needs no `--yes`.

## Install

It needs Node.js and the OATS CLI (`npm install -g @awebai/oats`, 0.53.0 or
later) on your PATH. With an OATS CLI that keeps this computer's list of
deployments (`oats version --json` lists `deployments-list`), this plugin
(v0.3.0 or later) needs nothing else, and you leave out `--dir` below; with
an older one, setup is for one OATS deployment: the directory that holds
`oats-local.yaml`. `oats` on your PATH must be the installed CLI, the
package's `bin/oats.mjs` or the npm or mise link to it, not a wrapper
script: setup runs that script with node directly and records its path.

```bash
omarchy plugin add https://github.com/awebai/oats-omarchy --enable
~/.config/omarchy/plugins/ai.aweb.oats/setup --plan --dir <deployment>
~/.config/omarchy/plugins/ai.aweb.oats/setup --apply --dir <deployment>
```

With both the TUI and the Desktop set up and none chosen yet, `--apply`
asks "Open which OATS first: TUI or Desktop?" (Enter is the TUI), with
`--yes` too; `--ui tui` or `--ui desktop` answers it ahead, and without a
terminal `--ui` is required. With one set up, that one is the default. The
plan shows the choice under "Default UI", and a later `--apply` keeps it
until you pass another `--ui`, also when it was passed with one set up.

- **`omarchy plugin add`** clones this repository's default branch into
  `~/.config/omarchy/plugins/ai.aweb.oats/` and puts the OATS icon in your
  bar. It takes no tag. Without a terminal it needs `--yes`.
- **The OATS icon** reads nothing in the background and shows no count:
  nothing runs until you open its panel. A left click opens the panel, and
  a right click opens the default UI.
- **Before setup has run**, a click on the icon (its tooltip says "OATS:
  click to set up") runs the whole setup in a floating terminal: it asks for
  the deployment (not with the list), shows the plan and asks before
  applying it.
- **Its panel** (a left click, once setup has run) reads the agents waiting
  on you each time it opens, and says so while it reads. An agent is listed
  when the kernel says it is waiting on you; for the others the kernel makes
  no claim, so an empty list never means that nobody is waiting. When the
  read fails, the panel says why. Each agent is a card: its name, the
  kernel's message, then the reason, who reported it and how long it has
  waited, all as the kernel gives them (the exact time in its tooltip). A
  click on a card opens the agent's session in a floating terminal. The
  panel also has Open OATS TUI, Open OATS Desktop (when setup found one) and
  Set up keys and launchers, which runs `setup --apply` in a floating
  terminal.
- **SUPER + SPACE.** Type "oats" (or "o", "oa", "oat"): the first row is
  **OATS**, which opens the default UI, and the launchers **OATS TUI** and
  **OATS Desktop** follow. SUPER + O, then T or D, opens the TUI or the
  Desktop.
- **The waiting popup** shows the panel's cards, read when it opens:
  `omarchy-shell shell summon ai.aweb.oats '{}'` opens it, for a key of
  your own. Up and Down (or Ctrl+J and Ctrl+K) move, Enter opens the
  agent's session, Esc closes.
- **With the list,** the panel reads every listed deployment, one after
  another (each `oats status --json` within 25 seconds, all of them within
  110), and groups the agents by workspace when there is more than one. A
  deployment that could not be read is shown as such, and the others are
  still listed. The TUI and the Desktop open on their own list of
  deployments.
- **Alt+O.** While you're attached to an agent from the panel or the popup,
  Alt+O leaves the viewer, so it never reaches a harness that binds Alt+O
  itself. It needs an OATS CLI with a detach key (`oats version --json`
  lists `session-attach-detach-key`).
- **Finding the deployment.** With the list, setup is for every listed
  deployment and needs none: `--dir` only checks that a deployment is
  listed, and an empty list makes the plan say how to fill it (run any
  `oats` command in a deployment, or `oats deployments add <path>`).
  Without it, setup takes `--dir`, else the deployment around the working
  directory, else the one it is applied for. With none of those, in a
  terminal, it asks for the path of your deployment.
- **`setup --plan`** says what `--apply` would write and what it found.
  `--apply` shows the plan again and asks before writing (`--yes` skips the
  question; without a terminal it is required). When the plan says the key is
  not written, paste the snippet it prints into your Hyprland bindings.
- **Checking the key.** Before writing the key, `--plan` and `--apply` run
  `Hyprland --verify-config` on a temporary copy of your Hyprland config with
  the block added. That runs your config's own commands (its `io.popen`
  calls), on the copy.
- **`setup --check`** reports drift. Omarchy also runs it after each
  `omarchy update`.

**Pinning a release.** The plugin is a plain git checkout:
`git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout <tag>`. `omarchy plugin
update` fast-forwards it to the tip of the default branch, so pin again after
an update.

**Removing it.** Run `setup --remove` first: it restores everything setup
wrote. Then run `omarchy plugin remove ai.aweb.oats`. The launchers, menu and
hook point into the plugin's directory, so removing the plugin first leaves
them behind. The hook then says so, and adding the plugin again and running
`setup --remove` cleans up.

**From a clone.** `setup` runs the same from any clone. The files it writes
then point at that clone, and the plan says so.

The plan and its progress are tracked in
[awebai/oats#1311](https://github.com/awebai/oats/issues/1311).

Status: v0.6.0 is released. It is v0.3.0 with the waiting cards and a
default UI, which the one OATS row in SUPER + SPACE opens beside the
OATS TUI and OATS Desktop launchers; v0.4.0's picker and soul spawning
are gone.
`omarchy plugin add` installs the tip of the default branch; to stay on
v0.6.0, pin it as described under "Pinning a release".

Developing it: [CONTRIBUTING.md](CONTRIBUTING.md).
