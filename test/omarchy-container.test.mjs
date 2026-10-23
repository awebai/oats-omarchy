// Setup against a real Omarchy: its launchers, its hook runner, its
// keybindings --print and Hyprland's own --verify-config. Runs in CI's
// Arch + Omarchy container (OATS_OMARCHY_CONTAINER=1), as an unprivileged
// user, every case with a temporary HOME and XDG directories.
//
// Setup runs as a person runs it, through the plugin's `./setup` launcher
// with the container's node on PATH. `oats` on PATH is the sandbox's
// stand-in for the CLI (test/helpers/sandbox.mjs).
// Without a running Hyprland, `omarchy menu keybindings --print` answers with
// its static bindings only, so the "keys taken" cases serve the captured
// --print through a PATH fake of `omarchy`. That fake serves the same text
// after setup writes its block, so no case here can read back from --print
// that SUPER + SHIFT + CTRL + A runs "OATS agent", or "Agent" again once it is
// given back: the agent key's cases assert the block's bytes and the real
// Hyprland --verify-config of the live config instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { parseDesktopExec, shellWord } from "../lib/quote.mjs";
import { paths as discoverPaths } from "../lib/discover.mjs";
import { readDesktopEntry } from "../lib/desktop-entry.mjs";
import * as bindings from "../lib/bindings.mjs";
import * as files from "../lib/files.mjs";
import * as menu from "../lib/menu.mjs";
import { blocksFor, managedPaths } from "../lib/setup.mjs";
import { agentBindLine } from "../lib/keys.mjs";
import { fixture, repo, sandbox, snapshot, withStewards, writeExecutable } from "./helpers/sandbox.mjs";
import * as widget from "../widget.mjs";
import { appRow, loadMenuModel, search } from "./helpers/omarchy-search.mjs";
import { found as foundList, harnessRun, miseInstalls, stepLines, world as installWorld } from "./helpers/install-world.mjs";

const enabled = process.env.OATS_OMARCHY_CONTAINER === "1";
const OMARCHY = process.env.OMARCHY_PATH || "/usr/share/omarchy";
const verify = join(repo, "ci", "verify-hypr-config.sh");
const skip = enabled ? false : "set OATS_OMARCHY_CONTAINER=1 (CI's Omarchy container)";

