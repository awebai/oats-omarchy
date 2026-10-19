# oats-omarchy

An [Omarchy](https://omarchy.org) plugin that makes
[OATS](https://github.com/awebai/oats) feel native there. Both OATS clients,
the terminal UI (`oats tui`) and OATS Desktop, become Omarchy apps with a
launcher entry, an icon and a key. An `oats` submenu in the Omarchy menu
opens either client and lists the agents waiting on you.

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
v0.1.0.

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

**2. Find the deployment:** the directory that holds `oats-local.yaml`.
- Look in the directories directly inside `~/Agents` (a common place; setup
  itself does not search it), and in the current directory and its parents.
- If you find exactly one, name it to the person in step 4. If you find
  more than one, or none, ask the person which directory it is.
- Never guess. `--dir` must be the directory that directly holds
  `oats-local.yaml`.

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

To install the released v0.1.0 rather than the tip of the default branch,
pin it before the shell loads it. Add the plugin without `--enable`, check
out the tag, then enable it:

```bash
omarchy plugin add https://github.com/awebai/oats-omarchy --yes
git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout v0.1.0
omarchy plugin enable ai.aweb.oats
```

**4. Show the plan.**

```bash
~/.config/omarchy/plugins/ai.aweb.oats/setup --plan --dir <deployment>
```

It changes none of the person's files: to check the key block it only
works on a temporary copy, as below. Show the person the whole plan, and
point out:
- every file it will write, and any it replaces: the plan marks those
  "(replaces an existing file, backed up; --remove restores it)";
- the key change: SUPER + O becomes a prefix, and Omarchy's "pop window out"
  moves to SUPER + O, then O;
- that to check the key block, setup ran `Hyprland --verify-config` on a
  temporary copy of their Hyprland config, which runs their config's own
  commands (its `io.popen` calls), on the copy;
- any fixes it suggests, such as `sudo pacman -S fuse2`, for the person to
  run.

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
  `omarchy update`.
- **Update:** `omarchy plugin update ai.aweb.oats`, then `setup --check`.
  Updating moves a pinned checkout to the tip of the default branch.
- **Pin a release:** `git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout <tag>`, for
  example `v0.1.0`. Pin again after any `omarchy plugin update`.
- **Remove:** `setup --remove` first, then `omarchy plugin remove ai.aweb.oats`.
  The other order leaves the launchers, the menu and the hook behind.

When you run any of these yourself, add `--yes` (you have no terminal) only
after the person has agreed in the chat. `setup --check` needs no `--yes`.

## Install

It needs Node.js and the OATS CLI (`npm install -g @awebai/oats`, 0.53.0 or
later) on your PATH, and an OATS deployment: the directory that holds
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
- **The OATS icon** opens the OATS TUI once setup has run. Before that, it
  opens setup's plan in a floating terminal.
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

Status: v0.1.0 is released. `omarchy plugin add` installs the tip of the
default branch; to stay on v0.1.0, pin it as described under "Pinning a
release".

Developing it: [CONTRIBUTING.md](CONTRIBUTING.md).
