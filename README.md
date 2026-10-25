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
prints the snippet for you to add. Once you pick OATS for it, the agent key,
SUPER + SHIFT + CTRL + A, goes into the same block and opens the machine's
steward through `omarchy-launch-oats`, a launcher setup writes to
`~/.local/bin`. Picking it with `setup --apply --only agent-key`, or the
OATS row in Omarchy's Default Agent menu, changes nothing else (see "The
agent key"). Setup also puts the installer there, `omarchy-install-oats`
(see "Install OATS on this machine"). `--remove` restores exactly what was
there before.

## Install OATS on this machine

On an Omarchy machine without OATS, the plugin installs it. Add the plugin
(pinned to a release, as "Pinning a release" below shows), then run its
installer in a terminal:

```bash
omarchy plugin add https://github.com/awebai/oats-omarchy --enable --yes
~/.config/omarchy/plugins/ai.aweb.oats/bin/omarchy-install-oats --now
```

Before setup has run, a click on the OATS icon does the same when OATS is
not installed yet.

It uses what is already on the machine: a tool on your PATH at or above its
minimum is used as it is, never replaced, and never shadowed by a second
copy. It installs only what is missing, and a tool that is too old stops it
with the command that upgrades it the way it was installed. It runs six
steps, one line each:

1. **The harness** your agents run on. It asks "Which harness should your
   agents run on?", offering claude, codex or pi with Omarchy's default agent
   first; Enter takes that one.
2. **Node.js (22 or later), the harness and tmux.** Node and the harness are
   installed with mise, as Omarchy installs agents. tmux is a system package:
   `omarchy-pkg-add` installs it and asks for your password.
3. **aw**, the aweb CLI (1.36.33 or later), with mise.
4. **The OATS CLI** (0.67.1 or later), with mise.
5. **Claude's aweb channel plugin**, with claude only: its marketplace and
   the plugin, each when it is absent. A copy you disabled stays disabled:
   it stops with the command that enables it.
6. **The onboarding agent.** It writes what it found to
   `~/.local/state/oats-omarchy/found.json` ([the found-list](docs/found-list.md)),
   then starts the harness in `~/Work` with a prompt that points it at
   OATS's getting-started skill and at that list. The agent sets up the
   rest: the workspace, its identities and this machine's steward. It never
   applies the plugin's setup, which stays yours to run. Claude asks you
   once to confirm loading the aweb channel.

Run it again at any time: what is done is found and skipped. Once setup has
run, it is on your PATH as `omarchy-install-oats`.
`omarchy-install-oats --check` only looks: one line each for node, tmux, aw,
the OATS CLI and the steward, and it exits 0 only when OATS is ready here.

**With a coding agent.** You have no terminal to answer in, so pass the
harness the person chose; ask them which one first, and tell them that
tmux, when it is missing, asks for their password:

```bash
~/.config/omarchy/plugins/ai.aweb.oats/bin/omarchy-install-oats --check --harness claude
~/.config/omarchy/plugins/ai.aweb.oats/bin/omarchy-install-oats --now --harness claude
```

Without a terminal, `--now` opens Omarchy's floating terminal and runs
there, because the onboarding agent runs in it; without `--harness` it is
refused.

## Installing with a coding agent

This section is written to you, the coding agent asked to install this
plugin. Follow the steps in order. Every command here is this version's
(`setup --help` lists setup's flags).

> **You never run `setup --apply` or `setup --remove`, with or without
> `--yes`.** You run `setup --plan` and `setup --check`, which change
> nothing, and you show the person what they say. Applying is the person's
> own act: they type the exact command you give them in their own terminal,
> where setup shows the plan again and asks, or they pick a row in Omarchy's
> menu. That is not an extra approval: it is them choosing.
>
> Why: setup writes Hyprland key bindings, launchers in `~/.local/bin` and
> an Omarchy post-update hook, which change what the person's desktop runs
> and stay after the session. An agent's permission checks (Claude Code's
> auto mode among them) refuse that from an agent as persistence, and they
> are right to: moving the person's desktop keys is theirs to do. Don't
> look for a way around it. `--yes` is for a person in a terminal that
> cannot answer setup's question; never pass it yourself.

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

