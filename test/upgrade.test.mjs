// Upgrading a home that v0.3.0, v0.4.0, v0.5.0 or v0.6.0 set up. v0.3.0's
// key block (SUPER + O with T, D and O) is this version's too; its menu has
// no row for the default UI. v0.4.0's key block also binds Space to its
// picker, its menu has the picker's rows, and its plugin.json the picker's
// commands. v0.5.0's menu has the row for the default UI and the Agent team
// submenu. Those three named the TUI's launcher entry OATS. v0.6.0 wrote
// v0.3.0's key block, the entry named OATS TUI, and a menu with the default
// UI's row alone (no Default Agent row). None of them wrote the launcher,
// omarchy-launch-oats, or recorded the agent key. --check reports each block
// that differs, and the TUI's entry, as drift with "run setup --apply
// again", and the launcher and the agent key as new in this version.
// --apply swaps only setup's own blocks (a key block verified with Hyprland
// on a temporary home first, as for a new one), rewrites the entry and
// writes the launcher; without --agent-key and a terminal the agent key
// stays with Omarchy, and with --agent-key oats its section goes into the
// recorded key block in place. --remove still puts the home back exactly as
// it was before setup. The old bytes come from test/fixtures/v0.3.0,
// v0.4.0, v0.5.0 and v0.6.0, those versions' renderers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { END as KEYS_END } from "../lib/bindings.mjs";
import { paths as discoverPaths } from "../lib/discover.mjs";
import * as files from "../lib/files.mjs";
import * as menu from "../lib/menu.mjs";
import { luaString, shellWord } from "../lib/quote.mjs";
import { NOT_CHOSEN } from "../lib/setup.mjs";
import { digest } from "../lib/state.mjs";
import { parsePlugin } from "../widget.mjs";
import * as v030 from "./fixtures/v0.3.0/blocks.mjs";
import * as v040 from "./fixtures/v0.4.0/blocks.mjs";
import * as v050 from "./fixtures/v0.5.0/blocks.mjs";
import * as v060 from "./fixtures/v0.6.0/blocks.mjs";
import { sandbox, snapshot } from "./helpers/sandbox.mjs";

const USER_BINDINGS = '-- My bindings\no.bind("SUPER + RETURN", "Terminal", "uwsm-app -- xdg-terminal-exec")\n';
const USER_MENU = '{\n  "mine": {"label":"Mine","action":"true"}\n}\n';
const VERSIONS = { "0.3.0": v030, "0.4.0": v040, "0.5.0": v050, "0.6.0": v060 };
// The versions that recorded the default UI (`ui` in the state and plugin.json).
const RECORDED_UI = new Set(["0.5.0", "0.6.0"]);

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
const wrapperPath = (s) => discoverPaths(s.env).wrapper;
const newParts = (s) => `the launcher ${wrapperPath(s)} and the agent key are new in this version of setup and not applied yet (the agent key stays with Omarchy until you pick OATS): run setup --apply again`;
// The agent key's section of the key block, written out rather than taken
// from lib/keys.mjs, so a change to what setup writes shows here.
const agentSection = (wrapper) => `-- OATS: SUPER + SHIFT + CTRL + A opens the machine's steward (omarchy-launch-oats).
hl.unbind("SUPER + SHIFT + CTRL + A")
o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", ${luaString(shellWord(wrapper))})
`;
const hyprCalls = (s) => { try { return readFileSync(join(s.root, "hyprland.log"), "utf8").split("--\n").filter(Boolean).length; } catch { return 0; } };

