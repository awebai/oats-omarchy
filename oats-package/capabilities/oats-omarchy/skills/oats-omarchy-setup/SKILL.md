---
name: oats-omarchy-setup
description: Make the OATS TUI and OATS Desktop native Omarchy apps (launcher entries, icons, an OATS submenu in the Omarchy menu, a suggested SUPER + O key) with `oats omarchy setup`. Use when someone on Omarchy wants OATS in their app launcher or on a key, asks to set up, check or undo the Omarchy integration, or after an Omarchy update reports OATS drift.
---

# OATS on Omarchy: setup

## Before you start

The capability comes from the `oats.omarchy` package. Two decisions are the
workspace owner's, not yours: declaring the package (that is trusting it) and
giving it to a soul. If `oats omarchy` is an unknown command here, show them
these steps and stop:

1. Declare the package in the workspace's `packages:`. Run this in the
   workspace host checkout, then commit, then `oats sync`:
   ```bash
   oats package add oats.omarchy git:github.com/awebai/oats-omarchy@v0.1.0
   ```
   The line it adds to `oats-workspace.yaml`:
   ```yaml
   oats.omarchy: git:github.com/awebai/oats-omarchy@v0.1.0
   ```
2. Give a soul the capability, in its `soul.yaml` (there is no command for
   this):
   ```yaml
   capabilities:
     oats.omarchy: { from: package }
   ```
3. Plan. Run it from the deployment directory, naming that soul:
   ```bash
   oats omarchy setup --plan --soul <soul>
   ```

## Run it

1. **Plan.** Run `oats omarchy setup --plan`, from an instance home whose
   soul has `oats.omarchy` or from the deployment with `--soul <soul>`. It
   writes nothing. Show the person the whole plan. It has:
   - each part and its status: *will apply*, *already applied* or *skipped*,
     with the reason;
   - what was found, and where;
   - the key snippet;
   - the fixes they can take, such as `sudo pacman -S fuse2`.
2. **Ask before applying.** Say what `--apply` will write: the parts marked
   *will apply*, all under their home. Run `oats omarchy setup --apply` only
   after they say yes. It is idempotent: a second run writes nothing.
3. **The key is theirs to add.** Setup never writes key bindings. Show the
   snippet from the plan and the file it names (`~/.config/hypr/bindings.lua`,
   or `bindings.conf` on the older layout). Tell them to paste it at the end
   of that file; Hyprland reloads it on save. Mention what the plan's key
   notes say:
   - the cost: popping a window out becomes two taps, SUPER + O then O;
   - SUPER + O already does something else, and what;
   - a line they must fill in before it works.
4. **Desktop.** When the Desktop part is skipped, relay the plan's reason and
   how to get the Desktop. They can rerun with
   `--desktop <absolute path to the AppImage>` to choose one.
5. **The menu.** The *menu* part adds an OATS submenu to the Omarchy menu:
   open the TUI or the Desktop, *Waiting on you* (pick an agent that waits
   on them and its session opens in a floating terminal) and *Status*. It
   is the one part that edits a file of theirs,
   `~/.config/omarchy/extensions/omarchy-menu.jsonc`: it adds a block between
   `>>> oats-omarchy` and `<<< oats-omarchy` comment lines and touches
   nothing else. When the part is skipped, relay the reason: for example,
   Omarchy cannot read their file as it is, or it already has an item named
   `oats`.

## Undo and check

- `oats omarchy setup --remove` restores every file `--apply` wrote, exactly
  as it was before (deleted when it was absent), and takes the block out of
  their menu file. A file they changed since is
  left alone and named (`E_MODIFIED`). They decide what to do with it, then
  run `--remove` again. The pasted key snippet is theirs to delete from their
  bindings file.
- `oats omarchy setup --check` prints only what drifted and exits 0. Omarchy
  runs it after every update, through the post-update hook setup installs.

## Rules

- Never edit or create a desktop entry, an icon, a hook, a Hyprland or an
  Omarchy file by hand, and never paste the snippet for them: the command
  does all the writing, and only the person edits their own bindings.
- Never install anything: `fuse2`, `tmux` and the Desktop are the person's to
  install.
- Setup works for one deployment at a time. `E_OTHER_DEPLOYMENT` means it is
  applied for another one; `oats omarchy setup --remove` must run there
  first.

| Error | Meaning |
|---|---|
| `E_NO_DEPLOYMENT` | not run through `oats` from an instance home or a deployment |
| `E_OTHER_DEPLOYMENT` | applied for another deployment; remove it there first |
| `E_MODIFIED` | a file setup wrote, or the menu block, was changed since; it is left in place |
| `E_APPLY_FAILED` | a write failed; everything this run wrote was rolled back |
| `E_BAD_ARGS` (exit 2) | the arguments; it prints its usage |
