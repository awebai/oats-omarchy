// Upgrading a home that v0.3.0, v0.4.0 or v0.5.0 set up. v0.3.0's key block
// (SUPER + O with T, D and O) is this version's too; its menu has no row for
// the default UI. v0.4.0's key block also binds Space to its picker, its menu
// has the picker's rows, and its plugin.json the picker's commands. v0.5.0's
// menu has the row for the default UI and the Agent team submenu. All three
// named the TUI's launcher entry OATS. --check reports each block that
// differs, and the TUI's entry, as drift with "run setup --apply again",
// --apply swaps only setup's own blocks (a key block verified with Hyprland
// on a temporary home first, as for a new one) and rewrites the entry, and
// --remove still puts the home back exactly as it was before setup. The old
// bytes come from test/fixtures/v0.3.0, v0.4.0 and v0.5.0, those versions'
// renderers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths as discoverPaths } from "../lib/discover.mjs";
import * as files from "../lib/files.mjs";
import * as menu from "../lib/menu.mjs";
import { digest } from "../lib/state.mjs";
import { parsePlugin } from "../widget.mjs";
import * as v030 from "./fixtures/v0.3.0/blocks.mjs";
import * as v040 from "./fixtures/v0.4.0/blocks.mjs";
import * as v050 from "./fixtures/v0.5.0/blocks.mjs";
import { sandbox, snapshot } from "./helpers/sandbox.mjs";

const USER_BINDINGS = '-- My bindings\no.bind("SUPER + RETURN", "Terminal", "uwsm-app -- xdg-terminal-exec")\n';
const USER_MENU = '{\n  "mine": {"label":"Mine","action":"true"}\n}\n';
const VERSIONS = { "0.3.0": v030, "0.4.0": v040, "0.5.0": v050 };

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

// The home as `version`'s --apply left it: this version's --apply (the TUI
// alone, so there is no default UI to choose), then its key block, menu
// block, TUI entry and plugin.json put back as that version wrote them, and
// the state recording those, as that version's did (no default UI chosen).
function asOld(s, at, version) {
  const old = VERSIONS[version];
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const p = discoverPaths(s.env);
  const state = JSON.parse(readFileSync(statePath(s), "utf8"));
  const tui = files.tuiCommand({ shimPath: p.shim, deployment: s.deployment });
  const recorded = { node: state.node, pluginDir: state.pluginDir, deployment: state.deployment };
  const keys = state.files.find((f) => f.role === "keys");
  const oldKeys = old.keyBlock({ tui, desktop: null });
  const bytes = readFileSync(at.bindings, "utf8").replace(keys.block, oldKeys);
  writeFileSync(at.bindings, bytes);
  Object.assign(keys, { block: oldKeys, digest: digest(Buffer.from(bytes)) });
  const m = state.files.find((f) => f.role === "menu");
  const oldMenu = old.menuBlock({ ui: "tui", tui, desktop: null, waiting: v050.waitingAction(recorded), status: v050.statusAction({ deployment: s.deployment, shimPath: p.shim, node: state.node, pluginDir: state.pluginDir }) });
  const inserted = m.inserted.replace(m.block, oldMenu);
  writeFileSync(at.menu, readFileSync(at.menu, "utf8").replace(m.inserted, inserted));
  Object.assign(m, { block: oldMenu, inserted });
  const entry = state.files.find((f) => f.role === "tui-entry");
  const oldEntry = Buffer.from(v050.tuiEntry({ shimPath: p.shim, deployment: s.deployment }));
  writeFileSync(entry.path, oldEntry);
  entry.digest = digest(oldEntry);
  const { ui: _ui, ...rest } = state;
  writeFileSync(statePath(s), `${JSON.stringify({ ...rest, version }, null, 2)}\n`);
  const { ui: _p, ...plugin } = JSON.parse(readFileSync(pluginPath(s), "utf8"));
  writeFileSync(pluginPath(s), `${JSON.stringify(version === "0.4.0" ? { ...plugin, ...v040.pickerCommands(recorded) } : plugin, null, 2)}\n`);
  return { oldKeys, oldMenu, entry: entry.path };
}