// The home as `version`'s --apply left it: this version's --apply (the TUI
// alone, so there is no default UI to choose, and no terminal, so the agent
// key is not asked about), then its key block, menu block, TUI entry and
// plugin.json put back as that version wrote them, and the state recording
// those, as that version's did (no default UI chosen; no `ui` before
// v0.5.0, and never an `agentKey`). No version before this one wrote the
// launcher: it goes, with its record, and so does ~/.local/bin when this
// --apply created it.
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
  // v0.3.0 and v0.4.0 wrote v0.5.0's entry (named OATS).
  const oldEntry = Buffer.from((old.tuiEntry ?? v050.tuiEntry)({ shimPath: p.shim, deployment: s.deployment }));
  writeFileSync(entry.path, oldEntry);
  entry.digest = digest(oldEntry);
  const launcher = state.files.find((f) => f.role === "launcher");
  assert.equal(launcher.path, p.wrapper);
  unlinkSync(launcher.path);
  const bin = dirname(launcher.path);
  if (state.dirs.includes(bin)) rmdirSync(bin);
  const oldState = {
    ...state,
    files: state.files.filter((f) => f !== launcher),
    dirs: state.dirs.filter((d) => d !== bin),
    parts: state.parts.filter((x) => x !== "launcher"),
    version,
  };
  delete oldState.agentKey;
  if (!RECORDED_UI.has(version)) delete oldState.ui;
  writeFileSync(statePath(s), `${JSON.stringify(oldState, null, 2)}\n`);
  const plugin = JSON.parse(readFileSync(pluginPath(s), "utf8"));
  if (!RECORDED_UI.has(version)) delete plugin.ui;
  writeFileSync(pluginPath(s), `${JSON.stringify(version === "0.4.0" ? { ...plugin, ...v040.pickerCommands(recorded) } : plugin, null, 2)}\n`);
  return { oldKeys, oldMenu, entry: entry.path };
}