// A sandbox whose PATH has the real Omarchy commands, and the real Hyprland,
// after the fakes. Only systemctl stays real too: in the container it has no
// user bus, which is the "no session" path.
function omarchySandbox(t, options = {}) {
  const s = sandbox(t, { launchers: false, print: "fail", fuse: true, ...options, hyprland: false });
  for (const fake of ["systemctl", "ldconfig", "omarchy"]) spawnSync("rm", ["-f", join(s.fakebin, fake)]);
  if (options.print && options.print !== "fail") {
    writeExecutable(join(s.fakebin, "omarchy"), `#!/bin/sh\n[ "$1 $2 $3" = "menu keybindings --print" ] && cat "${join(s.root, "print.txt")}" && exit 0\nexec ${OMARCHY}/bin/omarchy "$@"\n`);
  }
  s.env.PATH = `${s.fakebin}:${OMARCHY}/bin:/usr/bin:/bin`;
  s.env.OMARCHY_PATH = OMARCHY;
  const run = s.run;
  s.run = ([command, ...args], extra = {}) => {
    if (command !== "setup") return run([command, ...args], extra);
    const yes = (args.includes("--apply") || args.includes("--remove")) && !args.includes("--yes") ? ["--yes"] : [];
    const r = spawnSync("/bin/sh", [join(repo, "setup"), ...args, ...yes], { env: { ...s.env, ...extra }, cwd: s.deployment, encoding: "utf8", timeout: 60_000 });
    let json = null;
    if (args.includes("--json")) { try { json = JSON.parse(r.stdout); } catch { /* left null; the test says so */ } }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  return s;
}

// The user's Hyprland config as Omarchy installs it: its config/hypr files.
function userHypr(s, { layout }) {
  const dir = join(s.home, ".config", "hypr");
  mkdirSync(dir, { recursive: true });
  cpSync(join(OMARCHY, "config", "hypr"), dir, { recursive: true });
  if (layout === "conf") {
    spawnSync("rm", ["-f", join(dir, "bindings.lua")]);
    writeFileSync(join(dir, "bindings.conf"), "# the older layout\n");
  }
  return dir;
}

// Writes the printed snippet where the plan says, then checks the user's
// whole config with Hyprland --verify-config.
function verifySnippet(s, keys) {
  assert.ok(keys.snippet, "a snippet was printed");
  if (keys.format === "lua") {
    writeFileSync(keys.file, `${readFileSync(keys.file, "utf8")}\n${keys.snippet}`);
    return spawnSync("bash", [verify, "--expect", "ok", join(s.home, ".config", "hypr", "hyprland.lua"), s.home], { encoding: "utf8" });
  }
  const conf = join(s.root, "snippet.conf");
  writeFileSync(conf, keys.snippet);
  return spawnSync("bash", [verify, "--expect", "ok", conf, s.home], { encoding: "utf8" });
}

// The live config, setup's block included, as Hyprland reads it.
const verifyConfig = (s) => spawnSync("bash", [verify, "--expect", "ok", join(s.home, ".config", "hypr", "hyprland.lua"), s.home], { encoding: "utf8" });

// The key block's two sections as this version writes them for a home with
// the TUI set up and no Desktop (lib/bindings.mjs composeBlock joins them).
// Neither section depends on the node or the plugin directory.
function keySections(s) {
  const p = discoverPaths(s.env);
  return blocksFor({ shimPath: p.shim, deployment: s.deployment, node: process.execPath, pluginDir: repo, tuiReady: true, desktopExec: null, ui: "tui", wrapper: p.wrapper, bindingsPath: managedPaths(p).keys }).keys;
}

const stateOf = (s) => JSON.parse(readFileSync(join(discoverPaths(s.env).stateDir, "state.json"), "utf8"));
const partOf = (r, part) => r.json.result.parts.find((x) => x.part === part);

const plan = (s, extra = []) => {
  const r = s.run(["setup", "--plan", "--json", ...extra]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.json.result;
};

test("Omarchy is installed", { skip }, () => {
  const r = spawnSync("pacman", ["-Q", "omarchy", "hyprland"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  process.stdout.write(`# ${r.stdout.trim().replace(/\n/g, ", ")}\n`);
});

test("Lua layout, no Desktop: plan, apply, the real post-update hook, check, remove", { skip }, (t) => {
  const s = omarchySandbox(t);
  userHypr(s, { layout: "lua" });
  const before = snapshot(s.home);
  const p = plan(s);
  assert.equal(p.found.launchPath.source, "minimal", "no user bus in the container");
  assert.deepEqual(p.parts.map((x) => [x.part, x.status]), [["shim", "will apply"], ["tui", "will apply"], ["desktop", "skipped"], ["hook", "will apply"], ["launcher", "will apply"], ["menu", "will apply"], ["keys", "skipped"], ["agent-key", "skipped"]]);
  assert.equal(p.agentKey.choice, null, "no terminal and no --agent-key: the agent key stays with Omarchy");
  assert.equal(p.found.menu.defaults, join(OMARCHY, "default", "omarchy", "omarchy-menu.jsonc"));
  assert.equal(p.keys.status, "unchecked", "--print without Hyprland");
  assert.match(p.keys.notes[0], /no running Hyprland answered/);
  assert.equal(p.found.libfuse2.ok, false, "fuse2 is not in Omarchy's packages");

  const apply = s.run(["setup", "--apply", "--json"]);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  const hook = spawnSync("omarchy-hook", ["post-update"], { env: s.env, cwd: s.home, encoding: "utf8" });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "", "Omarchy's hook runner ran our hook, which found no drift");
  assert.equal(s.run(["setup", "--check"]).stdout, "");

  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  // The snippet went into the user's bindings.lua for the check; take it out again.
  cpSync(join(OMARCHY, "config", "hypr", "bindings.lua"), p.keys.file);

  const removed = s.run(["setup", "--remove"]);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.deepEqual(snapshot(s.home), before);
});

// Setup writes the key block into the user's bindings.lua, checked by the
// real Hyprland on a copy first. The effective bindings are Omarchy's
// defaults (the captured --print), so SUPER + O is the stock pop-out.
test("the key block: apply verifies and writes it, a second apply changes nothing, remove restores byte for byte", { skip }, (t) => {
  const s = omarchySandbox(t, { print: "fixture" });
  userHypr(s, { layout: "lua" });
  const file = join(s.home, ".config", "hypr", "bindings.lua");
  const before = snapshot(s.home);
  const apply = s.run(["setup", "--apply", "--json"]);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  const keys = apply.json.result.parts.find((x) => x.part === "keys");
  assert.equal(keys.status, "applied", keys.reason);
  assert.equal(existsSync(join(s.root, "hyprland.log")), false, "the real Hyprland verified it, not the sandbox's fake");
  assert.match(readFileSync(file, "utf8"), /-- >>> oats-omarchy \(managed by setup; remove with setup --remove\) >>>\n[^]*-- <<< oats-omarchy <<<\n$/);
  // The live config, block included, as Hyprland reads it.
  const v = spawnSync("bash", [verify, "--expect", "ok", join(s.home, ".config", "hypr", "hyprland.lua"), s.home], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stdout + v.stderr);

  const written = readFileSync(file);
  const again = s.run(["setup", "--apply", "--json"]);
  assert.equal(again.json.result.parts.find((x) => x.part === "keys").status, "already applied");
  assert.ok(readFileSync(file).equals(written));
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("the key block: SUPER + O bound in the user's bindings.lua is refused, nothing written", { skip }, (t) => {
  const s = omarchySandbox(t, { print: "fixture" });
  userHypr(s, { layout: "lua" });
  const file = join(s.home, ".config", "hypr", "bindings.lua");
  writeFileSync(file, `${readFileSync(file, "utf8")}o.bind("SUPER + O", "Mine", "true")\n`);
  const mine = readFileSync(file);
  const p = plan(s);
  const keys = p.parts.find((x) => x.part === "keys");
  assert.equal(keys.status, "skipped");
  assert.match(keys.reason, /your bindings\.lua binds SUPER \+ O itself/);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.ok(readFileSync(file).equals(mine));
});

test("the key block: a block Hyprland refuses is not written, and Hyprland's lines are reported", { skip }, (t) => {
  const s = omarchySandbox(t, { print: "fixture" });
  userHypr(s, { layout: "lua" });
  const file = join(s.home, ".config", "hypr", "bindings.lua");
  // Valid on its own (Omarchy's own SUPER + O is bound before this file
  // runs); the block's o.bind("SUPER + O", ...) then fails.
  writeFileSync(file, `${readFileSync(file, "utf8")}local bind = o.bind\no.bind = function(keys, ...)\n  if keys == "SUPER + O" then error("SUPER + O is not for setup here") end\n  return bind(keys, ...)\nend\n`);
  const mine = readFileSync(file);
  const p = plan(s);
  const keys = p.parts.find((x) => x.part === "keys");
  assert.equal(keys.status, "skipped");
  assert.match(keys.reason, /^Hyprland --verify-config refuses your config with the key block added, so setup writes nothing:\n/);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.ok(readFileSync(file).equals(mine));
});

// The block with each set of sections it can hold, appended to Omarchy's own
// bindings.lua: the agent key's hl.unbind and o.bind, after Omarchy's
// utilities.lua bound the combo, and the submap, each alone and together.
for (const [name, pick] of [
  ["both sections", (k) => k],
  ["the SUPER + O submap alone", (k) => ({ submap: k.submap })],
  ["the agent key alone", (k) => ({ agentKey: k.agentKey })],
]) {
  test(`the key block with ${name} passes the real Hyprland --verify-config`, { skip }, (t) => {
    const s = omarchySandbox(t);
    userHypr(s, { layout: "lua" });
    const file = managedPaths(discoverPaths(s.env)).keys;
    const block = bindings.composeBlock(pick(keySections(s)));
    writeFileSync(file, bindings.appendBlock(readFileSync(file, "utf8"), block).text);
    const v = verifyConfig(s);
    assert.equal(v.status, 0, v.stdout + v.stderr);
  });
}

// The agent key end to end: picked, given back, picked again, then removed.
// Each step's bindings.lua is checked byte for byte and by the real Hyprland;
// the menu's Default Agent row's `checked` runs as Omarchy's guard script
// runs it, with bash, against the real file.
test("the agent key: --agent-key oats writes both sections, --agent-key omarchy takes the agent key's out, --remove restores bindings.lua byte for byte", { skip }, (t) => {
  const s = omarchySandbox(t, { print: "fixture" });
  withStewards(s);
  userHypr(s, { layout: "lua" });
  const p = discoverPaths(s.env);
  const file = managedPaths(p).keys;
  const original = readFileSync(file);
  const before = snapshot(s.home);
  const k = keySections(s);
  const both = bindings.appendBlock(original.toString("utf8"), bindings.composeBlock(k)).text;
  const submapOnly = bindings.appendBlock(original.toString("utf8"), bindings.composeBlock({ submap: k.submap })).text;
  const checked = () => {
    const rows = loadMenuModel(join(OMARCHY, "shell", "plugins", "menu", "MenuModel.js")).parseMenuJsonc(readFileSync(join(s.home, ".config", "omarchy", "extensions", "omarchy-menu.jsonc"), "utf8"));
    const row = rows.find((x) => x.id === menu.AGENT_ID);
    assert.ok(row, "the Default Agent row is in the menu block");
    return spawnSync("bash", ["-c", row.checked], { env: s.env, encoding: "utf8" }).status;
  };

  const oats = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(oats.status, 0, oats.stdout + oats.stderr);
  for (const part of ["launcher", "keys", "agent-key"]) assert.equal(partOf(oats, part).status, "applied", `${part}: ${partOf(oats, part).reason}`);
  assert.deepEqual([oats.json.result.agentKey.choice, oats.json.result.agentKey.from], ["oats", "--agent-key"]);
  assert.equal(existsSync(join(s.root, "hyprland.log")), false, "the real Hyprland verified it, not the sandbox's fake");
  assert.equal(readFileSync(file, "utf8"), both);
  assert.equal(stateOf(s).files.find((f) => f.path === file).block, bindings.composeBlock(k));
  assert.equal(stateOf(s).agentKey, "oats");
  // The launcher the agent key runs, by the node and plugin setup recorded.
  assert.equal(readFileSync(p.wrapper, "utf8"), files.launcher({ node: stateOf(s).node, pluginDir: stateOf(s).pluginDir }));
  assert.equal(statSync(p.wrapper).mode & 0o777, 0o755);
  let v = verifyConfig(s);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(checked(), 0, "the Default Agent row shows OATS as checked");

  const back = s.run(["setup", "--apply", "--agent-key", "omarchy", "--json"]);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(partOf(back, "agent-key").status, "removed", partOf(back, "agent-key").reason);
  assert.equal(partOf(back, "keys").status, "already applied");
  assert.equal(readFileSync(file, "utf8"), submapOnly, "Omarchy's own binding is no longer unbound");
  assert.equal(stateOf(s).agentKey, "omarchy");
  v = verifyConfig(s);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(checked(), 1, "not checked once the key is given back");

  const again = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(partOf(again, "agent-key").status, "applied", partOf(again, "agent-key").reason);
  assert.equal(readFileSync(file, "utf8"), both);

  const removed = s.run(["setup", "--remove"]);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.ok(readFileSync(file).equals(original), "bindings.lua is Omarchy's again, byte for byte");
  v = verifyConfig(s);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.deepEqual(snapshot(s.home), before);
});

// SUPER + O taken by the user's own unbind: the submap section is refused,
// the agent key's is written alone (setup's own verification by the real
// Hyprland included), and giving the key back empties the block, which goes
// the way --remove takes it out.
test("the agent key alone: SUPER + O refused, the agent key's section written and verified, --agent-key omarchy restores bindings.lua byte for byte", { skip }, (t) => {
  const s = omarchySandbox(t, { print: "fixture" });
  withStewards(s);
  userHypr(s, { layout: "lua" });
  const file = managedPaths(discoverPaths(s.env)).keys;
  writeFileSync(file, `${readFileSync(file, "utf8")}hl.unbind("SUPER + O")\n`);
  const mine = readFileSync(file);
  const k = keySections(s);

  const oats = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(oats.status, 0, oats.stdout + oats.stderr);
  assert.equal(partOf(oats, "keys").status, "skipped");
  assert.match(partOf(oats, "keys").reason, /your bindings\.lua binds SUPER \+ O itself/);
  assert.equal(partOf(oats, "agent-key").status, "applied", partOf(oats, "agent-key").reason);
  assert.equal(existsSync(join(s.root, "hyprland.log")), false, "the real Hyprland verified it, not the sandbox's fake");
  assert.equal(readFileSync(file, "utf8"), bindings.appendBlock(mine.toString("utf8"), bindings.composeBlock({ agentKey: k.agentKey })).text);
  let v = verifyConfig(s);
  assert.equal(v.status, 0, v.stdout + v.stderr);

  const back = s.run(["setup", "--apply", "--agent-key", "omarchy", "--json"]);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(partOf(back, "agent-key").status, "removed", partOf(back, "agent-key").reason);
  assert.ok(readFileSync(file).equals(mine), "the user's bindings.lua, byte for byte");
  assert.equal(stateOf(s).files.some((f) => f.path === file), false, "no record of a block that is gone");
  v = verifyConfig(s);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

// --only agent-key, as the Default Agent row runs it: on a fresh HOME the
// block holds the agent key's section alone, and nothing else is written;
// over a full setup, SUPER + O's section, the menu, the hook and the TUI's
// launcher entry stay byte for byte. The real Hyprland verifies each
// candidate, and the live config after.
test("--only agent-key: a fresh HOME gets the agent key's section alone; a full setup keeps SUPER + O, the menu, the hook and the entry byte for byte; the real Hyprland accepts each", { skip }, (t) => {
  const fresh = omarchySandbox(t, { print: "fixture" });
  withStewards(fresh);
  userHypr(fresh, { layout: "lua" });
  const fp = discoverPaths(fresh.env);
  const freshFile = managedPaths(fp).keys;
  const freshOriginal = readFileSync(freshFile, "utf8");
  const before = snapshot(fresh.home);
  const only = fresh.run(["setup", "--apply", "--only", "agent-key", "--json"]);
  assert.equal(only.status, 0, only.stdout + only.stderr);
  assert.deepEqual(only.json.result.parts.map((x) => [x.part, x.status]), [["shim", "applied"], ["launcher", "applied"], ["agent-key", "applied"]], JSON.stringify(only.json.result.parts));
  assert.equal(existsSync(join(fresh.root, "hyprland.log")), false, "the real Hyprland verified it, not the sandbox's fake");
  assert.equal(readFileSync(freshFile, "utf8"), bindings.appendBlock(freshOriginal, bindings.composeBlock({ agentKey: keySections(fresh).agentKey })).text);
  for (const path of [managedPaths(fp).menu, managedPaths(fp).hook, managedPaths(fp)["tui-entry"], join(fp.stateDir, "plugin.json")]) assert.equal(existsSync(path), false, path);
  let v = verifyConfig(fresh);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(fresh.run(["setup", "--check"]).stdout, "");
  assert.equal(fresh.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(fresh.home), before);

  const s = omarchySandbox(t, { print: "fixture" });
  withStewards(s);
  userHypr(s, { layout: "lua" });
  const p = discoverPaths(s.env);
  const at = managedPaths(p);
  const original = readFileSync(at.keys, "utf8");
  const full = s.run(["setup", "--apply", "--agent-key", "omarchy", "--json"]);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  const k = keySections(s);
  assert.equal(readFileSync(at.keys, "utf8"), bindings.appendBlock(original, bindings.composeBlock({ submap: k.submap })).text);
  const kept = [at.menu, at.hook, at["tui-entry"], at["tui-icon"], join(p.stateDir, "plugin.json")];
  const bytes = new Map(kept.map((path) => [path, readFileSync(path)]));
  // The row's pick is the narrowed apply.
  const rows = loadMenuModel(join(OMARCHY, "shell", "plugins", "menu", "MenuModel.js")).parseMenuJsonc(readFileSync(at.menu, "utf8"));
  assert.match(rows.find((x) => x.id === menu.AGENT_ID).action, / --apply --agent-key oats --only agent-key && grep /);

  const r = s.run(["setup", "--apply", "--only", "agent-key", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(partOf(r, "agent-key").status, "applied", partOf(r, "agent-key").reason);
  assert.equal(readFileSync(at.keys, "utf8"), bindings.appendBlock(original, bindings.composeBlock(k)).text, "SUPER + O's section as it was, the agent key's after it");
  for (const [path, was] of bytes) assert.ok(readFileSync(path).equals(was), `${path} is unchanged`);
  v = verifyConfig(s);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(s.run(["setup", "--check"]).stdout, "");

  const back = s.run(["setup", "--apply", "--only", "agent-key", "--agent-key", "omarchy", "--json"]);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(partOf(back, "agent-key").status, "removed", partOf(back, "agent-key").reason);
  assert.equal(readFileSync(at.keys, "utf8"), bindings.appendBlock(original, bindings.composeBlock({ submap: k.submap })).text);
  for (const [path, was] of bytes) assert.ok(readFileSync(path).equals(was), `${path} is unchanged`);
  v = verifyConfig(s);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("the .conf layout: the hyprlang snippet passes --verify-config", { skip }, (t) => {
  const s = omarchySandbox(t);
  userHypr(s, { layout: "conf" });
  const p = plan(s);
  assert.equal(p.found.bindings.format, "conf");
  assert.equal(p.keys.format, "conf");
  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("an AppImage without libfuse2: the entry extracts and runs, the plan names fuse2, and apply/remove is exact", { skip }, (t) => {
  const s = omarchySandbox(t);
  userHypr(s, { layout: "lua" });
  mkdirSync(join(s.home, "Applications"));
  writeExecutable(join(s.home, "Applications", "OATS-Desktop.AppImage"), "#!/bin/sh\nexit 0\n");
  const before = snapshot(s.home);
  const p = plan(s);
  assert.ok(p.fixes.some((f) => f.fix === "sudo pacman -S fuse2"));
  assert.equal(s.run(["setup", "--apply", "--ui", "tui"]).status, 0);
  const entry = readDesktopEntry(readFileSync(join(s.home, ".local/share/applications/awebai-oats-desktop.desktop"), "utf8"));
  assert.deepEqual(parseDesktopExec(entry.Exec).slice(1), ["--appimage-extract-and-run", "--dir", s.deployment]);
  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  cpSync(join(OMARCHY, "config", "hypr", "bindings.lua"), p.keys.file);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

const rebound = (action) => readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8")
  .split("\n").map((l) => (l.startsWith("SUPER + O ") ? `${"SUPER + O".padEnd(35)} → ${action}` : l)).join("\n");

for (const [name, print, expect] of [
  ["Omarchy's defaults", readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8"), "default"],
  ["SUPER + O rebound to a command", rebound("omarchy-launch-browser"), "command"],
  ["SUPER + O rebound with a description (commented double tap)", rebound("Scratch notes"), "description"],
]) {
  test(`keys taken, ${name}: the snippet passes --verify-config`, { skip }, (t) => {
    const s = omarchySandbox(t, { print });
    userHypr(s, { layout: "lua" });
    const p = plan(s);
    assert.equal(p.keys.status, "suggested");
    assert.equal(p.keys.pop.kind, expect);
    const v = verifySnippet(s, p.keys);
    assert.equal(v.status, 0, v.stdout + v.stderr);
  });
}

test("keys taken, a user submap named oats: the next free key, and it passes --verify-config", { skip }, (t) => {
  const s = omarchySandbox(t, { print: readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8") });
  const dir = userHypr(s, { layout: "lua" });
  writeFileSync(join(dir, "bindings.lua"), `${readFileSync(join(dir, "bindings.lua"), "utf8")}\nhl.define_submap("oats", "reset", function()\n  hl.bind("escape", hl.dsp.submap("reset"))\nend)\n`);
  const p = plan(s);
  assert.notEqual(p.keys.entry, "SUPER + O");
  assert.equal(p.keys.submap, "oats-omarchy");
  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("the real launchers run what setup wrote, with a deployment path that has a space", { skip }, (t) => {
  const s = omarchySandbox(t, { deploymentName: "my agents & co" });
  mkdirSync(join(s.home, "Applications"));
  const image = join(s.home, "Applications", "OATS Desktop.AppImage");
  const argvLog = join(s.root, "argv.log");
  writeExecutable(image, `#!/bin/sh\nfor a; do echo "desktop:$a"; done >> "${argvLog}"\n`);
  // uwsm-app is where Omarchy's chain leaves the launchers; hyprctl answers
  // that no window matches, as on a desktop with neither app open.
  writeExecutable(join(s.fakebin, "uwsm-app"), `#!/bin/sh\n[ "$1" = "--" ] && shift\nif [ "$1" = xdg-terminal-exec ]; then for a; do echo "terminal:$a"; done >> "${argvLog}"; exit 0; fi\nexec "$@"\n`);
  writeExecutable(join(s.fakebin, "hyprctl"), "#!/bin/sh\necho '[]'\n");
  assert.equal(s.run(["setup", "--apply", "--ui", "tui"]).status, 0);
  const p = plan(s);
  const shim = join(s.home, ".local/share/oats-omarchy/oats");
  const terminal = ["terminal:xdg-terminal-exec", "terminal:--app-id=org.oats.tui", "terminal:-e", `terminal:${shim}`, "terminal:tui", "terminal:--dir", `terminal:${s.deployment}`];

  // The TUI's desktop entry, launched by GLib as the app launcher does.
  const entry = join(s.home, ".local/share/applications/org.oats.tui.desktop");
  const gio = spawnSync("gio", ["launch", entry], { env: s.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(gio.status, 0, gio.stderr);
  waitFor(argvLog, terminal.length);
  assert.deepEqual(readFileSync(argvLog, "utf8").trim().split("\n"), terminal);

  // The key's command line, as Hyprland runs it (sh -c).
  writeFileSync(argvLog, "");
  const tuiCommand = p.keys.snippet.match(/o\.bind\("T", "OATS TUI", "(.*)"\)/)[1].replace(/\\(.)/g, "$1");
  assert.equal(spawnSync("sh", ["-c", tuiCommand], { env: s.env, encoding: "utf8" }).status, 0);
  waitFor(argvLog, terminal.length);
  assert.deepEqual(readFileSync(argvLog, "utf8").trim().split("\n"), terminal);

  writeFileSync(argvLog, "");
  const desktopCommand = p.keys.snippet.match(/o\.bind\("D", "OATS Desktop", "(.*)"\)/)[1].replace(/\\(.)/g, "$1");
  assert.equal(spawnSync("sh", ["-c", desktopCommand], { env: s.env, encoding: "utf8" }).status, 0);
  const extract = p.found.libfuse2.ok ? [] : ["desktop:--appimage-extract-and-run"];
  waitFor(argvLog, extract.length + 2);
  assert.deepEqual(readFileSync(argvLog, "utf8").trim().split("\n"), [...extract, "desktop:--dir", `desktop:${s.deployment}`]);
});

// The launchers detach (setsid); give the end of the chain a moment.
function waitFor(file, lines) {
  for (let i = 0; i < 50; i++) {
    if (existsSync(file) && readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length >= lines) return;
    spawnSync("sleep", ["0.1"]);
  }
}

// Omarchy's own menu parser, shell/plugins/menu/MenuModel.js. Menu.qml
// imports it as a JS library (`import "MenuModel.js" as MenuModel`); it is
// plain functions with no QML imports, so it runs as a script in a vm
// context. A `.pragma` or `.import` line, should one appear, is dropped first.
function menuModel() {
  const src = readFileSync(join(OMARCHY, "shell", "plugins", "menu", "MenuModel.js"), "utf8").replace(/^\s*\.(pragma|import)\b.*$/gm, "");
  const context = {};
  vm.runInNewContext(`${src}\nthis.parseMenuJsonc = parseMenuJsonc; this.mergeMenuSources = mergeMenuSources;`, context);
  // Plain objects of this realm, for deepEqual.
  const plain = (x) => JSON.parse(JSON.stringify(x));
  return { parse: (text) => plain(context.parseMenuJsonc(text)), merge: (a, b) => plain(context.mergeMenuSources(a, b)) };
}

for (const [name, text] of [
  ["no menu file", null],
  ["a user file with a trailing comma", '{\n  // mine\n  "mine": {"icon":"m","label":"Mine","action":"true"},\n  "system.lock": {"label":"Lock it"},\n}\n'],
  ["a user file without one", '{\n  "mine": {"icon":"m","label":"Mine","action":"true"}\n}'],
  ["a user file with an items wrapper", '{\n  "items": {\n    "mine": {"label":"Mine","action":"true"}\n  }\n}\n'],
]) {
  test(`Omarchy's MenuModel reads the oats block, the user's items unchanged: ${name}`, { skip }, (t) => {
    const s = omarchySandbox(t);
    const file = join(s.home, ".config", "omarchy", "extensions", "omarchy-menu.jsonc");
    if (text !== null) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); }
    const before = snapshot(s.home);
    const model = menuModel();
    const defaults = model.parse(readFileSync(join(OMARCHY, "default", "omarchy", "omarchy-menu.jsonc"), "utf8"));
    const userBefore = text === null ? [] : model.parse(text);
    assert.equal(s.run(["setup", "--apply"]).status, 0);

    const user = model.parse(readFileSync(file, "utf8"));
    const byId = Object.fromEntries(user.map((item) => [item.id, item]));
    for (const item of userBefore) assert.deepEqual(byId[item.id], item, `${item.id} reads the same`);
    const merged = model.merge(defaults, user);
    const x = merged.items["oats-ui"];
    assert.deepEqual([x.id, x.parent, x.kind, x.label], ["oats-ui", "root", "action", "OATS"]);
    assert.match(x.action, /^omarchy-launch-or-focus-tui --app-id=org\.oats\.tui /, "the only UI set up is the default");
    assert.deepEqual(user.map((item) => item.id).filter((id) => id === "oats" || id.startsWith("oats.")), [], "no submenu");
    for (const item of defaults) if (!byId[item.id]) assert.ok(merged.items[item.id], `Omarchy's ${item.id} is still there`);

    assert.equal(s.run(["setup", "--remove"]).status, 0);
    assert.deepEqual(snapshot(s.home), before);
  });
}

// The ranking of test/menu-search.test.mjs, with this Omarchy's own search
// code and whole menu definition, and the block setup writes here.
for (const ui of ["tui", "desktop"]) {
  test(`typing o, oa, oat, oats or OATS in SUPER + SPACE: with --ui ${ui}, the default UI's row is first, ranked by Omarchy's own MenuModel.js`, { skip }, (t) => {
    const s = omarchySandbox(t);
    const image = join(s.home, ".local/opt/oats-desktop/OATS-Desktop.AppImage");
    writeExecutable(image, "#!/bin/sh\nexit 0\n");
    assert.equal(s.run(["setup", "--apply", "--ui", ui]).status, 0);
    const user = readFileSync(join(s.home, ".config", "omarchy", "extensions", "omarchy-menu.jsonc"), "utf8");
    const defaults = readFileSync(join(OMARCHY, "default", "omarchy", "omarchy-menu.jsonc"), "utf8");
    const model = loadMenuModel(join(OMARCHY, "shell", "plugins", "menu", "MenuModel.js"));
    const apps = [appRow({ id: "org.oats.tui", name: files.TUI_NAME }), appRow({ id: "awebai-oats-desktop", name: files.DESKTOP_NAME })];
    const plugin = JSON.parse(readFileSync(join(discoverPaths(s.env).stateDir, "plugin.json"), "utf8"));
    const opens = plugin[ui].map(shellWord).join(" ");
    for (const query of ["o", "oa", "oat", "oats", "OATS"]) {
      const rows = search(model, { defaults, user, apps }, query);
      assert.equal(rows[0].itemId, "oats-ui", `${query}: ${JSON.stringify(rows.slice(0, 4))}`);
      assert.equal(rows[0].action, opens, query);
    }
  });
}

// The Default Agent row in Omarchy's own menu: under its real Setup > Default
// Agent (Omarchy infers the parent from the dotted id, so every id up the
// chain must be one of its menu's rows), with the root OATS row still first
// when "oats" is typed in SUPER + SPACE.
test("Omarchy's MenuModel reads the Default Agent row: OATS under its real Setup > Default Agent, and typing oats still shows the root OATS row first", { skip }, (t) => {
  const s = omarchySandbox(t);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const user = readFileSync(join(s.home, ".config", "omarchy", "extensions", "omarchy-menu.jsonc"), "utf8");
  const defaults = readFileSync(join(OMARCHY, "default", "omarchy", "omarchy-menu.jsonc"), "utf8");
  const model = loadMenuModel(join(OMARCHY, "shell", "plugins", "menu", "MenuModel.js"));
  const ours = model.parseMenuJsonc(user).map((x) => x.id);
  const { items } = model.mergeMenuSources(model.parseMenuJsonc(defaults), model.parseMenuJsonc(user));
  const row = items[menu.AGENT_ID];
  assert.ok(row, "the row is in the merged menu");
  assert.deepEqual([row.parent, row.kind, row.label, row.icon], ["setup.default.agent", "action", "OATS", items["oats-ui"].icon]);
  const chain = [];
  for (let id = row.parent; id !== "root"; id = items[id].parent) {
    assert.ok(items[id], `${id}, up from ${menu.AGENT_ID}, is a row of the menu`);
    assert.ok(!ours.includes(id), `${id} is Omarchy's, not setup's`);
    assert.equal(items[id].kind, "menu", id);
    chain.push(id);
    assert.ok(chain.length < 8, chain.join(" < "));
  }
  assert.deepEqual(chain, ["setup.default.agent", "setup.default", "setup"]);
  // The block as this version builds it from what setup recorded, the TUI
  // the only UI (the row's strings are pinned in test/menu.test.mjs), and the
  // row's check against the bind line setup writes.
  const p = discoverPaths(s.env);
  const state = stateOf(s);
  const expected = blocksFor({ shimPath: p.shim, deployment: state.deployment, node: state.node, pluginDir: state.pluginDir, tuiReady: true, desktopExec: null, ui: "tui", wrapper: p.wrapper, bindingsPath: managedPaths(p).keys }).menu;
  assert.ok(user.includes(expected), "the menu block is this version's");
  assert.equal(row.checked, menu.agentChecked({ bindings: managedPaths(p).keys, line: agentBindLine(p.wrapper) }));

  const apps = [appRow({ id: "org.oats.tui", name: files.TUI_NAME }), appRow({ id: "awebai-oats-desktop", name: files.DESKTOP_NAME })];
  const rows = search(model, { defaults, user, apps }, "oats");
  assert.equal(rows[0].itemId, "oats-ui", JSON.stringify(rows.slice(0, 4)));
  assert.ok(rows.some((x) => x.itemId === menu.AGENT_ID), `the Default Agent row is found too: ${rows.map((x) => x.itemId)}`);
});

test("waiting opens the chosen session through Omarchy's real floating terminal: the detach key arrives as argv", { skip }, (t) => {
  const s = omarchySandbox(t, { launchers: ["omarchy-menu-select"], deploymentName: "my agents" });
  const home = join(s.deployment, "agents", "x", "instances", "with space");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ agents: [{ instances: [{ instance: "with space", home, waitingOnYou: { reason: "attention" } }] }] }));
  // The end of Omarchy's chain: uwsm-app runs the terminal's -e command.
  writeExecutable(join(s.fakebin, "uwsm-app"), '#!/bin/bash\n[[ $1 == -- ]] && shift\nif [[ $1 == xdg-terminal-exec ]]; then while [[ $1 != -e ]]; do shift; done; shift; fi\nexec "$@"\n');
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const r = s.run(["waiting", "--dir", s.deployment], { FAKE_SELECT: "first" });
  assert.equal(r.status, 0, r.stderr);
  const log = join(s.root, "kernel.log");
  waitFor(log, 1);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), ["session", "attach", "--detach-key", "C-\\", "--home", home]);
});

test("the bar panel's row opens the same session through the real floating terminal, from the plugin.json setup wrote", { skip }, (t) => {
  const s = omarchySandbox(t, { deploymentName: "my agents" });
  const home = join(s.deployment, "agents", "x", "instances", "it's here");
  mkdirSync(home, { recursive: true });
  writeExecutable(join(s.fakebin, "uwsm-app"), '#!/bin/bash\n[[ $1 == -- ]] && shift\nif [[ $1 == xdg-terminal-exec ]]; then while [[ $1 != -e ]]; do shift; done; shift; fi\nexec "$@"\n');
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const plugin = widget.parsePlugin(readFileSync(join(s.home, ".local/state/oats-omarchy/plugin.json"), "utf8"));
  assert.ok(plugin, "setup wrote what the widget reads");
  // The bar's run: bash -lc <line>.
  const r = spawnSync("bash", ["-lc", widget.attachCommand(plugin, home)], { env: s.env, cwd: s.root, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const log = join(s.root, "kernel.log");
  waitFor(log, 1);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), ["session", "attach", "--detach-key", "C-\\", "--home", home]);
});

// The installer with the real Omarchy commands (omarchy-version among them),
// the container's own sh, coreutils and node (pacman's), and stand-ins for
// everything that installs: mise, omarchy-pkg-add, aw, the OATS CLI and the
// harness (test/helpers/install-world.mjs). Nothing is installed.
test("the installer: --check is not ready without aw and the OATS CLI; --now --harness pi runs its six steps and starts pi in ~/Work with the prompt", { skip }, (t) => {
  const w = installWorld(t, { system: [join(OMARCHY, "bin"), "/usr/bin", "/bin"] });
  // tmux, when the container has none: what omarchy-pkg-add would put on PATH.
  writeFileSync(join(w.root, "pkg-plan"), `printf '#!/bin/sh\\necho "tmux 3.5a"\\n' > '${join(w.other, "tmux")}'\nchmod 755 '${join(w.other, "tmux")}'\n`);
  const check = w.run(["--check"]);
  assert.equal(check.status, 1, check.out);
  assert.match(check.stdout, /^node: found \S+ \(pacman\)$/m);
  assert.match(check.stdout, /^aw: missing$/m);
  assert.match(check.stdout, /^oats: missing$/m);
  assert.match(check.stdout, /^steward: missing: node and the OATS CLI are needed to look for it$/m);

  miseInstalls(w, "pi", "pi", "0.40.1");
  miseInstalls(w, "aw", "npm:@awebai/aw", "1.36.47");
  miseInstalls(w, "oats", "npm:@awebai/oats", "0.67.1");
  const r = w.run(["--now", "--harness", "pi"]);
  process.stdout.write(r.out.replace(/^/gm, "# "));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(stepLines(r.stdout).map((l) => l.match(/^omarchy-install-oats: step \d\/6/)[0]), [1, 2, 3, 4, 5, 6].map((n) => `omarchy-install-oats: step ${n}/6`));
  assert.match(r.stdout, /^omarchy-install-oats: step 5\/6: skipped: /m);
  assert.match(r.stdout, /^omarchy-install-oats: installed oats 0\.67\.1 \(mise\)$/m);
  const h = harnessRun(w);
  assert.equal(h.cwd, join(w.home, "Work"));
  assert.equal(h.argv.length, 1, "the prompt, one argv element");
  const list = foundList(w);
  assert.ok(h.argv[0].includes(join(w.home, ".local", "state", "oats-omarchy", "found.json")));
  assert.ok(h.argv[0].includes(list.gettingStartedSkill));
  const version = spawnSync("omarchy-version", [], { env: w.env(), encoding: "utf8" }).stdout.trim().split(/\s+/)[0] || null;
  assert.equal(list.machine.omarchyVersion, version);
  assert.deepEqual(list.tools.map((x) => x.name), ["node", "tmux", "aw", "oats", "pi"]);
});