for (const version of Object.keys(VERSIONS)) {
  const keysChange = version === "0.4.0";

  test(`a v${version} home: --check reports its ${keysChange ? "menu, key block" : "menu"} and TUI entry as drift, with run setup --apply again`, (t) => {
    const s = sandbox(t);
    const at = home(s);
    const { entry } = asOld(s, at, version);
    const drift = s.run(["setup", "--check", "--json"]).json.result.drift;
    assert.deepEqual([...drift].sort(), [
      `the oats menu in ${at.menu} is from another version of setup: run setup --apply again`,
      ...(keysChange ? [`the oats key block in ${at.bindings} is from another version of setup: run setup --apply again`] : []),
      `the TUI's launcher entry ${entry} is from another version of setup: run setup --apply again`,
    ].sort());
    // The post-update hook prints the same lines (text mode).
    assert.equal(s.run(["setup", "--check"]).stdout, drift.map((line) => `oats-omarchy: ${line}\n`).join(""));
    // The widget still reads its plugin.json: the TUI is its default UI.
    const plugin = parsePlugin(readFileSync(pluginPath(s), "utf8"));
    assert.ok(plugin && plugin.waiting.length > 0);
    assert.equal(plugin.ui, "tui");
  });

  test(`--apply over a v${version} home swaps only setup's blocks${keysChange ? ", the key block verified first" : ""}; --check is then clean`, (t) => {
    const s = sandbox(t);
    const at = home(s);
    const { oldKeys, oldMenu, entry } = asOld(s, at, version);
    const keysBefore = readFileSync(at.bindings, "utf8");
    const menuBefore = readFileSync(at.menu, "utf8");
    const verifiedBefore = hyprCalls(s);
    const r = s.run(["setup", "--apply", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(part(r, "keys").status, keysChange ? "applied" : "already applied");
    assert.equal(part(r, "menu").status, "applied");
    assert.equal(part(r, "tui").status, "applied");
    assert.match(readFileSync(entry, "utf8"), /^Name=OATS TUI$/m);
    assert.equal(hyprCalls(s), verifiedBefore + (keysChange ? 2 : 0), keysChange ? "the unchanged copy, then the copy with the new block" : "an unchanged key block is not verified again");

    const state = JSON.parse(readFileSync(statePath(s), "utf8"));
    assert.equal(state.version, "0.5.0");
    const keys = state.files.find((f) => f.role === "keys");
    assert.equal(keys.block, v030.keyBlock({ tui: files.tuiCommand({ shimPath: discoverPaths(s.env).shim, deployment: s.deployment }), desktop: null }), "v0.3.0's key block again");
    assert.ok(!keys.block.includes("SPACE"));
    assert.equal(readFileSync(at.bindings, "utf8"), keysBefore.replace(oldKeys, keys.block), "every byte outside the block is as it was");
    assert.equal(keys.restorable, true, "the file is still the user's plus setup's block alone");
    const m = state.files.find((f) => f.role === "menu");
    assert.equal(readFileSync(at.menu, "utf8"), menuBefore.replace(oldMenu, m.block));
    assert.deepEqual(Object.keys(menu.omarchyParse(readFileSync(at.menu, "utf8")).items), ["mine", ...menu.IDS]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(pluginPath(s), "utf8"))), ["deployment", "tui", "desktop", "ui", "waiting", "attach", "setup"], "plugin.json as this version writes it");

    assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
    assert.equal(part(s.run(["setup", "--apply", "--json"]), "keys").status, "already applied");
  });

  test(`--remove after upgrading a v${version} home restores the home exactly as it was before setup`, (t) => {
    const s = sandbox(t);
    const at = home(s);
    const before = snapshot(s.home);
    asOld(s, at, version);
    assert.equal(s.run(["setup", "--apply"]).status, 0);
    const r = s.run(["setup", "--remove"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(snapshot(s.home), before);
  });

  test(`a v${version} home the user edited around the blocks: the upgrade keeps the edits, and --remove takes out the blocks alone`, (t) => {
    const s = sandbox(t);
    const at = home(s);
    asOld(s, at, version);
    writeFileSync(at.bindings, `${readFileSync(at.bindings, "utf8")}o.bind("SUPER + P", "Mine", "true")\n`);
    writeFileSync(at.menu, readFileSync(at.menu, "utf8").replace('"mine"', '"first": {"label":"First"},\n  "mine"'));
    const r = s.run(["setup", "--apply", "--json"]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(part(r, "keys").status, keysChange ? "applied" : "already applied");
    if (keysChange) assert.equal(JSON.parse(readFileSync(statePath(s), "utf8")).files.find((f) => f.role === "keys").restorable, false);
    assert.equal(s.run(["setup", "--remove"]).status, 0);
    assert.equal(readFileSync(at.bindings, "utf8"), `${USER_BINDINGS}\no.bind("SUPER + P", "Mine", "true")\n`);
    assert.equal(readFileSync(at.menu, "utf8"), USER_MENU.replace('"mine"', '"first": {"label":"First"},\n  "mine"'));
  });
}

// The fake Hyprland refuses any config holding setup's block, the v0.4.0
// one included: setup then finds the current config does not verify.
test("a v0.4.0 home whose config Hyprland refuses: the key part is skipped, the old block stays, the menu upgrades", (t) => {
  const s = sandbox(t);
  const at = home(s);
  const { oldKeys } = asOld(s, at, "0.4.0");
  s.env.FAKE_HYPR_REFUSE_BLOCK = "1";
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(part(r, "keys").status, "skipped");
  assert.match(part(r, "keys").reason, /^your current Hyprland config does not verify, so setup does not add the key block/);
  assert.ok(readFileSync(at.bindings, "utf8").includes(oldKeys));
  assert.equal(part(r, "menu").status, "applied");
});