for (const version of Object.keys(VERSIONS)) {
  const keysChange = version === "0.4.0";
  // v0.6.0 named the TUI's entry OATS TUI already.
  const entryChange = version !== "0.6.0";
  const drifted = [keysChange ? "menu, key block" : "menu", entryChange ? "TUI entry" : null].filter(Boolean).join(" and ");

  test(`a v${version} home: --check reports its ${drifted} as drift, and the launcher and agent key as new, with run setup --apply again`, (t) => {
    const s = sandbox(t);
    const at = home(s);
    const { entry } = asOld(s, at, version);
    const drift = s.run(["setup", "--check", "--json"]).json.result.drift;
    assert.deepEqual([...drift].sort(), [
      `the oats menu in ${at.menu} is from another version of setup: run setup --apply again`,
      ...(keysChange ? [`the oats key block in ${at.bindings} is from another version of setup: run setup --apply again`] : []),
      ...(entryChange ? [`the TUI's launcher entry ${entry} is from another version of setup: run setup --apply again`] : []),
      newParts(s),
    ].sort());
    // The post-update hook prints the same lines (text mode).
    assert.equal(s.run(["setup", "--check"]).stdout, drift.map((line) => `oats-omarchy: ${line}\n`).join(""));
    // The widget still reads its plugin.json: the TUI is its default UI.
    const plugin = parsePlugin(readFileSync(pluginPath(s), "utf8"));
    assert.ok(plugin && plugin.waiting.length > 0);
    assert.equal(plugin.ui, "tui");
  });

  test(`--apply over a v${version} home swaps only setup's blocks${keysChange ? ", the key block verified first" : ""}, writes the launcher and leaves the agent key with Omarchy; --check is then clean`, (t) => {
    const s = sandbox(t);
    const at = home(s);
    const { oldKeys, oldMenu, entry } = asOld(s, at, version);
    const keysBefore = readFileSync(at.bindings, "utf8");
    const menuBefore = readFileSync(at.menu, "utf8");
    const verifiedBefore = hyprCalls(s);
    // No --agent-key, and no terminal to ask in.
    const r = s.run(["setup", "--apply", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(part(r, "keys").status, keysChange ? "applied" : "already applied");
    assert.equal(part(r, "menu").status, "applied");
    assert.equal(part(r, "tui").status, entryChange ? "applied" : "already applied");
    assert.equal(part(r, "launcher").status, "applied");
    assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "skipped", reason: NOT_CHOSEN, paths: [] });
    assert.equal(r.json.result.agentKey.choice, null);
    assert.match(readFileSync(entry, "utf8"), /^Name=OATS TUI$/m);
    assert.equal(hyprCalls(s), verifiedBefore + (keysChange ? 2 : 0), keysChange ? "the unchanged copy, then the copy with the new block" : "an unchanged key block is not verified again");

    const state = JSON.parse(readFileSync(statePath(s), "utf8"));
    assert.equal(state.version, "0.6.0");
    assert.ok(Object.hasOwn(state, "agentKey"));
    assert.equal(state.agentKey, null, "nobody picked: the agent key stays with Omarchy");
    const keys = state.files.find((f) => f.role === "keys");
    assert.equal(keys.block, v030.keyBlock({ tui: files.tuiCommand({ shimPath: discoverPaths(s.env).shim, deployment: s.deployment }), desktop: null }), "v0.3.0's key block again, with no agent key section");
    assert.ok(!keys.block.includes("SPACE"));
    assert.ok(!readFileSync(at.bindings, "utf8").includes("SUPER + SHIFT + CTRL + A"));
    assert.equal(readFileSync(at.bindings, "utf8"), keysBefore.replace(oldKeys, keys.block), "every byte outside the block is as it was");
    assert.equal(keys.restorable, true, "the file is still the user's plus setup's block alone");
    const m = state.files.find((f) => f.role === "menu");
    assert.equal(readFileSync(at.menu, "utf8"), menuBefore.replace(oldMenu, m.block));
    assert.deepEqual(Object.keys(menu.omarchyParse(readFileSync(at.menu, "utf8")).items), ["mine", "oats-ui", "setup.default.agent.oats"], "the Default Agent row is there, the key with Omarchy or not");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(pluginPath(s), "utf8"))), ["deployment", "tui", "desktop", "ui", "waiting", "attach", "setup"], "plugin.json as this version writes it");

    // The launcher, recorded, in a ~/.local/bin setup made again.
    const wrapper = wrapperPath(s);
    assert.equal(readFileSync(wrapper, "utf8"), files.launcher({ node: state.node, pluginDir: state.pluginDir }));
    assert.equal(statSync(wrapper).mode & 0o777, 0o755);
    assert.deepEqual(state.files.filter((f) => f.role === "launcher").map((f) => f.path), [wrapper]);
    assert.ok(state.dirs.includes(dirname(wrapper)));

    assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
    assert.equal(part(s.run(["setup", "--apply", "--json"]), "keys").status, "already applied");
  });

  test(`--remove after upgrading a v${version} home restores the home exactly as it was before setup`, (t) => {
    const s = sandbox(t);
    const at = home(s);
    const before = snapshot(s.home);
    asOld(s, at, version);
    assert.ok(!existsSync(wrapperPath(s)) && !existsSync(dirname(wrapperPath(s))), "the old home has no launcher");
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

// A v0.6.0 home whose person picks OATS for the agent key: the section goes
// into the key block v0.6.0 wrote, after its SUPER + O lines, in place, and
// the whole candidate is verified first.
test("--apply --agent-key oats over a v0.6.0 home adds the agent key to its key block in place, verified first; --check is then clean", (t) => {
  const s = sandbox(t);
  const at = home(s);
  const { oldKeys } = asOld(s, at, "0.6.0");
  const keysBefore = readFileSync(at.bindings, "utf8");
  const verifiedBefore = hyprCalls(s);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "keys").status, "already applied", "the SUPER + O section is v0.6.0's");
  assert.equal(part(r, "agent-key").status, "applied");
  assert.equal(part(r, "launcher").status, "applied");
  assert.equal(part(r, "menu").status, "applied");
  assert.deepEqual([r.json.result.agentKey.choice, r.json.result.agentKey.from], ["oats", "--agent-key"]);
  assert.equal(hyprCalls(s), verifiedBefore + 2, "the unchanged copy, then the copy with the agent key");

  const wrapper = wrapperPath(s);
  const expected = oldKeys.replace(KEYS_END, `${agentSection(wrapper)}${KEYS_END}`);
  const state = JSON.parse(readFileSync(statePath(s), "utf8"));
  assert.equal(state.agentKey, "oats");
  const keys = state.files.find((f) => f.role === "keys");
  assert.equal(keys.block, expected);
  assert.equal(readFileSync(at.bindings, "utf8"), keysBefore.replace(oldKeys, expected), "every byte outside the block is as it was");
  assert.equal(keys.restorable, true, "the file is still the user's plus setup's block alone");
  // The line the menu's Default Agent row looks for, whole.
  assert.ok(readFileSync(at.bindings, "utf8").split("\n").includes(`o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", ${luaString(shellWord(wrapper))})`));
  assert.ok(existsSync(wrapper));

  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  // The choice is kept, and an unchanged block is not verified again.
  const again = s.run(["setup", "--apply", "--json"]);
  assert.equal(part(again, "agent-key").status, "already applied");
  assert.equal(part(again, "keys").status, "already applied");
  assert.equal(hyprCalls(s), verifiedBefore + 2);
});

test("--remove after a v0.6.0 home's upgrade with --agent-key oats restores the home exactly as it was before setup", (t) => {
  const s = sandbox(t);
  const at = home(s);
  const before = snapshot(s.home);
  asOld(s, at, "0.6.0");
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  const r = s.run(["setup", "--remove"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(s.home), before);
});
