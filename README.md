# oats-omarchy

An [OATS](https://github.com/awebai/oats) capability package that makes OATS
feel native on [Omarchy](https://omarchy.org): both OATS clients, the
terminal UI (`oats tui`) and OATS Desktop, become Omarchy apps with a launcher
entry, an icon and a key, and an `oats` submenu in the Omarchy menu opens
either client and lists the agents waiting on you.

It is set up with one command, `oats omarchy setup --plan | --apply |
--remove | --check`, driven by the `/oats-omarchy-setup` skill. Setup finds
what it needs on the machine instead of assuming paths, applies each part
only where Omarchy offers it, shows the suggested key binding rather than
writing it into your configuration, and `--remove` restores exactly what was
there before.

## Install

Declaring the package and giving it to a soul are the workspace owner's
decisions.

1. Declare the package in the workspace's `packages:`: run this in the
   workspace host checkout, then commit, then `oats sync`.
   ```bash
   oats package add oats.omarchy git:github.com/awebai/oats-omarchy@v0.1.0
   ```
2. Give a soul the capability, in its `soul.yaml`:
   ```yaml
   capabilities:
     oats.omarchy: { from: package }
   ```
3. From the deployment directory, see what setup would do:
   ```bash
   oats omarchy setup --plan --soul <soul>
   ```
   Then `--apply`, and paste the key snippet the plan prints into your
   Hyprland bindings. `--check` reports drift; `--remove` undoes it all.

The plan and its progress are tracked in
[awebai/oats#1311](https://github.com/awebai/oats/issues/1311).

Status: under construction; nothing here is released yet.

Developing it: [CONTRIBUTING.md](CONTRIBUTING.md).
