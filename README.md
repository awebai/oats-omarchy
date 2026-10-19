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

## Use it from a clone

It needs Node.js and the OATS CLI (`npm install -g @awebai/oats`, 0.53.0 or
later) on your PATH, and an OATS deployment: the directory that holds
`oats-local.yaml`.

```bash
git clone https://github.com/awebai/oats-omarchy
cd oats-omarchy
./setup --plan --dir <deployment>
```

The plan says what `--apply` would write and what it found. Then run
`./setup --apply --dir <deployment>`, which shows the plan again and asks
before writing (`--yes` skips the question; without a terminal it is
required). When the plan says the key is not written, paste the snippet it
prints into your Hyprland bindings. The menu and the hook setup writes point
at this clone, so keep it where it is. `./setup --check` reports drift, and
`./setup --remove` undoes it all.

The plan and its progress are tracked in
[awebai/oats#1311](https://github.com/awebai/oats/issues/1311).

Status: under construction; nothing here is released yet.

Developing it: [CONTRIBUTING.md](CONTRIBUTING.md).
