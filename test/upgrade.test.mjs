// Upgrading a home that v0.3.0 set up: its key block (SUPER + O with T, D
// and O, no Space), its oats menu (no picker rows) and its plugin.json (no
// picker commands). --check reports each as drift with "run setup --apply
// again", --apply swaps only setup's own blocks (the key block verified with
// Hyprland on a temporary home first, as for a new one), and --remove still
// puts the home back exactly as it was before setup. The v0.3.0 bytes come
// from test/fixtures/v0.3.0/blocks.mjs, v0.3.0's own renderers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths as discoverPaths } from "../lib/discover.mjs";
import * as files from "../lib/files.mjs";
import * as menu from "../lib/menu.mjs";
import { digest } from "../lib/state.mjs";
import { parsePlugin } from "../widget.mjs";
import { keyBlock, menuBlock } from "./fixtures/v0.3.0/blocks.mjs";
import { sandbox, snapshot } from "./helpers/sandbox.mjs";

const USER_BINDINGS = '-- My bindings\no.bind("SUPER + RETURN", "Terminal", "uwsm-app -- xdg-terminal-exec")\n';
const USER_MENU = '{\n  "mine": {"label":"Mine","action":"true"}\n}\n';

function home(s) {
  const dir = join(s.home, ".config", "hypr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hyprland.lua"), 'require("hypr.bindings")\n');
  writeFileSync(join(dir, "bindings.lua"), USER_BINDINGS);
  const menuFile = join(s.home, ".config/omarchy/extensions/omarchy-menu.jsonc");
  mkdirSync(join(menuFile, ".."), { recursive: true });
  writeFileSync(menuFile, USER_MENU);
  return { bindings: join(dir, "bindings.lua"), menu: menuFile };
}

const statePath = (s) => join(discoverPaths(s.env).stateDir, "state.json");
const pluginPath = (s) => join(discoverPaths(s.env).stateDir, "plugin.json");
const part = (r, name) => r.json.result.parts.find((x) => x.part === name);
const hyprCalls = (s) => { try { return readFileSync(join(s.root, "hyprland.log"), "utf8").split("--\n").filter(Boolean).length; } catch { return 0; } };

// The home as v0.3.0's --apply left it: this version's --apply, then its
// key block, menu block and plugin.json put back as v0.3.0 wrote them, the
// state recording those, as v0.3.0's did.
function asV030(s, at) {
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const p = discoverPaths(s.env);
  const state = JSON.parse(readFileSync(statePath(s), "utf8"));
  const tui = files.tuiCommand({ shimPath: p.shim, deployment: s.deployment });
  const recorded = { node: state.node, pluginDir: state.pluginDir, deployment: state.deployment };
  const keys = state.files.find((f) => f.role === "keys");
  const oldKeys = keyBlock({ tui, desktop: null });
  const bytes = readFileSync(at.bindings, "utf8").replace(keys.block, oldKeys);
  writeFileSync(at.bindings, bytes);
  Object.assign(keys, { block: oldKeys, digest: digest(Buffer.from(bytes)) });
  const m = state.files.find((f) => f.role === "menu");
  const oldMenu = menuBlock({ tui, desktop: null, waiting: menu.waitingAction(recorded), status: menu.statusAction({ deployment: s.deployment, shimPath: p.shim, node: state.node, pluginDir: state.pluginDir }) });
  const inserted = m.inserted.replace(m.block, oldMenu);
  writeFileSync(at.menu, readFileSync(at.menu, "utf8").replace(m.inserted, inserted));
  Object.assign(m, { block: oldMenu, inserted });
  writeFileSync(statePath(s), `${JSON.stringify({ ...state, version: "0.3.0" }, null, 2)}\n`);
  const { agents: _a, spawn: _s, ...plugin } = JSON.parse(readFileSync(pluginPath(s), "utf8"));
  writeFileSync(pluginPath(s), `${JSON.stringify(plugin, null, 2)}\n`);
  return { oldKeys, oldMenu };
}

