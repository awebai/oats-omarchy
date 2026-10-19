# oats-omarchy

An [Omarchy](https://omarchy.org) plugin that makes
[OATS](https://github.com/awebai/oats) feel native there. With only the OATS
CLI and tmux installed, you work with your agents in Omarchy's own UI:

- **The OATS picker** (SUPER + O, then Space) lists every agent, who is
  waiting on you and why, and the souls you can start agents from. It opens
  any agent's session, and starts a new agent from a soul with the task you
  type. It looks like Omarchy's own pickers and uses the shell's theme.
- **The OATS icon in the bar** opens a panel with a card for each agent
  waiting on you, read when you open it.
- **An `oats` submenu** in the Omarchy menu, found by searching for "oats",
  "agents", "instances", "souls" or "waiting", opens the picker on each of
  its sections, and the OATS status.

Both OATS clients, the terminal UI (`oats tui`) and OATS Desktop, stay
optional. When they are installed they become Omarchy apps with a launcher
entry, an icon and a key, as before. With an OATS CLI that keeps this
computer's list of deployments (`oats deployments`), all of that covers every
listed deployment; with an older one, the one deployment setup is applied
for.

It is set up with one command, `setup --plan | --apply | --remove | --check`,
run from the plugin's directory. Setup finds what it needs on the machine
instead of assuming paths, and applies each part only where Omarchy offers
it. On Omarchy's Lua layout it writes the keys, SUPER + O and then Space, T
or D, into your
`bindings.lua` as a marked block, but only over Omarchy's stock binding and
only after Hyprland has checked a copy of your config with it. Otherwise it
prints the snippet for you to add. `--remove` restores exactly what was
there before.

## Installing with a coding agent

This section is written to you, the coding agent asked to install this
plugin. Follow the steps in order. Every command here is checked against
v0.4.0.

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

To install the released v0.4.0 rather than the tip of the default branch,
pin it before the shell loads it. Add the plugin without `--enable`, check
out the tag, then enable it:

```bash
omarchy plugin add https://github.com/awebai/oats-omarchy --yes
git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout v0.4.0
omarchy plugin enable ai.aweb.oats
```

**4. Show the plan.** Leave out `--dir <deployment>` here and in step 5
only when both checks in step 2 hold.

```bash
~/.config/omarchy/plugins/ai.aweb.oats/setup --plan --dir <deployment>
```

It changes none of the person's files: to check the key block it only
works on a temporary copy, as below. Show the person the whole plan, and
point out:
- every file it will write, and any it replaces: the plan marks those
  "(replaces an existing file, backed up; --remove restores it)";
- the key change: SUPER + O becomes a prefix. Then Space opens the OATS
  picker, T the TUI and D the Desktop (each only when that part applies),
  and Omarchy's "pop window out" moves to SUPER + O, then O;
- that to check the key block, setup ran `Hyprland --verify-config` on a
  temporary copy of their Hyprland config, which runs their config's own
  commands (its `io.popen` calls), on the copy;
- any fixes it suggests, such as `sudo pacman -S fuse2`, for the person to
  run;
- with the list, its notes: that the list holds no deployment yet, or that a
  `--dir` you passed is not in it, and what to run.

Then ask whether to apply it.

**5. Apply, only after the person's yes in the chat.**

```bash
~/.config/omarchy/plugins/ai.aweb.oats/setup --apply --yes --dir <deployment>
```

If they say no, or ask for changes, stop here: setup has written nothing.
The plugin itself stays installed unless they want it removed
(`omarchy plugin remove ai.aweb.oats --yes`, once they agree).

**6. Report.** Say what was applied and what was skipped, with the reasons
setup gives. If the plan printed the key snippet instead of writing it (for
example, SUPER + O was already bound to something of the person's), show
them the snippet and let them paste it into their Hyprland bindings
themselves.

**7. Tell the person how to look after it.** Here `setup` is
`~/.config/omarchy/plugins/ai.aweb.oats/setup`.
- **Check:** `setup --check` reports drift. Omarchy runs it after each
  `omarchy update`. When the OATS CLI gains the list of deployments, it says
  so: `setup --apply` again (without `--dir`) switches to it.
- **Update:** `omarchy plugin update ai.aweb.oats`, then `setup --apply`
  again, so that what setup wrote matches the new version. Updating moves a
  pinned checkout to the tip of the default branch. Between updates,
  `setup --check` says when this is needed: after an update from v0.3.0 it
  reports the key block, the oats menu and the bar widget's plugin.json as
  "from an older setup ...: run setup --apply again". `--apply` then
  replaces only setup's own marked blocks, checking the new key block with
  Hyprland on a copy first, as for a new one.
- **Pin a release:** `git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout <tag>`, for
  example `v0.4.0`. Pin again after any `omarchy plugin update`.
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

- **`omarchy plugin add`** clones this repository's default branch into
  `~/.config/omarchy/plugins/ai.aweb.oats/` and puts the OATS icon in your
  bar. It takes no tag. Without a terminal it needs `--yes`.
- **The OATS picker** opens with SUPER + O, then Space; with Open OATS in
  the panel or in the menu; and on one section with Waiting on you, Agents
  or Souls in the menu. Its sections are Waiting on you (a card for each
  agent that says it is waiting on you), Agents (every instance, by
  workspace, running ● or stopped ○, and the bell when it waits on you) and
  Souls (the souls each workspace offers, with how many instances each has).
  Without a section asked for, it opens on Waiting on you when an agent
  waits, else on Agents.
  - Typing filters; Up and Down or Ctrl+J and Ctrl+K move; Tab and
    Shift+Tab switch section; Enter acts; Esc clears the filter, then
    closes.
  - Enter on an agent opens its session in a floating terminal. Enter on a
    soul asks for the agent's task ("Task for <soul>"; an empty answer
    starts nothing), then runs `oats spawn` in a floating terminal, in the
    deployment that soul was listed from, and opens the new agent's
    session. If the spawn fails, the terminal stays open on the kernel's
    error; if no terminal opens, nothing runs and a notification says so.
    When two deployments of one workspace offer the same soul, or have an
    agent of the same name, the row names the deployment it is in.
  - It reads only when it opens (each `oats status --json` and
    `oats souls --json` within 25 seconds, all of them within 110), and
    says so while it reads. A deployment that could not be read is shown as
    such, and the others are still listed. An agent is shown waiting only
    when the kernel says so, so an empty Waiting on you never means that
    nobody is waiting.
  - It is the plugin's overlay, so it opens only while the plugin is
    enabled (its icon in the bar). Otherwise Waiting on you in the menu
    falls back to a list of the agents waiting on you, and the other rows
    say why the picker did not open.
- **The OATS icon** reads nothing in the background and shows no count:
  nothing runs until you open its panel. A left click opens the panel, and
  a right click opens the TUI.
- **Before setup has run**, a click on the icon (its tooltip says "OATS:
  click to set up") runs the whole setup in a floating terminal: it asks for
  the deployment (not with the list), shows the plan and asks before
  applying it.
- **Its panel** (a left click, once setup has run) reads the agents waiting
  on you each time it opens, and says so while it reads. An agent is listed
  when the kernel says it is waiting on you; for the others the kernel makes
  no claim, so an empty list never means that nobody is waiting. Each agent
  is a card: the kernel's message, then its reason, the producer and how long
  ago, as the kernel gives them (the exact time in its tooltip). When the
  read fails, the panel says why. A click on a card opens the agent's
  session in a floating terminal. The panel also has Open OATS (the
  picker), Open OATS TUI, Open OATS Desktop (when setup found one) and Set
  up keys and launchers, which runs `setup --apply` in a floating
  terminal.
- **With the list,** the panel reads every listed deployment, one after
  another (each `oats status --json` within 25 seconds, all of them within
  110), and groups the agents by workspace when there is more than one. A
  deployment that could not be read is shown as such, and the others are
  still listed. The TUI and the Desktop open on their own list of
  deployments.
- **Alt+O.** While you're attached to an agent from the panel or the menu,
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

Status: v0.4.0. `omarchy plugin add` installs the tip of the default
branch; to stay on v0.4.0, pin it as described under "Pinning a release".

Developing it: [CONTRIBUTING.md](CONTRIBUTING.md).
