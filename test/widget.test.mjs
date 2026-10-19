// The plugin's manifest and its bar widget. Every command line the widget
// hands to the bar is built by widget.mjs and run here through bash, with
// stand-ins for the Omarchy launchers, the shim and node that log their
// argv, so the quoting is proven end to end; and what the widget reads
// (plugin.json, `waiting --json`) is parsed as the QML does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as W from "../widget.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const HOSTILE = "it's a $(touch pwned) `x` dir";

test("manifest: a bar widget and an overlay whose id and entry points Omarchy's validator accepts, with no refresh setting", () => {
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(m.schemaVersion, 1);
  for (const field of ["id", "name", "version", "kinds", "entryPoints"]) assert.ok(m[field], field);
  assert.match(m.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(!m.id.startsWith("omarchy.") && !m.id.includes(".."));
  assert.deepEqual(m.kinds, ["bar-widget", "overlay"]);
  assert.ok(existsSync(join(root, m.entryPoints.barWidget)), m.entryPoints.barWidget);
  assert.equal(m.entryPoints.overlay, "OatsPicker.qml");
  assert.ok(existsSync(join(root, m.entryPoints.overlay)));
  assert.equal(m.barWidget.defaults, undefined, "nothing is read in the background, so there is no interval");
  assert.equal(m.barWidget.schema, undefined);
  const qml = readFileSync(join(root, m.entryPoints.barWidget), "utf8");
  // Nothing on a timer but the read's own deadline, and no count beside the icon.
  assert.equal((qml.match(/\bTimer \{/g) || []).length, 1);
  assert.match(qml, /Timer \{\s*id: readTimeout/);
  assert.doesNotMatch(qml, /refreshIntervalSec|badge|triggeredOnStart/);
  assert.match(qml, /moduleName: "ai\.aweb\.oats"/);
  assert.match(qml, /import "widget\.mjs" as Widget/);
  // It runs commands only through the bar and its one reader, and writes nothing.
  assert.equal((qml.match(/\bProcess \{/g) || []).length, 1);
  assert.doesNotMatch(qml, /execDetached|atomicWrites|setText|\.write\(/);

  // The picker reads on open only: one Process, and one Timer, the read's
  // deadline, which does not repeat. It runs argv only (no shell line).
  const picker = readFileSync(join(root, m.entryPoints.overlay), "utf8");
  assert.equal((picker.match(/\bTimer \{/g) || []).length, 1);
  assert.match(picker, /Timer \{\s*id: readTimeout[^}]*repeat: false/);
  assert.doesNotMatch(picker, /repeat: true|triggeredOnStart|refreshIntervalSec/);
  assert.equal((picker.match(/\bProcess \{/g) || []).length, 1);
  assert.match(picker, /import "picker\.mjs" as Picker/);
  assert.match(picker, /Util\.execArgv\(argv\)/);
  assert.doesNotMatch(picker, /execDetached|atomicWrites|setText|\.write\(|Color\.\w+\s*\(|"#[0-9a-fA-F]{3,8}"/);
});

test("shellQuote, urlPath, commandLine", () => {
  assert.equal(W.shellQuote("a b"), "'a b'");
  assert.equal(W.shellQuote("it's"), "'it'\\''s'");
  assert.equal(W.urlPath("file:///home/a%20b/it's/setup"), "/home/a b/it's/setup");
  assert.equal(W.commandLine(["a b", "c"]), "'a b' 'c'");
});

test("plugin.json: its path as setup finds it, and only what setup writes is read", () => {
  assert.equal(W.pluginFilePath("/h", ""), "/h/.local/state/oats-omarchy/plugin.json");
  assert.equal(W.pluginFilePath("/h", "/x/state"), "/x/state/oats-omarchy/plugin.json");
  assert.equal(W.pluginFilePath("/h", "relative"), "/h/.local/state/oats-omarchy/plugin.json");
  const good = { deployment: "/d", tui: ["t"], desktop: null, waiting: ["n", "w"], attach: ["s", "--home"], setup: ["n", "s"], agents: ["n", "a", "--dir", "/d"], spawn: ["n", "sp"] };
  assert.deepEqual(W.parsePlugin(JSON.stringify(good)), good);
  // A plugin.json from before 0.4.0: no picker commands, the rest as it was.
  const { agents: _a, spawn: _s, ...old } = good;
  assert.deepEqual(W.parsePlugin(JSON.stringify(old)), { ...old, agents: null, spawn: null });
  assert.deepEqual(W.parsePlugin(JSON.stringify({ ...good, spawn: null })), { ...good, agents: null, spawn: null }, "both or neither");
  for (const bad of ["", "not json", "{}", JSON.stringify({ ...good, waiting: [] }), JSON.stringify({ ...good, tui: "t" }), JSON.stringify({ ...good, attach: [1] })]) {
    assert.equal(W.parsePlugin(bad), null, bad);
  }
  assert.deepEqual(W.readArgv(good), ["n", "w", "--json"]);
});

test("the read: the rows waiting on you, or why it failed", () => {
  const rows = [{ instance: "a", home: "/h/a" }, { instance: "b", home: "/h/b" }];
  const two = W.parseWaiting(JSON.stringify({ ok: true, count: 2, rows }));
  const groups = [{ title: "", rows: rows.map((r) => ({ ...r, label: r.instance, waitingOnYou: null })), unknown: [] }];
  assert.deepEqual(two, { known: true, count: 2, rows, groups, note: "" });
  assert.deepEqual(W.parseWaiting(JSON.stringify({ ok: true, count: 0, rows: [] })), { known: true, count: 0, rows: [], groups: [], note: "" });
  const failed = W.parseWaiting(JSON.stringify({ ok: false, reason: "oats-lock.json is unreadable" }));
  assert.deepEqual(failed, { known: false, reason: "oats-lock.json is unreadable" });
  assert.deepEqual(W.parseWaiting(""), { known: false, reason: "waiting --json printed no result" }, "no output: the read failed");
  assert.equal(W.parseWaiting("{\"ok\":tr").known, false, "a read cut short");
  assert.equal(W.READ_TIMEOUT_MS, 30000);
});

test("the read state: one read at a time; opening the panel again does not move the deadline; only the deadline settles a read that never started", () => {
  const state = W.newReadState();
  // A read whose program never starts (no output ever).
  const first = W.beginRead(state);
  assert.equal(first, 1);
  assert.equal(W.beginRead(state), 0, "opening the panel again starts nothing");
  assert.deepEqual(W.expireRead(state, first), { known: false, reason: W.READ_TIMEOUT_REASON }, "the deadline at 30 s settles it");
  assert.equal(W.expireRead(state, first), null, "once");
  const second = W.beginRead(state);
  assert.equal(second, 2, "the next opening reads again");
  assert.equal(W.finishRead(state, first, '{"ok":true,"count":1,"rows":[]}'), null, "output of a read stopped at its deadline is ignored");
  assert.deepEqual(W.finishRead(state, second, '{"ok":true,"count":0,"rows":[]}'), { known: true, count: 0, rows: [], groups: [], note: "" });
  assert.equal(W.expireRead(state, second), null, "a finished read has no deadline left");
  assert.equal(W.finishRead(state, second, "{}"), null, "nor a second result");
});

test("the one reader for every bar", () => {
  const a = {}, b = {};
  assert.equal(W.isReader([a, b], a), true);
  assert.equal(W.isReader([a, b], b), false);
  assert.equal(W.isReader([], b), true, "a bar that lists none: each reads for itself");
  assert.equal(W.isReader([a], b), true, "a bar that does not list it");
});

// A world where every program the commands name logs its argv, one per
// line, after its own name; paths are hostile, so a quoting slip runs code.
function world(t) {
  const dir = mkdtempSync(join(tmpdir(), "oats-widget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const log = join(dir, "log");
  const odd = join(dir, HOSTILE);
  for (const d of [bin, odd]) mkdirSync(d, { recursive: true });
  const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
  const logger = (name) => `#!/bin/sh\nprintf '%s\\n' '${name}' "$@" >> '${log}'\n`;
  for (const name of ["omarchy-launch-or-focus-tui", "omarchy-launch-or-focus", "omarchy-shell"]) exe(join(bin, name), logger(name));
  // As Omarchy 4.0.4's launcher does: its arguments are one bash command line.
  exe(join(bin, "omarchy-launch-floating-terminal-with-presentation"), `#!/bin/bash\ncmd="$*"\nexec bash -c "$cmd"\n`);
  for (const name of ["shim", "node", "setup"]) exe(join(odd, name), logger(name));
  exe(join(odd, "spawn.mjs"), logger("spawn.mjs"));
  const plugin = {
    deployment: join(odd, "deployment"),
    tui: ["omarchy-launch-or-focus-tui", "--app-id=org.oats.tui", `'${join(odd, "shim")}'`, "tui"],
    desktop: ["omarchy-launch-or-focus", "awebai-oats-desktop", `uwsm-app -- '${join(odd, "app")}'`],
    waiting: [join(odd, "node"), join(odd, "waiting.mjs"), "--dir", join(odd, "deployment")],
    attach: [join(odd, "shim"), "session", "attach", "--detach-key", "M-o", "--home"],
    setup: [join(odd, "node"), join(odd, "setup.mjs"), "--dir", join(odd, "deployment")],
    agents: [join(odd, "node"), join(odd, "agents.mjs"), "--dir", join(odd, "deployment")],
    spawn: [join(odd, "node"), join(odd, "spawn.mjs")],
  };
  // The bar's run: `bash -lc <line>`; -c here, so no profile of this machine is read.
  const run = (line) => {
    rmSync(log, { force: true });
    const r = spawnSync("bash", ["-c", line], { cwd: dir, encoding: "utf8", timeout: 10000, env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(dir, "pwned")), "a path was not run as a command");
    return readFileSync(log, "utf8").split("\n").slice(0, -1);
  };
  // The picker's run: argv, with no shell (Omarchy's Util.execArgv).
  const runArgv = (argv) => {
    rmSync(log, { force: true });
    const r = spawnSync(argv[0], argv.slice(1), { cwd: dir, encoding: "utf8", timeout: 10000, env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(dir, "pwned")), "a path was not run as a command");
    return readFileSync(log, "utf8").split("\n").slice(0, -1);
  };
  return { dir, odd, plugin, run, runArgv };
}

test("the panel's TUI and Desktop run the argv setup recorded, word for word", (t) => {
  const w = world(t);
  assert.deepEqual(w.run(W.tuiCommand(w.plugin)), w.plugin.tui);
  assert.deepEqual(w.run(W.desktopCommand(w.plugin)), w.plugin.desktop);
  assert.equal(W.tuiCommand({ ...w.plugin, tui: null }), "", "no TUI part: no button");
  assert.equal(W.desktopCommand({ ...w.plugin, desktop: null }), "");
});

test("a waiting row opens its session in the floating terminal: the home reaches the kernel as one argument", (t) => {
  const w = world(t);
  const home = join(w.odd, "instances", "with space 'and' $(quotes)");
  assert.deepEqual(w.run(W.attachCommand(w.plugin, home)), ["shim", "session", "attach", "--detach-key", "M-o", "--home", home]);
  assert.equal(W.detachKey(w.plugin), true);
  const without = { ...w.plugin, attach: [join(w.odd, "shim"), "session", "attach", "--home"] };
  assert.deepEqual(w.run(W.attachCommand(without, home)), ["shim", "session", "attach", "--home", home]);
  assert.equal(W.detachKey(without), false, "no feature: no key, and no Alt+O line");
});

test("setup from the panel: --apply for the recorded deployment, or the plugin's setup --apply before it has run", (t) => {
  const w = world(t);
  assert.deepEqual(w.run(W.setupCommand(w.plugin, join(w.odd, "setup"))), ["node", join(w.odd, "setup.mjs"), "--dir", join(w.odd, "deployment"), "--apply"]);
  assert.deepEqual(w.run(W.setupCommand(null, join(w.odd, "setup"))), ["setup", "--apply"]);
});

test("the picker's commands run as argv: a session by its home, a spawn by its deployment and soul, setup; the panel opens the picker", (t) => {
  const w = world(t);
  const home = join(w.odd, "instances", "with space 'and' $(quotes)");
  assert.deepEqual(w.runArgv(W.attachArgv(w.plugin, home)), ["shim", "session", "attach", "--detach-key", "M-o", "--home", home]);
  const deployment = join(w.odd, "other deployment");
  assert.deepEqual(w.runArgv(W.spawnArgv(w.plugin, deployment, "pkg/soul")), ["node", join(w.odd, "spawn.mjs"), "--dir", deployment, "pkg/soul"]);
  assert.deepEqual(w.runArgv(W.setupArgv(w.plugin, join(w.odd, "setup"))), ["node", join(w.odd, "setup.mjs"), "--dir", join(w.odd, "deployment"), "--apply"]);
  assert.deepEqual(w.runArgv(W.setupArgv(null, join(w.odd, "setup"))), ["setup", "--apply"]);
  assert.deepEqual(w.run(W.pickerCommand()), ["omarchy-shell", "shell", "summon", "ai.aweb.oats", "{}"]);
});

test("a waiting card: the kernel's message, then reason · producer · age, each as given; the exact since; nothing worded by the plugin", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const w = { since: "2026-10-19T11:57:00Z", producer: "oats.core", reason: "permission", message: "Allow Bash?" };
  assert.deepEqual(W.card("alpha", w, now), { title: "alpha", message: "Allow Bash?", meta: "permission \u00b7 oats.core \u00b7 3 min", since: "2026-10-19T11:57:00Z" });
  assert.deepEqual(W.card("alpha", { since: "2026-10-19T11:57:00Z", producer: "agent", reason: null, message: null }, now), { title: "alpha", message: "", meta: "agent \u00b7 3 min", since: "2026-10-19T11:57:00Z" }, "a field not given is left out");
  assert.deepEqual(W.card("alpha", { since: "not a time", producer: 7, reason: "attention" }, now), { title: "alpha", message: "", meta: "attention", since: "not a time" });
  assert.deepEqual(W.card("alpha", null, now), { title: "alpha", message: "", meta: "", since: "" });
  assert.deepEqual(W.claim({ since: "s", producer: "p", reason: "r", message: "m", extra: "x" }), { since: "s", producer: "p", reason: "r", message: "m" });
  assert.equal(W.claim("yes"), null);
  const at = (ms) => W.age(new Date(now - ms).toISOString(), now);
  assert.deepEqual([at(10_000), at(60_000), at(59 * 60_000), at(60 * 60_000), at(47 * 3600_000), at(48 * 3600_000), at(-60_000)], ["<1 min", "1 min", "59 min", "1 h", "47 h", "2 d", "<1 min"]);
  assert.equal(W.age("", now), "");
});

test("settleRead: only the pending read settles, once", () => {
  const state = W.newReadState();
  const first = W.beginRead(state);
  assert.equal(W.settleRead(state, first + 1), false);
  assert.equal(W.settleRead(state, first), true);
  assert.equal(W.settleRead(state, first), false);
  assert.equal(W.expireRead(state, first), null);
  const second = W.beginRead(state);
  assert.deepEqual(W.expireRead(state, second, 120000, "agents --json"), { known: false, reason: "agents --json did not answer within 120 s" });
  assert.equal(W.settleRead(state, second), false, "a read stopped at its deadline does not settle");
});

test("the icon's clicks and tooltip: before setup either click runs the whole setup; after, left toggles the panel and right opens the TUI", (t) => {
  const w = world(t);
  const setup = join(w.odd, "setup");
  for (const right of [false, true]) {
    const action = W.clickAction(null, setup, right);
    assert.deepEqual(Object.keys(action), ["line"]);
    assert.deepEqual(w.run(action.line), ["setup", "--apply"], right ? "right" : "left");
  }
  assert.equal(W.tooltip(null), "OATS: click to set up");
  assert.deepEqual(W.clickAction(w.plugin, setup, false), { toggle: true });
  assert.deepEqual(w.run(W.clickAction(w.plugin, setup, true).line), w.plugin.tui);
  assert.equal(W.tooltip(w.plugin), "OATS");
});

test("the icon's right click: the TUI, else setup", (t) => {
  const w = world(t);
  assert.deepEqual(w.run(W.quickCommand(w.plugin, join(w.odd, "setup"))), w.plugin.tui);
  assert.deepEqual(w.run(W.quickCommand({ ...w.plugin, tui: null }, join(w.odd, "setup")))[0], "node");
  assert.deepEqual(w.run(W.quickCommand(null, join(w.odd, "setup"))), ["setup", "--apply"]);
});