test("a v0.3.0 home: --check reports its key block, menu and plugin.json as drift, with run setup --apply again", (t) => {
  const s = sandbox(t);
  const at = home(s);
  asV030(s, at);
  const drift = s.run(["setup", "--check", "--json"]).json.result.drift;
  assert.deepEqual(drift, [
    `the oats menu in ${at.menu} is from an older setup (Open OATS, Agents and Souls open the OATS picker in this one): run setup --apply again`,
    `the oats key block in ${at.bindings} is from an older setup (SUPER + O, then Space opens the OATS picker in this one): run setup --apply again`,
    `the bar widget's ${pluginPath(s)} is from an older setup, without the OATS picker's commands: run setup --apply again`,
  ]);
  // The post-update hook prints the same lines (text mode).
  assert.equal(s.run(["setup", "--check"]).stdout, drift.map((line) => `oats-omarchy: ${line}\n`).join(""));
  // Without the picker's commands the widget still reads its file, and the
  // picker offers setup only.
  const plugin = parsePlugin(readFileSync(pluginPath(s), "utf8"));
  assert.ok(plugin && plugin.waiting.length > 0);
  assert.deepEqual([plugin.agents, plugin.spawn], [null, null]);
});

test("--apply over a v0.3.0 home swaps only setup's blocks, verified first; --check is then clean", (t) => {
  const s = sandbox(t);
  const at = home(s);
  const { oldKeys, oldMenu } = asV030(s, at);
  const keysBefore = readFileSync(at.bindings, "utf8");
  const menuBefore = readFileSync(at.menu, "utf8");
  const verifiedBefore = hyprCalls(s);
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "keys").status, "applied");
  assert.equal(part(r, "menu").status, "applied");
  assert.equal(hyprCalls(s), verifiedBefore + 2, "the unchanged copy, then the copy with the new block");

  const state = JSON.parse(readFileSync(statePath(s), "utf8"));
  assert.equal(state.version, "0.4.0");
  const keys = state.files.find((f) => f.role === "keys");
  assert.ok(keys.block.includes(`o.bind("SPACE", "Open OATS", "omarchy-shell shell toggle ai.aweb.oats '{}'")`));
  assert.equal(readFileSync(at.bindings, "utf8"), keysBefore.replace(oldKeys, keys.block), "every byte outside the block is as it was");
  assert.equal(keys.restorable, true, "the file is still the user's plus setup's block alone");
  const m = state.files.find((f) => f.role === "menu");
  assert.equal(readFileSync(at.menu, "utf8"), menuBefore.replace(oldMenu, m.block));
  assert.deepEqual(Object.keys(menu.omarchyParse(readFileSync(at.menu, "utf8")).items), ["mine", ...menu.IDS.filter((id) => id !== "oats.desktop")]);
  const plugin = parsePlugin(readFileSync(pluginPath(s), "utf8"));
  assert.deepEqual([plugin.agents.at(-1), plugin.spawn.at(-1).replace(/^.*\//, "")], [s.deployment, "spawn.mjs"]);

  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  assert.equal(part(s.run(["setup", "--apply", "--json"]), "keys").status, "already applied");
});

test("--remove after the upgrade restores the home exactly as it was before setup", (t) => {
  const s = sandbox(t);
  const at = home(s);
  const before = snapshot(s.home);
  asV030(s, at);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const r = s.run(["setup", "--remove"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(s.home), before);
});

test("a v0.3.0 home the user edited around the blocks: the upgrade keeps the edits, and --remove takes out the blocks alone", (t) => {
  const s = sandbox(t);
  const at = home(s);
  asV030(s, at);
  writeFileSync(at.bindings, `${readFileSync(at.bindings, "utf8")}o.bind("SUPER + P", "Mine", "true")\n`);
  writeFileSync(at.menu, readFileSync(at.menu, "utf8").replace('"mine"', '"first": {"label":"First"},\n  "mine"'));
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(part(r, "keys").status, "applied");
  const state = JSON.parse(readFileSync(statePath(s), "utf8"));
  assert.equal(state.files.find((f) => f.role === "keys").restorable, false);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(readFileSync(at.bindings, "utf8"), `${USER_BINDINGS}\no.bind("SUPER + P", "Mine", "true")\n`);
  assert.equal(readFileSync(at.menu, "utf8"), USER_MENU.replace('"mine"', '"first": {"label":"First"},\n  "mine"'));
});

// The fake Hyprland refuses any config holding setup's block, the v0.3.0
// one included: setup then finds the current config does not verify.
test("a v0.3.0 home whose config Hyprland refuses: the key part is skipped, the old block stays, the rest upgrades", (t) => {
  const s = sandbox(t);
  const at = home(s);
  const { oldKeys } = asV030(s, at);
  s.env.FAKE_HYPR_REFUSE_BLOCK = "1";
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(part(r, "keys").status, "skipped");
  assert.match(part(r, "keys").reason, /^your current Hyprland config does not verify, so setup does not add the key block/);
  assert.ok(readFileSync(at.bindings, "utf8").includes(oldKeys));
  assert.equal(part(r, "menu").status, "applied");
});
