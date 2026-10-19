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

test("manifest: a bar widget whose id and entry point Omarchy's validator accepts, with the refresh setting", () => {
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(m.schemaVersion, 1);
  for (const field of ["id", "name", "version", "kinds", "entryPoints"]) assert.ok(m[field], field);
  assert.match(m.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(!m.id.startsWith("omarchy.") && !m.id.includes(".."));
  assert.deepEqual(m.kinds, ["bar-widget"]);
  assert.ok(existsSync(join(root, m.entryPoints.barWidget)), m.entryPoints.barWidget);
  assert.deepEqual(m.barWidget.defaults, { refreshIntervalSec: 60 });
  assert.deepEqual(m.barWidget.schema, [{ key: "refreshIntervalSec", type: "integer", label: "Refresh interval (seconds)", min: 15, max: 3600, step: 15, defaultValue: 60 }]);
  const qml = readFileSync(join(root, m.entryPoints.barWidget), "utf8");
  assert.match(qml, /moduleName: "ai\.aweb\.oats"/);
  assert.match(qml, /import "widget\.mjs" as Widget/);
  // It runs commands only through the bar and its one reader, and writes nothing.
  assert.equal((qml.match(/\bProcess \{/g) || []).length, 1);
  assert.doesNotMatch(qml, /execDetached|atomicWrites|setText|\.write\(/);
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
  const good = { deployment: "/d", tui: ["t"], desktop: null, waiting: ["n", "w"], attach: ["s", "--home"], setup: ["n", "s"] };
  assert.deepEqual(W.parsePlugin(JSON.stringify(good)), good);
  for (const bad of ["", "not json", "{}", JSON.stringify({ ...good, waiting: [] }), JSON.stringify({ ...good, tui: "t" }), JSON.stringify({ ...good, attach: [1] })]) {
    assert.equal(W.parsePlugin(bad), null, bad);
  }
  assert.deepEqual(W.readArgv(good), ["n", "w", "--json"]);
});

test("the count: the number when some row waits on you, ? only when the read failed, else nothing", () => {
  const rows = [{ instance: "a", home: "/h/a" }, { instance: "b", home: "/h/b" }];
  const two = W.parseWaiting(JSON.stringify({ ok: true, count: 2, rows }));
  assert.deepEqual(two, { known: true, count: 2, rows });
  assert.equal(W.badge(two), "2");
  assert.equal(W.badge(W.parseWaiting(JSON.stringify({ ok: true, count: 0, rows: [] }))), "");
  const failed = W.parseWaiting(JSON.stringify({ ok: false, reason: "oats-lock.json is unreadable" }));
  assert.deepEqual(failed, { known: false, reason: "oats-lock.json is unreadable" });
  assert.equal(W.badge(failed), "?");
  assert.equal(W.badge(W.parseWaiting("")), "?", "no output: the read failed");
  assert.equal(W.badge(W.parseWaiting("{\"ok\":tr")), "?", "a read cut short");
  assert.equal(W.badge(null), "", "not read yet");
  assert.equal(W.READ_TIMEOUT_MS, 30000);
});

test("the read state: one read at a time; a refresh does not move the deadline; only the deadline settles a read that never started", () => {
  const state = W.newReadState();
  // At the shortest interval: a read at 0 s whose program never starts (no output ever).
  const first = W.beginRead(state);
  assert.equal(first, 1);
  assert.equal(W.beginRead(state), 0, "the refresh at 15 s starts nothing");
  assert.deepEqual(W.expireRead(state, first), { known: false, reason: W.READ_TIMEOUT_REASON }, "the deadline at 30 s settles it: ?");
  assert.equal(W.badge(W.expireRead(state, first) || { known: false }), "?");
  const second = W.beginRead(state);
  assert.equal(second, 2, "the next refresh reads again");
  assert.equal(W.finishRead(state, first, '{"ok":true,"count":1,"rows":[]}'), null, "output of a read stopped at its deadline is ignored");
  assert.deepEqual(W.finishRead(state, second, '{"ok":true,"count":0,"rows":[]}'), { known: true, count: 0, rows: [] });
  assert.equal(W.expireRead(state, second), null, "a finished read has no deadline left");
  assert.equal(W.finishRead(state, second, "{}"), null, "nor a second result");
});

test("the refresh interval and the one reader for every bar", () => {
  assert.deepEqual([W.refreshMs(undefined), W.refreshMs(60), W.refreshMs(5), W.refreshMs(99999), W.refreshMs("120")], [60000, 60000, 15000, 3600000, 120000]);
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
  for (const name of ["omarchy-launch-or-focus-tui", "omarchy-launch-or-focus"]) exe(join(bin, name), logger(name));
  // As Omarchy 4.0.4's launcher does: its arguments are one bash command line.
  exe(join(bin, "omarchy-launch-floating-terminal-with-presentation"), `#!/bin/bash\ncmd="$*"\nexec bash -c "$cmd"\n`);
  for (const name of ["shim", "node", "setup"]) exe(join(odd, name), logger(name));
  const plugin = {
    deployment: join(odd, "deployment"),
    tui: ["omarchy-launch-or-focus-tui", "--app-id=org.oats.tui", `'${join(odd, "shim")}'`, "tui"],
    desktop: ["omarchy-launch-or-focus", "awebai-oats-desktop", `uwsm-app -- '${join(odd, "app")}'`],
    waiting: [join(odd, "node"), join(odd, "waiting.mjs"), "--dir", join(odd, "deployment")],
    attach: [join(odd, "shim"), "session", "attach", "--detach-key", "M-o", "--home"],
    setup: [join(odd, "node"), join(odd, "setup.mjs"), "--dir", join(odd, "deployment")],
  };
  // The bar's run: `bash -lc <line>`; -c here, so no profile of this machine is read.
  const run = (line) => {
    rmSync(log, { force: true });
    const r = spawnSync("bash", ["-c", line], { cwd: dir, encoding: "utf8", timeout: 10000, env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(dir, "pwned")), "a path was not run as a command");
    return readFileSync(log, "utf8").split("\n").slice(0, -1);
  };
  return { dir, odd, plugin, run };
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

test("the icon's right click: the TUI, else setup", (t) => {
  const w = world(t);
  assert.deepEqual(w.run(W.quickCommand(w.plugin, join(w.odd, "setup"))), w.plugin.tui);
  assert.deepEqual(w.run(W.quickCommand({ ...w.plugin, tui: null }, join(w.odd, "setup")))[0], "node");
  assert.deepEqual(w.run(W.quickCommand(null, join(w.odd, "setup"))), ["setup", "--apply"]);
});
