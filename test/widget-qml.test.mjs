// The bar widget and the OATS picker themselves, in Quickshell:
// OatsBarWidget.qml and OatsPicker.qml loaded with Omarchy's own Ui and
// Commons modules, offscreen, with a temporary HOME and XDG directories and
// a stand-in for the bar and the shell. Their layer-shell windows need a
// Wayland compositor, so only those two types, the panel's KeyboardPanel and
// the picker's PickerWindow, are stand-ins: Items with their properties. Each case
// is a small QML scene that logs "PROBE <json>" lines. Runs in CI's Omarchy
// container (OATS_OMARCHY_CONTAINER=1), where Quickshell and the shell are
// installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "./helpers/sandbox.mjs";

const SHELL = "/usr/share/omarchy/shell";
const skip = process.env.OATS_OMARCHY_CONTAINER === "1" ? false : "set OATS_OMARCHY_CONTAINER=1 (CI's Omarchy container)";

const panelStandIn = (screen) => `import QtQuick
Item {
  id: root
  property Item anchorItem: null
  property QtObject bar: null
  property var owner: null
  property bool open: false
  property Item focusTarget: null
  property int contentWidth: 300
  property int contentHeight: 200
  property real availableCardHeight: ${screen}
  property real verticalContentInset: 20
  default property alias content: card.data
  function fittedContentWidth(w, cap) { return Math.round(Number(w)) }
  function fittedContentHeight(h, cap) { var d = Number(h) + verticalContentInset; var m = availableCardHeight; if (cap !== undefined) m = Math.min(m, Number(cap)); return Math.round(Math.min(d, m)) }
  width: contentWidth
  height: contentHeight
  Item { id: card; objectName: "card"; width: root.contentWidth; height: root.contentHeight - root.verticalContentInset }
}
`;

// The picker's window, offscreen: the card's holder, at a screen's size.
const pickerWindowStandIn = `import QtQuick
Item {
  id: panel
  property color scrim: "transparent"
  signal dismissed()
  default property alias content: holder.data
  width: 1000
  height: 800
  Item { id: holder; objectName: "pickerWindow"; anchors.fill: parent }
}
`;

// A scene: the widget (as `w`) in a window, a bar that logs what it runs,
// `body` (more QML), and a quit after `seconds`.
const scene = (body, seconds, { settings = "({})" } = {}) => ({ seconds, qml: `import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Io
import "plugin" as P

ShellRoot {
  id: scene
  function probe(what, value) { console.log("PROBE " + JSON.stringify({ what: what, value: value })) }
  QtObject {
    id: fakeBar
    property color foreground: "white"
    property color barForeground: "white"
    property string fontFamily: "sans"
    function run(line) { scene.probe("run", line) }
    function moduleWidgets(id) { return [] }
  }
  function all(item, out) { out.push(item); for (var i = 0; i < item.children.length; i++) all(item.children[i], out); return out }
  Window { visible: true; width: 400; height: 900
    Loader { id: loader; active: true; sourceComponent: Component { P.OatsBarWidget { bar: fakeBar; settings: ${settings} } } }
  }
  readonly property var w: loader.item
${body}
  Timer { interval: ${seconds * 1000}; running: true; onTriggered: Qt.quit() }
}
` });