**3. The person adds the plugin.** Give them this command for their own
terminal:

```bash
omarchy plugin add https://github.com/awebai/oats-omarchy --enable
```

Omarchy asks them there whether they trust the repository, since plugins run
as unsandboxed code inside the Omarchy shell. It clones the default branch
into `~/.config/omarchy/plugins/ai.aweb.oats/`, and `--enable` loads the
plugin's bar icon into the Omarchy shell at once. It runs no setup. Once
they say it is done, check that `~/.config/omarchy/plugins/ai.aweb.oats/setup`
is there.

To install a release rather than the tip of the default branch, they pin it
before the shell loads it: they add the plugin without `--enable`, check out
the tag, then enable it:

```bash
omarchy plugin add https://github.com/awebai/oats-omarchy
git -C ~/.config/omarchy/plugins/ai.aweb.oats fetch origin tag v0.7.0 && git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout v0.7.0
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
  steps 5 and 6. (Without `--ui`, setup asks it in the person's terminal.)
- **One:** that one is the default. Pass no `--ui`, and don't ask.
- **None:** there is no default UI, and no OATS row. The plan's parts say
  why.

Then ask the person "Should the agent key (SUPER + SHIFT + CTRL + A) open
OATS's steward, or stay with Omarchy's agent?". Pass the answer as
`--agent-key oats` or `--agent-key omarchy` in steps 5 and 6. (Without
`--agent-key`, setup asks it in the person's terminal.) When the plan's
"Agent key" says it was chosen at an earlier `--apply`, that choice is kept:
ask only if the person wants to change it. The key moves only when the
machine has exactly one OATS steward. When the plan's agent-key part says it
stays with Omarchy until the machine has one, give the person
`~/.config/omarchy/plugins/ai.aweb.oats/setup --apply --only agent-key` to
type once the steward is spawned (see "The agent key").

**5. Show the plan.** Leave out `--dir <deployment>` here and in step 6
only when both checks in step 2 hold, and `--ui <ui>` when step 4 says so.

```bash
~/.config/omarchy/plugins/ai.aweb.oats/setup --plan --dir <deployment> --ui <ui> --agent-key <oats|omarchy>
```

It changes none of the person's files: to check the key block it only
works on a temporary copy, as below. Show the person the whole plan, and
point out:
- every file it will write, and any it replaces: the plan marks those
  "(replaces an existing file, backed up; --remove restores it)";
- the key change: SUPER + O becomes a prefix, and Omarchy's "pop window out"
  moves to SUPER + O, then O;
- the default UI, under "Default UI";
- when they picked OATS, the agent key change, under "Agent key":
  SUPER + SHIFT + CTRL + A opens the machine's steward through
  `~/.local/bin/omarchy-launch-oats` instead of Omarchy's agent, while a
  right click in Omarchy's agents panel, `omarchy agent prompt` and crash
  notifications still open Omarchy's agent;
- that to check the key block, setup ran `Hyprland --verify-config` on a
  temporary copy of their Hyprland config, which runs their config's own
  commands (its `io.popen` calls), on the copy;
- any fixes it suggests, such as `sudo pacman -S fuse2`, for the person to
  run;
- with the list, its notes: that the list holds no deployment yet, or that a
  `--dir` you passed is not in it, and what to run.

If they ask for changes, change the flags and show the plan again.

**6. Give the person the command that applies it.** They type it in their
own terminal, with the same flags as the plan you showed:

```bash
~/.config/omarchy/plugins/ai.aweb.oats/setup --apply --dir <deployment> --ui <ui> --agent-key <oats|omarchy>
```

There setup shows the plan again and asks `Apply it? [y/N]`. After their
yes it checks the key block with Hyprland, then writes. Nothing is written
until they answer `y`. If they decide against it, the plugin itself stays
installed unless they remove it (`omarchy plugin remove ai.aweb.oats`, in
their terminal).

**7. Report.** Once they say it ran, run `setup --check` (it prints nothing
when everything is as setup wrote it) and `setup --plan` (the parts read
"already applied"). Say what was applied and what was skipped, with the
reasons setup gives. If the plan printed the key snippet instead of writing it (for
example, SUPER + O was already bound to something of the person's), show
them the snippet and let them paste it into their Hyprland bindings
themselves. The same goes for the agent key's lines under "Agent key".

**8. Tell the person how to look after it.** Here `setup` is
`~/.config/omarchy/plugins/ai.aweb.oats/setup`.
- **Check:** `setup --check` reports drift. Omarchy runs it after each
  `omarchy update`, and you may run it too. When the OATS CLI gains the list
  of deployments, it says so: `setup --apply` again (without `--dir`)
  switches to it. After an upgrade from v0.3.0 or v0.4.0 it reports the menu
  (and v0.4.0's key block) as from another version of setup, and with both
  UIs "default UI not chosen": ask the person which UI, as in step 4, then
  give them `setup --apply --ui <ui>` to type.
- **The agent key:** `setup --apply --only agent-key` moves it to OATS, or
  they pick the row (see "The agent key"); `--agent-key omarchy` added gives
  it back.
- **Update:** `omarchy plugin update ai.aweb.oats`, then `setup --check`.
  Updating moves a pinned checkout to the tip of the default branch.
- **Pin a release:** `git -C ~/.config/omarchy/plugins/ai.aweb.oats fetch origin tag v0.7.0 && git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout v0.7.0`.
  Pin again after any `omarchy plugin update`.
- **Remove:** `setup --remove` first, then `omarchy plugin remove ai.aweb.oats`.
  The other order leaves the launchers, the menu and the hook behind.

You run `setup --check` and `setup --plan` yourself. Every other command
here is the person's to type in their own terminal.

## The agent key

Omarchy binds its agent key, SUPER + SHIFT + CTRL + A, to
`omarchy-agent --pick`, which opens Omarchy's agent. Setup can move it to
OATS: the key then opens the machine's steward through
`omarchy-launch-oats`, a launcher setup writes to `~/.local/bin` with the
node it recorded. The key moves only when you pick OATS, and picking it is
your own act, in your own terminal or Omarchy's menu:

- **The menu.** Pick **OATS** in Omarchy's Default Agent menu (Setup >
  Defaults > Agent, in SUPER + SPACE). It is checked while the key opens
  OATS. It opens a floating terminal, where setup shows the plan and asks,
  then opens the steward.
- **The command.** Type it yourself:

  ```bash
  ~/.config/omarchy/plugins/ai.aweb.oats/setup --apply --only agent-key
  ```

  The row runs the same: `setup --apply --agent-key oats --only agent-key`.

Either way, setup changes only what the agent key needs: the shim the
launcher runs the OATS CLI through, the launcher itself, and the agent key's
lines in the key block. **SUPER + O is left alone**, and so are the OATS TUI
and OATS Desktop launchers, the menu, the post-update hook and the default
UI. The plan says so under "Only the agent key". A coding agent can show you
that plan (`--plan --only agent-key`) but never applies it for you.

The menu row is there once a full `setup --apply` has run, since that is
what writes the menu. A full `setup --apply` is also how you get SUPER + O,
the launchers and the menu. It asks the agent key's question too: "The
agent key (SUPER + SHIFT + CTRL + A) opens: OATS or Omarchy's agent?",
after the default UI's question, with `--yes` too (Enter is OATS).
`--agent-key oats` or `--agent-key omarchy` answers it ahead. A later
`--apply` keeps the choice until you pass another `--agent-key`, and the
plan shows it, and where it came from, under "Agent key". Without a
terminal and without `--agent-key`, a full `--apply` asks nothing and the
key stays with Omarchy.

Picking OATS moves the key only when this machine has exactly one steward
(an instance of `oats.machine/steward`), which setup looks for each time
`--plan` or `--apply` runs. Without one, or with several, the key stays with
Omarchy and the plan says why. Your choice is kept, so
`setup --apply --only agent-key` (or a full `setup --apply`) after spawning
the steward moves the key without asking again. A key that has
already moved stays with OATS when the steward is gone: the plan notes it,
and the key says so when you press it.

Setup writes the agent key's lines into the same marked block of your
`bindings.lua` as SUPER + O: they unbind Omarchy's binding and bind the key
to the launcher by its absolute path. Each of the two has its own checks,
so either can be written without the other. The agent key's lines are
written only while SUPER + SHIFT + CTRL + A runs Omarchy's stock "Agent" and
your own `bindings.lua` neither binds nor unbinds it. When the key is
rebound, unbound or bound in your `bindings.lua`, or your bindings are in
the hyprlang layout, the plan prints the lines for you to adapt instead.
Setup never replaces a file at `~/.local/bin/omarchy-launch-oats` that it
did not write: with one there, it leaves the launcher and the key alone and
says why.

**Giving it back.** `setup --apply --only agent-key --agent-key omarchy`
takes setup's lines for the agent key out of the block, and nothing else
(`setup --apply --agent-key omarchy` does the same with a full apply);
`setup --remove` takes out everything. Either way Omarchy's own binding
works again.

Only the key moves. A right click in Omarchy's agents panel in the bar,
`omarchy agent prompt` and crash notifications run `omarchy-agent`
directly, so they still open Omarchy's agent until Omarchy upstream knows
OATS.

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
Then it asks who the agent key opens (see "The agent key").

- **`omarchy plugin add`** clones this repository's default branch into
  `~/.config/omarchy/plugins/ai.aweb.oats/` and puts the OATS icon in your
  bar. It takes no tag. Without a terminal it needs `--yes`.
- **The OATS icon** reads nothing in the background and shows no count:
  nothing runs until you open its panel. A left click opens the panel, and
  a right click opens the default UI.
- **Before setup has run**, a click on the icon (its tooltip says "OATS:
  click to set up") runs the whole setup in a floating terminal: it asks for
  the deployment (not with the list), shows the plan and asks before
  applying it. When OATS is not installed on the machine yet
  (`omarchy-install-oats --check` fails, asked once per click), the click
  runs the installer instead (see "Install OATS on this machine").
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
- **`Ctrl+\`.** While you're attached to an agent from the panel, the popup
  or `omarchy-launch-oats`, `Ctrl+\` leaves the viewer, and the agent keeps
  running. It is the kernel's suggested detach key, and no harness binds
  it. It needs an OATS CLI with a detach key (`oats version --json` lists
  `session-attach-detach-key`). Up to v0.6.0 the key was Alt+O: until you
  run `setup --apply` again, the panel and the popup keep using Alt+O, and
  their hint says so.
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
`git -C ~/.config/omarchy/plugins/ai.aweb.oats fetch origin tag v0.7.0 && git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout v0.7.0`.
The command fetches the release's tag first, because `omarchy plugin update`
fetches no tags. `omarchy plugin update` fast-forwards the checkout to the
tip of the default branch, so pin again after an update.

**Removing it.** Run `setup --remove` first: it restores everything setup
wrote. Then run `omarchy plugin remove ai.aweb.oats`. The launchers, menu and
hook point into the plugin's directory, so removing the plugin first leaves
them behind. The hook then says so, and adding the plugin again and running
`setup --remove` cleans up.

**From a clone.** `setup` runs the same from any clone. The files it writes
then point at that clone, and the plan says so.

## The agent launcher

`omarchy-launch-oats` opens this machine's OATS steward the way Omarchy's
`omarchy-agent` opens the default coding agent. It is one window, through
`omarchy-launch-tui --app-id=org.omarchy.agent`, so it shares the agent
windows' class for Omarchy's window rules and themes. In that window it
finds the steward, starts it when it is stopped, and attaches to its
session. `Ctrl+\` leaves the viewer, and the steward keeps running. The
command is `bin/omarchy-launch-oats` in the plugin's directory.

It needs two things:

- **Setup applied** (`setup --apply`). The launcher runs the OATS CLI
  setup recorded, never `oats` from your PATH.
- **One steward**, the soul `oats.machine/steward` (awebai/oats-machine), in
  the machine's deployment. Spawn it there with
  `oats spawn oats.machine/steward --name steward`. The steward is looked up
  on every launch: first in the deployment setup is applied for, when setup
  records one, and when that one has exactly one steward, there alone;
  otherwise in every deployment of this computer's list (with an older OATS
  CLI, in the deployment setup is applied for). The steward itself is never
  recorded, so a respawned steward is found again.

Flags:

- **`--prompt <text>`** is your own turn in the steward's session, as if you
  typed it. It is sent once the steward runs, and never twice. A steward
  that is waiting on you (a permission prompt or a question) gets nothing,
  since the Enter could answer it. The window says so, and you type it
  yourself. A steward in the middle of a turn gets it as typed input, and
  its harness handles that as it handles typing during a turn. The OATS
  CLI cannot tell that state apart. The text reaches the window in a file
  only you can read, deleted once read, never on a command line.
- **`--inline`** runs Omarchy's own default agent in this terminal instead
  (`omarchy-agent --inline`, with `--prompt` passed on), without OATS.

What each failure says:

- **Before the window opens,** on stderr and in a notification, then exit
  status 1:
  - `Node.js is needed: …`, when there is no `node` on PATH and none
    recorded by setup;
  - `OATS is not set up here (setup's shim … is missing): run setup --apply`;
  - `omarchy-launch-tui is not on PATH: it opens the agent window`;
  - `omarchy-launch-tui: exited with status <n> before the window started`,
    after the launcher's own message;
  - `omarchy-launch-tui: the window did not start within 30 s`.
- **In the window,** one line naming the step, then Enter closes the window:
  - `finding the steward: no steward on this machine: spawn one with …`.
    Any deployment whose `oats status` failed is named. A steward in
    another deployment is still opened, after a line naming the one that
    could not be read.
  - `finding the steward: several stewards on this machine, and none is
    chosen: …`, which lists each one as `instance @ deployment`;
  - `starting the steward (<home>): <the OATS CLI's message>`;
  - `attaching: …`.
- **The prompt,** reported, and then the window attaches after Enter:
  - `the steward is waiting on you (<its message>): your prompt was not sent; attaching`;
  - `sending your prompt: <the OATS CLI's message>: your prompt was not delivered; type it yourself`;
  - `sending your prompt: the steward was not running within 20 s: …`;
  - `sending your prompt: the steward's session could not be inspected within
    20 s: <the OATS CLI's message>: …`, when every inspect in those 20 s
    failed (each failure is tried again a second later).
  - On success, `your prompt was sent to the steward`. When the OATS CLI
    could not see the prompt arrive, the line adds that it is not sent
    again.

The plan and its progress are tracked in
[awebai/oats#1311](https://github.com/awebai/oats/issues/1311).

Status: v0.7.0 is released. It is v0.6.0 with OATS as the standard on
Omarchy: `omarchy-launch-oats`, which opens this machine's steward; the
agent key, SUPER + SHIFT + CTRL + A, which opens it too once you pick OATS
(`setup --apply --only agent-key`, or the OATS row in Omarchy's Default
Agent menu); `omarchy-install-oats`, which installs what is missing and
hands its found-list to an onboarding agent; and `Ctrl+\` to leave a
session's viewer.
`omarchy plugin add` installs the tip of the default branch; to stay on
v0.7.0, pin it as described under "Pinning a release".

Developing it: [CONTRIBUTING.md](CONTRIBUTING.md).
