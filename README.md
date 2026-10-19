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
- **`setup --check`** reports drift. Omarchy also runs it after each update.

**Pinning a release.** The plugin is a plain git checkout:
`git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout <tag>`. `omarchy plugin
update` fast-forwards it to the default branch again.

**Removing it.** Run `setup --remove` first: it restores everything setup
wrote. Then run `omarchy plugin remove ai.aweb.oats`. The launchers, menu and
hook point into the plugin's directory, so removing the plugin first leaves
them behind. The hook then says so, and adding the plugin again and running
`setup --remove` cleans up.

**From a clone.** `setup` runs the same from any clone. The files it writes
then point at that clone, and the plan says so.

The plan and its progress are tracked in
[awebai/oats#1311](https://github.com/awebai/oats/issues/1311).

Status: under construction; nothing here is released yet.

Developing it: [CONTRIBUTING.md](CONTRIBUTING.md).