function world(t, { screen = 400 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oats-widget-qml-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cfg = join(root, "cfg");
  const ui = join(cfg, "Ui");
  mkdirSync(ui, { recursive: true });
  for (const name of readdirSync(join(SHELL, "Ui"))) if (name !== "KeyboardPanel.qml") symlinkSync(join(SHELL, "Ui", name), join(ui, name));
  writeFileSync(join(ui, "KeyboardPanel.qml"), panelStandIn(screen));
  symlinkSync(join(SHELL, "Commons"), join(cfg, "Commons"));
  mkdirSync(join(cfg, "plugin"));
  for (const name of ["OatsBarWidget.qml", "OatsPicker.qml", "widget.mjs", "picker.mjs", "assets"]) cpSync(join(repo, name), join(cfg, "plugin", name), { recursive: true });
  writeFileSync(join(cfg, "plugin", "PickerWindow.qml"), pickerWindowStandIn);
  const home = join(root, "home");
  const state = join(home, ".local", "state", "oats-omarchy");
  const run = join(root, "run");
  mkdirSync(state, { recursive: true });
  mkdirSync(run, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: run, QT_QPA_PLATFORM: "offscreen",
    XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
  };
  const plugin = (p) => writeFileSync(join(state, "plugin.json"), JSON.stringify({ deployment: "/d", tui: null, desktop: null, attach: ["s", "--home"], setup: ["n", "s"], ...p }));
  const exe = (name, text) => { const path = join(root, name); writeFileSync(path, text); chmodSync(path, 0o755); return path; };
  // Runs a scene → its PROBE records, in order.
  const play = ({ qml, seconds }) => {
    writeFileSync(join(cfg, "shell.qml"), qml);
    const r = spawnSync("quickshell", ["--no-color", "-p", join(cfg, "shell.qml")], { env, cwd: root, encoding: "utf8", timeout: (seconds + 30) * 1000 });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(out, /ERROR/, out);
    return out.split("\n").filter((l) => l.includes("PROBE ")).map((l) => JSON.parse(l.slice(l.indexOf("PROBE ") + 6)));
  };
  return { root, home, state, plugin, exe, play };
}

// A short screen limits the card; on a tall one the 480 px cap does.
for (const screen of [400, 900]) test(`a list taller than the panel scrolls; the launchers stay in view; no wording but labels, names and the hint (a ${screen} px screen)`, { skip }, (t) => {
  const w = world(t, { screen });
  const rows = Array.from({ length: 50 }, (_, i) => ({ instance: `agent-${i}`, home: `/h/${i}` }));
  const read = w.exe("rows.sh", `#!/bin/sh\ncat <<'E'\n${JSON.stringify({ ok: true, count: 50, rows })}\nE\n`);
  w.plugin({ tui: ["t"], desktop: ["d"], waiting: ["/bin/sh", read], attach: ["s", "--detach-key", "M-o", "--home"] });
  const [report] = w.play(scene(`
  Timer { interval: 500; running: true; onTriggered: scene.w.open() }
  Timer { interval: 3000; running: true; onTriggered: {
    var items = scene.all(scene.w, [])
    var card = items.filter(function(x) { return x.objectName === "card" })[0]
    var texts = {}
    var flick = null
    for (var i = 0; i < items.length; i++) {
      var x = items[i]
      if (x.flickableDirection !== undefined && x.contentHeight !== undefined && x.visible) flick = { height: x.height, contentHeight: x.contentHeight, interactive: x.interactive }
      if (typeof x.text === "string" && x.text !== "" && x.visible && texts[x.text] === undefined) {
        var p = x.mapToItem(card, 0, 0)
        texts[x.text] = p.y >= 0 && p.y + x.height <= card.height
      }
    }
    scene.probe("layout", { reading: scene.w.reading, card: card.height, flick: flick, texts: texts })
  } }`, 4));
  const { reading, card, flick, texts } = report.value;
  assert.equal(reading, false, "the read answered");
  assert.ok(flick && flick.interactive && flick.height < flick.contentHeight && flick.height > 0, JSON.stringify(flick));
  for (const label of ["Alt+O leaves the viewer", "Open OATS", "Open OATS TUI", "Open OATS Desktop", "Set up keys and launchers", "agent-0"]) {
    assert.equal(texts[label], true, `${label} is inside the ${card}px card`);
  }
  assert.equal(texts["agent-49"], false, "the last rows are scrolled out of view, not pushed out of the card");
  // Beyond the instance names: the button labels and the hint.
  const allowed = ["OATS", "Alt+O leaves the viewer", "Open OATS", "Open OATS TUI", "Open OATS Desktop", "Set up keys and launchers"];
  for (const word of Object.keys(texts).filter((x) => !/^agent-\d+$/.test(x))) assert.ok(allowed.includes(word), word);
});

test("plugin.json is read as soon as it changes, and a removed one leaves setup only", { skip }, (t) => {
  const w = world(t);
  const read = w.exe("none.sh", `#!/bin/sh\necho '{"ok":true,"count":0,"rows":[]}'\n`);
  w.plugin({ deployment: "/old", waiting: ["/bin/sh", read] });
  const records = w.play(scene(`
  Process { id: change; command: ["/bin/sh", "-c", "cd \\"$XDG_STATE_HOME/oats-omarchy\\" && sed s,/old,/new, plugin.json > next && mv next plugin.json"] }
  Process { id: remove; command: ["/bin/sh", "-c", "rm \\"$XDG_STATE_HOME/oats-omarchy/plugin.json\\""] }
  Timer { interval: 1500; running: true; onTriggered: scene.probe("first", scene.w.plugin && scene.w.plugin.deployment) }
  Timer { interval: 2000; running: true; onTriggered: change.running = true }
  Timer { interval: 3500; running: true; onTriggered: scene.probe("changed", scene.w.plugin && scene.w.plugin.deployment) }
  Timer { interval: 4000; running: true; onTriggered: remove.running = true }
  Timer { interval: 5500; running: true; onTriggered: { scene.w.refresh() } }
  Timer { interval: 6500; running: true; onTriggered: scene.probe("removed", scene.w.plugin) }`, 7));
  assert.deepEqual(records.filter((r) => r.what !== "run").map((r) => [r.what, r.value]), [["first", "/old"], ["changed", "/new"], ["removed", null]]);
});

test("destroying the widget during a read stops waiting and the kernel's read with it", { skip }, (t) => {
  const w = world(t);
  const deployment = join(w.root, "deployment");
  mkdirSync(deployment);
  writeFileSync(join(deployment, "oats-local.yaml"), "# test\n");
  const shim = join(w.home, ".local", "share", "oats-omarchy", "oats");
  mkdirSync(join(shim, ".."), { recursive: true });
  writeFileSync(shim, "#!/bin/sh\nsleep 300 &\nexec sleep 301\n");
  chmodSync(shim, 0o755);
  w.plugin({ deployment, waiting: [process.execPath, join(repo, "bin", "waiting.mjs"), "--dir", deployment] });
  // waiting, the shim's sleep and its child (awk's own command line does not match).
  const ps = "ps -eo args | awk '/^sleep 30[01]$/ || /bin[/]waiting[.]mjs --dir/ { n++ } END { print n + 0 }'";
  const records = w.play(scene(`
  Process { id: ps; command: ["/bin/sh", "-c", ${JSON.stringify(ps)}]; stdout: StdioCollector { waitForEnd: true; onStreamFinished: scene.probe("ps", Number(text.trim())) } }
  Timer { interval: 1000; running: true; onTriggered: scene.w.open() }
  Timer { interval: 2500; running: true; onTriggered: ps.running = true }
  Timer { interval: 3500; running: true; onTriggered: loader.active = false }
  Timer { interval: 5000; running: true; onTriggered: ps.running = true }`, 6));
  assert.deepEqual(records.map((r) => r.value), [3, 0], "waiting, the shim's sleep and its child; then none");
});

// What the panel shows: whether it is reading, the rows, and the failure.
const panelState = `function state() { return { reading: scene.w.reading, rows: scene.w.rows.map(function(x) { return x.instance }), failed: scene.w.failed ? scene.w.waiting.reason : null } }`;

test("a read whose program cannot start reads until the deadline, then says why in the panel", { skip }, (t) => {
  const w = world(t);
  w.plugin({ waiting: [join(w.root, "gone", "node"), "waiting.mjs"] });
  const records = w.play(scene(`
  ${panelState}
  Timer { interval: 500; running: true; onTriggered: scene.w.open() }
  Timer { interval: 20000; running: true; onTriggered: scene.probe("at 20 s", scene.state()) }
  Timer { interval: 33000; running: true; onTriggered: scene.probe("at 33 s", scene.state()) }`, 34));
  assert.deepEqual(records.map((r) => [r.what, r.value]), [
    ["at 20 s", { reading: true, rows: [], failed: null }],
    ["at 33 s", { reading: false, rows: [], failed: "waiting --json did not answer within 30 s" }],
  ]);
});

test("nothing is read until the panel opens; each opening reads fresh and says so while it reads", { skip }, (t) => {
  const w = world(t);
  const log = join(w.root, "reads.log");
  const read = w.exe("slow.sh", `#!/bin/sh\necho read >> '${log}'\nsleep 2\necho '{"ok":true,"count":1,"rows":[{"instance":"alpha","home":"/h/a"}]}'\n`);
  w.plugin({ waiting: ["/bin/sh", read] });
  const count = `n=$(cat '${log}' 2>/dev/null | wc -l); echo $n`;
  const records = w.play(scene(`
  ${panelState}
  Process { id: reads; command: ["/bin/sh", "-c", ${JSON.stringify(count)}]; stdout: StdioCollector { waitForEnd: true; onStreamFinished: scene.probe("reads", Number(text.trim())) } }
  Timer { interval: 4000; running: true; onTriggered: reads.running = true }
  Timer { interval: 4500; running: true; onTriggered: scene.w.open() }
  Timer { interval: 5500; running: true; onTriggered: scene.probe("reading", scene.state()) }
  Timer { interval: 8000; running: true; onTriggered: { scene.probe("read", scene.state()); scene.w.close() } }
  Timer { interval: 8500; running: true; onTriggered: scene.w.open() }
  Timer { interval: 9000; running: true; onTriggered: scene.probe("again", scene.state()) }
  Timer { interval: 12000; running: true; onTriggered: reads.running = true }`, 13));
  assert.deepEqual(records.map((r) => [r.what, r.value]), [
    ["reads", 0],
    ["reading", { reading: true, rows: [], failed: null }],
    ["read", { reading: false, rows: ["alpha"], failed: null }],
    ["again", { reading: true, rows: [], failed: null }],
    ["reads", 2],
  ]);
});

// Presses the bar icon (the real BarIconButton's pressed signal) and logs
// what the bar ran, whether the panel is open, and the tooltip.
const clicks = scene(`
  function icon() { return scene.all(scene.w, []).filter(function(x) { return x.tooltipText !== undefined && x.iconComponent !== undefined })[0] }
  Timer { interval: 1500; running: true; onTriggered: {
    var b = scene.icon()
    scene.probe("tooltip", b.tooltipText)
    b.pressed(Qt.LeftButton)
    scene.probe("left", { opened: scene.w.opened })
    if (scene.w.opened) scene.w.close()
    b.pressed(Qt.RightButton)
    scene.probe("right", { opened: scene.w.opened })
  } }`, 3);

test("before setup, a left or right click on the icon runs the whole setup; the tooltip says so", { skip }, (t) => {
  const w = world(t);
  const records = w.play(clicks).map((r) => [r.what, r.value]);
  const setup = `exec omarchy-launch-floating-terminal-with-presentation ''\\''${join(w.root, "cfg", "plugin", "setup")}'\\'' --apply'`;
  assert.deepEqual(records, [
    ["tooltip", "OATS: click to set up"],
    ["run", setup], ["left", { opened: false }],
    ["run", setup], ["right", { opened: false }],
  ]);
});

test("after setup, a left click toggles the panel and a right click opens the TUI; the tooltip is OATS", { skip }, (t) => {
  const w = world(t);
  const read = w.exe("none.sh", `#!/bin/sh\necho '{"ok":true,"count":0,"rows":[]}'\n`);
  w.plugin({ tui: ["omarchy-launch-or-focus-tui", "tui"], waiting: ["/bin/sh", read] });
  const records = w.play(clicks).map((r) => [r.what, r.value]);
  assert.deepEqual(records, [
    ["tooltip", "OATS"],
    ["left", { opened: true }],
    ["run", "exec 'omarchy-launch-or-focus-tui' 'tui'"], ["right", { opened: false }],
  ]);
});

test("with the list, the panel groups the rows by workspace and shows a deployment that could not be read", { skip }, (t) => {
  const w = world(t);
  const result = {
    ok: true, count: 2,
    rows: [{ instance: "alpha", home: "/h/a", deployment: "/d/one", workspace: "github.com/acme/one" }, { instance: "beta", home: "/h/b", deployment: "/d/two", workspace: "github.com/acme/two" }],
    deployments: [
      { path: "/d/one", name: "one", workspace: "github.com/acme/one", ok: true, at: 1 },
      { path: "/d/two", name: "two", workspace: "github.com/acme/two", ok: true, at: 1 },
      { path: "/d/three", name: "three", workspace: null, ok: false, reason: "oats-lock.json is unreadable", at: 1 },
    ],
  };
  const read = w.exe("list.sh", `#!/bin/sh\ncat <<'E'\n${JSON.stringify(result)}\nE\n`);
  w.plugin({ deployment: null, waiting: ["/bin/sh", read, "--list"] });
  const [report] = w.play(scene(`
  Timer { interval: 500; running: true; onTriggered: scene.w.open() }
  Timer { interval: 3000; running: true; onTriggered: {
    var texts = []
    var items = scene.all(scene.w, [])
    for (var i = 0; i < items.length; i++) if (typeof items[i].text === "string" && items[i].text !== "" && items[i].visible) texts.push(items[i].text)
    scene.probe("texts", texts)
  } }`, 4));
  const texts = report.value;
  for (const text of ["github.com/acme/one", "alpha", "github.com/acme/two", "beta", "three", "three: oats-lock.json is unreadable"]) assert.ok(texts.includes(text), `${text} in ${JSON.stringify(texts)}`);
  assert.ok(texts.indexOf("github.com/acme/one") < texts.indexOf("alpha") && texts.indexOf("alpha") < texts.indexOf("github.com/acme/two"), "each title above its rows");
  assert.ok(!texts.some((x) => /^Reading/.test(x)), "the read answered");
});

// A scene with the picker (as `w`) in a window, a shell that logs what it
// is asked to hide, and an argv runner that logs what it would run; `key()`
// presses a key as the picker's keyboard handler receives it.
const pickerScene = (body, seconds) => ({ seconds, qml: `import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Io
import "plugin" as P

ShellRoot {
  id: scene
  function probe(what, value) { console.log("PROBE " + JSON.stringify({ what: what, value: value })) }
  function all(item, out) { out.push(item); for (var i = 0; i < item.children.length; i++) all(item.children[i], out); return out }
  QtObject { id: fakeShell; function hide(id) { scene.probe("hide", id) } }
  Window { visible: true; width: 1000; height: 800
    Loader { id: loader; active: true; sourceComponent: Component { P.OatsPicker { shell: fakeShell; manifest: ({ id: "ai.aweb.oats" }); execArgv: function(argv) { scene.probe("exec", argv) } } } }
  }
  readonly property var w: loader.item
  function key(k, mods, text) { var e = { key: k, modifiers: mods || 0, text: text || "", accepted: false }; scene.w.keyPressed(e); return e.accepted }
  function type(text) { for (var i = 0; i < text.length; i++) scene.key(0, 0, text[i]) }
  function texts() {
    var out = []
    var items = scene.all(scene.w, [])
    for (var i = 0; i < items.length; i++) if (typeof items[i].text === "string" && items[i].text !== "" && items[i].visible) out.push(items[i].text)
    return out
  }
  function state() { return { opened: scene.w.opened, reading: scene.w.reading, section: scene.w.section, filter: scene.w.filterText, index: scene.w.selectedIndex, texts: scene.texts() } }
  // Steps a frame or more apart, so the list has laid out what a key changed.
  property var steps: []
  property int step: 0
  function run(list) { scene.steps = list; scene.step = 0; stepper.start() }
  Timer { id: stepper; interval: 250; repeat: true; onTriggered: { if (scene.step < scene.steps.length) scene.steps[scene.step++](); else stop() } }
${body}
  Timer { interval: ${seconds * 1000}; running: true; onTriggered: Qt.quit() }
}
` });

const PICKED = {
  ok: true, features: { waitingOnYou: true, soulCounts: true },
  deployments: [
    { path: "/d/one", name: "one", workspace: "github.com/acme/one", ok: true,
      agents: [
        { agent: "writer", instance: "alpha", home: "/h/alpha", running: true, waitingOnYou: { since: "2026-10-19T10:00:00Z", producer: "oats.core", reason: "permission", message: "Allow Bash?" } },
        { agent: "writer", instance: "beta", home: "/h/beta", running: false, waitingOnYou: null },
      ],
      souls: [{ key: "pkg/writer", name: "writer", description: "Writes.", spawnable: true, problem: null, instances: 2 }] },
    { path: "/d/two", name: "two", workspace: null, ok: false, reason: "oats-lock.json is unreadable" },
  ],
};

// A reader that logs each read and answers `result` after `delay` seconds.
function reader(w, result, delay = 0) {
  const log = join(w.root, "reads.log");
  const read = w.exe("agents.sh", `#!/bin/sh\necho "$*" >> '${log}'\nsleep ${delay}\ncat <<'E'\n${JSON.stringify(result)}\nE\n`);
  const count = `n=$(cat '${log}' 2>/dev/null | wc -l); echo $n`;
  return { read, count, log };
}

test("the picker reads only when it opens and says so; it opens on Waiting; it filters, moves and switches; Enter opens the session as argv", { skip }, (t) => {
  const w = world(t);
  const r = reader(w, PICKED, 1);
  w.plugin({ attach: ["s", "--detach-key", "M-o", "--home"], waiting: ["n", "w"], agents: ["/bin/sh", r.read], spawn: ["n", "spawn.mjs"] });
  const records = w.play(pickerScene(`
  Process { id: reads; command: ["/bin/sh", "-c", ${JSON.stringify(r.count)}]; stdout: StdioCollector { waitForEnd: true; onStreamFinished: scene.probe("reads", Number(text.trim())) } }
  Timer { interval: 1000; running: true; onTriggered: reads.running = true }
  Timer { interval: 1500; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 1800; running: true; onTriggered: scene.probe("reading", scene.state()) }
  Timer { interval: 4500; running: true; onTriggered: scene.run([
    function() { scene.probe("waiting", scene.state()); scene.key(Qt.Key_Tab) },
    function() { scene.probe("agents", scene.state()); scene.type("BET") },
    function() { scene.probe("filtered", scene.state()); scene.key(Qt.Key_Backspace); scene.probe("backspace", scene.w.filterText); scene.key(Qt.Key_Escape) },
    function() { scene.probe("cleared", { opened: scene.w.opened, filter: scene.w.filterText }); scene.key(Qt.Key_Tab) },
    function() {
      scene.probe("souls", scene.state())
      scene.key(Qt.Key_Backtab)
      scene.key(Qt.Key_Down)
      var down = scene.w.selectedIndex
      scene.key(Qt.Key_K, Qt.ControlModifier)
      var up = scene.w.selectedIndex
      scene.key(Qt.Key_J, Qt.ControlModifier)
      scene.probe("moved", [scene.w.section, down, up, scene.w.selectedIndex])
      scene.key(Qt.Key_Return)
      scene.probe("after", { opened: scene.w.opened })
    },
    function() { reads.running = true },
  ]) }`, 8));
  const by = (what) => records.filter((x) => x.what === what).map((x) => x.value);
  assert.deepEqual(by("reads"), [0, 1], "nothing before it opened; one read for one opening");
  const [reading] = by("reading");
  assert.equal(reading.reading, true);
  assert.ok(reading.texts.includes("Reading your agents…"), JSON.stringify(reading.texts));
  const [waiting] = by("waiting");
  assert.deepEqual([waiting.reading, waiting.section], [false, "waiting"]);
  for (const text of ["Waiting on you (1)", "Agents", "Souls", "alpha", "Allow Bash?", "two: oats-lock.json is unreadable", "Alt+O leaves the viewer", "Search OATS…"]) assert.ok(waiting.texts.includes(text), `${text} in ${JSON.stringify(waiting.texts)}`);
  assert.ok(waiting.texts.some((x) => /^writer · permission · oats\.core · \d+ (min|h|d)$/.test(x)), JSON.stringify(waiting.texts));
  assert.ok(!waiting.texts.includes("beta"), "only the agent waiting on you");
  const [agents] = by("agents");
  assert.equal(agents.section, "agents");
  for (const text of ["github.com/acme/one", "alpha", "beta", "\u{F009A}", "●", "○"]) assert.ok(agents.texts.includes(text), `${text} in ${JSON.stringify(agents.texts)}`);
  const [filtered] = by("filtered");
  assert.equal(filtered.filter, "BET");
  assert.ok(filtered.texts.includes("beta") && !filtered.texts.includes("alpha"), JSON.stringify(filtered.texts));
  assert.deepEqual(by("backspace"), ["BE"]);
  assert.deepEqual(by("cleared"), [{ opened: true, filter: "" }], "Esc clears the filter first");
  const [souls] = by("souls");
  assert.equal(souls.section, "souls");
  for (const text of ["pkg/writer", "Writes. · 2 instances"]) assert.ok(souls.texts.includes(text), `${text} in ${JSON.stringify(souls.texts)}`);
  assert.ok(!souls.texts.includes("Alt+O leaves the viewer"));
  assert.deepEqual(by("moved"), [["agents", 1, 0, 1]]);
  assert.deepEqual(by("exec"), [["omarchy-launch-floating-terminal-with-presentation", "'s' '--detach-key' 'M-o' '--home' '/h/beta'"]]);
  assert.deepEqual(by("hide"), ["ai.aweb.oats"]);
  assert.deepEqual(by("after"), [{ opened: false }]);
  assert.deepEqual(readFileSync(r.log, "utf8"), "--json\n", "the read is the plugin's agents command with --json");
});

test("the payload opens a section; Enter on a soul starts an agent from it in the deployment that listed it; Esc closes", { skip }, (t) => {
  const w = world(t);
  const r = reader(w, PICKED);
  w.plugin({ waiting: ["n", "w"], agents: ["/bin/sh", r.read], spawn: ["n", "spawn.mjs"] });
  const records = w.play(pickerScene(`
  Timer { interval: 1000; running: true; onTriggered: scene.w.open('{"section":"souls"}') }
  Timer { interval: 3000; running: true; onTriggered: { scene.probe("souls", scene.state().section); scene.key(Qt.Key_Return) } }
  Timer { interval: 3500; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 5500; running: true; onTriggered: { scene.probe("default", scene.state().section); scene.key(Qt.Key_Escape); scene.probe("closed", scene.w.opened) } }`, 6));
  const by = (what) => records.filter((x) => x.what === what).map((x) => x.value);
  assert.deepEqual(by("souls"), ["souls"], "asked for, so kept although someone waits");
  assert.deepEqual(by("exec"), [["n", "spawn.mjs", "--dir", "/d/one", "pkg/writer"]]);
  assert.deepEqual(by("default"), ["waiting"]);
  assert.deepEqual(by("closed"), [false]);
  assert.deepEqual(by("hide"), ["ai.aweb.oats", "ai.aweb.oats"]);
});

test("before setup, and with a plugin.json from before the picker, the picker offers setup only, and reads nothing", { skip }, (t) => {
  const w = world(t);
  const r = reader(w, PICKED);
  const old = JSON.stringify({ deployment: "/d", tui: null, desktop: null, attach: ["s", "--home"], setup: ["n", "s"], waiting: ["n", "w"] });
  const records = w.play(pickerScene(`
  Process { id: write; command: ["/bin/sh", "-c", ${JSON.stringify(`cat > "$XDG_STATE_HOME/oats-omarchy/plugin.json" <<'E'\n${old}\nE\n`)}] }
  Timer { interval: 1000; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 2000; running: true; onTriggered: { scene.probe("none", scene.state()); scene.key(Qt.Key_Return) } }
  Timer { interval: 2500; running: true; onTriggered: write.running = true }
  Timer { interval: 3500; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 4500; running: true; onTriggered: { scene.probe("old", scene.state()); scene.key(Qt.Key_Return) } }`, 5));
  const by = (what) => records.filter((x) => x.what === what).map((x) => x.value);
  const [none] = by("none");
  assert.ok(none.texts.includes("OATS is not set up here yet: Enter runs setup."), JSON.stringify(none.texts));
  const [old030] = by("old");
  assert.ok(old030.texts.includes("Setup was applied by an older version of this plugin: Enter runs it again."), JSON.stringify(old030.texts));
  for (const state of [none, old030]) assert.ok(!state.texts.some((x) => /^No agent|^No souls|^Reading/.test(x)), JSON.stringify(state.texts));
  assert.deepEqual(by("exec"), [
    ["omarchy-launch-floating-terminal-with-presentation", `'${join(w.root, "cfg", "plugin", "setup")}' --apply`],
    ["omarchy-launch-floating-terminal-with-presentation", "'n' 's' '--apply'"],
  ]);
  assert.equal(existsSync(r.log), false, "nothing was read");
});

test("a read that fails says why; an answer with nobody waiting never says nobody is", { skip }, (t) => {
  const w = world(t);
  const failing = w.exe("fail.sh", `#!/bin/sh\necho '{"ok":false,"reason":"no deployment could be read: a: oats-lock.json is unreadable"}'\nexit 1\n`);
  const quiet = { ...PICKED, deployments: [{ ...PICKED.deployments[0], agents: [PICKED.deployments[0].agents[1]] }] };
  const fine = w.exe("quiet.sh", `#!/bin/sh\ncat <<'E'\n${JSON.stringify(quiet)}\nE\n`);
  w.plugin({ waiting: ["n", "w"], agents: ["/bin/sh", failing], spawn: ["n", "spawn.mjs"] });
  const next = JSON.stringify({ deployment: "/d", tui: null, desktop: null, attach: ["s", "--home"], setup: ["n", "s"], waiting: ["n", "w"], agents: ["/bin/sh", fine], spawn: ["n", "spawn.mjs"] });
  const records = w.play(pickerScene(`
  Process { id: write; command: ["/bin/sh", "-c", ${JSON.stringify(`cat > "$XDG_STATE_HOME/oats-omarchy/plugin.json" <<'E'\n${next}\nE\n`)}] }
  Timer { interval: 1000; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 2500; running: true; onTriggered: { scene.probe("failed", scene.state()); scene.w.close(); write.running = true } }
  Timer { interval: 3500; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 5000; running: true; onTriggered: scene.run([
    function() { scene.probe("agents", scene.state()); scene.key(Qt.Key_Backtab) },
    function() { scene.probe("waiting", scene.state()) },
  ]) }`, 7));
  const by = (what) => records.filter((x) => x.what === what).map((x) => x.value);
  const [failed] = by("failed");
  assert.ok(failed.texts.includes("no deployment could be read: a: oats-lock.json is unreadable"), JSON.stringify(failed.texts));
  assert.ok(!failed.texts.some((x) => /^No agent/.test(x)), "a failed read claims nothing");
  const [agents] = by("agents");
  assert.equal(agents.section, "agents", "nobody said they wait: Agents");
  const [waiting] = by("waiting");
  assert.equal(waiting.section, "waiting");
  assert.ok(waiting.texts.includes("No agent has said it is waiting on you"), JSON.stringify(waiting.texts));
  for (const state of [failed, agents, waiting]) assert.ok(!state.texts.some((x) => /nobody|no one/i.test(x)));
});
