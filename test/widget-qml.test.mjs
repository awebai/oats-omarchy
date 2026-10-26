// The bar widget and the waiting popup themselves, in Quickshell:
// OatsBarWidget.qml and OatsWaiting.qml, with the WaitingCard.qml both draw,
// loaded with Omarchy's own Ui and Commons modules, offscreen, with a
// temporary HOME and XDG directories and a stand-in for the bar and the
// shell. Their layer-shell windows need a Wayland compositor, so only those
// two types, the panel's KeyboardPanel and the popup's WaitingWindow, are
// stand-ins: Items with their properties, a card on a short screen. Nothing
// they run is started: the bar's run and the popup's argv runner log. Each case
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
import * as W from "../widget.mjs";

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

// The popup's window, offscreen: the card's holder, at a screen's size.
const waitingWindowStandIn = `import QtQuick
Item {
  id: panel
  property color scrim: "transparent"
  signal dismissed()
  default property alias content: holder.data
  width: 1000
  height: 800
  Item { id: holder; objectName: "waitingWindow"; anchors.fill: parent }
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
  for (const name of ["OatsBarWidget.qml", "OatsWaiting.qml", "WaitingCard.qml", "widget.mjs", "assets"]) cpSync(join(repo, name), join(cfg, "plugin", name), { recursive: true });
  writeFileSync(join(cfg, "plugin", "WaitingWindow.qml"), waitingWindowStandIn);
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
  w.plugin({ tui: ["t"], desktop: ["d"], waiting: ["/bin/sh", read], attach: ["s", "--detach-key", "C-\\", "--home"] });
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
  for (const label of ["Ctrl+\\ leaves the viewer", "Open OATS TUI", "Open OATS Desktop", "Set up keys and launchers", "agent-0"]) {
    assert.equal(texts[label], true, `${label} is inside the ${card}px card`);
  }
  assert.equal(texts["agent-49"], false, "the last rows are scrolled out of view, not pushed out of the card");
  // Beyond the instance names: the button labels and the hint.
  const allowed = ["OATS", "Ctrl+\\ leaves the viewer", "Open OATS TUI", "Open OATS Desktop", "Set up keys and launchers"];
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
  // Counted every 200 ms, waiting on each condition rather than a fixed time,
  // which a loaded host can overrun: the widget is destroyed once all three
  // run, and the count after that is taken once none does. Both waits share
  // one deadline, 20 s from the opening, before any read ends by itself
  // (waiting --json's own bound is 25 s, the widget's 30 s, each from the
  // read's start, which is after the opening): a count that comes after it
  // is "late", so only the destruction can have ended the read.
  const records = w.play(scene(`
  QtObject { id: watch; property int phase: 0; property real deadline: 0 }
  function counted(n) {
    if (watch.phase !== 1 && watch.phase !== 2) return
    if (Date.now() > watch.deadline) { scene.probe("late", { phase: watch.phase, count: n }); watch.phase = 3; Qt.quit() }
    else if (watch.phase === 1 && n === 3) { scene.probe("reading", n); watch.phase = 2; loader.active = false }
    else if (watch.phase === 2 && n === 0) { scene.probe("destroyed", n); watch.phase = 3; Qt.quit() }
  }
  Process { id: ps; command: ["/bin/sh", "-c", ${JSON.stringify(ps)}]; stdout: StdioCollector { waitForEnd: true; onStreamFinished: scene.counted(Number(text.trim())) } }
  Timer { interval: 1000; running: true; onTriggered: { watch.deadline = Date.now() + 20000; scene.w.open(); watch.phase = 1 } }
  Timer { interval: 200; repeat: true; running: true; onTriggered: if ((watch.phase === 1 || watch.phase === 2) && !ps.running) ps.running = true }`, 30));
  assert.deepEqual(records.map((r) => [r.what, r.value]), [["reading", 3], ["destroyed", 0]], "waiting, the shim's sleep and its child; then none");
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

// Before setup, the set-up line asks the plugin's installer --check, then
// runs setup or the installer (widget.test.mjs runs it), quoted as the
// widget quotes it.
const setupLine = (w) => {
  const plugin = join(w.root, "cfg", "plugin");
  const install = W.shellQuote(join(plugin, "bin", "omarchy-install-oats"));
  return `if ${install} --check >/dev/null 2>&1; then ${W.shellQuote(join(plugin, "setup"))} --apply; else ${install} --now; fi`;
};

// The set-up line holds the installer's --check (widget.test.mjs runs it):
// the bar runs it once per click, and nothing at all before a click.
test("before setup, a left or right click on the icon runs the whole setup, checking first whether OATS is installed; the tooltip says so", { skip }, (t) => {
  const w = world(t);
  const records = w.play(clicks).map((r) => [r.what, r.value]);
  const setup = W.setupCommand(null, join(w.root, "cfg", "plugin", "setup"));
  assert.equal(setup, `exec omarchy-launch-floating-terminal-with-presentation ${W.shellQuote(setupLine(w))}`);
  assert.deepEqual(records, [
    ["tooltip", "OATS: click to set up"],
    ["run", setup], ["left", { opened: false }],
    ["run", setup], ["right", { opened: false }],
  ]);
});

// The bar's run is the scene's logger: nothing is started.
for (const [ui, line] of [["tui", "exec 'omarchy-launch-or-focus-tui' 'tui'"], ["desktop", "exec 'omarchy-launch-or-focus' 'awebai-oats-desktop' 'uwsm-app -- d'"]]) {
  test(`after setup, a left click toggles the panel and a right click opens the default UI, ${ui === "tui" ? "the TUI" : "the Desktop"}; the tooltip is OATS`, { skip }, (t) => {
    const w = world(t);
    const read = w.exe("none.sh", `#!/bin/sh\necho '{"ok":true,"count":0,"rows":[]}'\n`);
    w.plugin({ tui: ["omarchy-launch-or-focus-tui", "tui"], desktop: ["omarchy-launch-or-focus", "awebai-oats-desktop", "uwsm-app -- d"], ui, waiting: ["/bin/sh", read] });
    const records = w.play(clicks).map((r) => [r.what, r.value]);
    assert.deepEqual(records, [
      ["tooltip", "OATS"],
      ["left", { opened: true }],
      ["run", line], ["right", { opened: false }],
    ]);
  });
}

const CLAIM = { since: "2026-10-19T10:00:00Z", producer: "oats.core", reason: "permission", message: "Allow Bash?" };

test("the panel's rows are cards: the name, the kernel's message, then reason · producer · age; a click opens the session", { skip }, (t) => {
  const w = world(t);
  const rows = [{ instance: "alpha", home: "/h/alpha", waitingOnYou: CLAIM }, { instance: "beta", home: "/h/beta", waitingOnYou: null }];
  const read = w.exe("cards.sh", `#!/bin/sh\ncat <<'E'\n${JSON.stringify({ ok: true, count: 2, rows })}\nE\n`);
  w.plugin({ waiting: ["/bin/sh", read], attach: ["s", "--home"] });
  const records = w.play(scene(`
  Timer { interval: 500; running: true; onTriggered: scene.w.open() }
  Timer { interval: 3000; running: true; onTriggered: {
    var items = scene.all(scene.w, [])
    var texts = []
    for (var i = 0; i < items.length; i++) if (typeof items[i].text === "string" && items[i].text !== "" && items[i].visible) texts.push(items[i].text)
    var cards = items.filter(function(x) { return x.shown !== undefined && x.highlighted !== undefined })
    scene.probe("panel", { texts: texts, cards: cards.map(function(c) { return c.label }) })
    cards[0].activated()
  } }`, 4));
  const [panel] = records.filter((r) => r.what === "panel").map((r) => r.value);
  assert.deepEqual(panel.cards, ["alpha", "beta"], "one WaitingCard per row");
  for (const text of ["alpha", "Allow Bash?", "beta"]) assert.ok(panel.texts.includes(text), `${text} in ${JSON.stringify(panel.texts)}`);
  assert.ok(panel.texts.some((x) => /^permission · oats\.core · \d+ (min|h|d)$/.test(x)), JSON.stringify(panel.texts));
  assert.deepEqual(records.filter((r) => r.what === "run").map((r) => r.value), [W.openCommand({ attach: ["s", "--home"] }, { home: "/h/alpha", steward: false })]);
});

test("the steward's card, in the panel and in the popup, runs the launcher, which focuses its open window: never a second viewer", { skip }, (t) => {
  const w = world(t);
  const rows = [{ instance: "steward", home: "/h/steward", waitingOnYou: CLAIM, steward: true }];
  const read = w.exe("steward.sh", `#!/bin/sh\ncat <<'E'\n${JSON.stringify({ ok: true, count: 1, rows })}\nE\n`);
  const plugin = { waiting: ["/bin/sh", read], attach: ["s", "--home"], launcher: ["/l/omarchy-launch-oats"] };
  w.plugin(plugin);
  const panel = w.play(scene(`
  Timer { interval: 500; running: true; onTriggered: scene.w.open() }
  Timer { interval: 3000; running: true; onTriggered: {
    var cards = scene.all(scene.w, []).filter(function(x) { return x.shown !== undefined && x.highlighted !== undefined })
    cards[0].activated()
  } }`, 4));
  assert.deepEqual(panel.filter((r) => r.what === "run").map((r) => r.value), [W.openCommand(plugin, { home: "/h/steward", steward: true })]);
  assert.equal(W.openCommand(plugin, { home: "/h/steward", steward: true }), "exec '/l/omarchy-launch-oats'");
  const popup = w.play(popupScene(`
  Timer { interval: 500; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 3000; running: true; onTriggered: scene.key(Qt.Key_Return) }`, 4));
  assert.deepEqual(popup.filter((r) => r.what === "exec").map((r) => r.value), [["/l/omarchy-launch-oats"]]);
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

// A scene with the popup (as `w`) in a window, a shell that logs what it is
// asked to hide, and an argv runner that logs what it would run (nothing is
// started); `key()` presses a key as the popup's keyboard handler receives it.
const popupScene = (body, seconds) => ({ seconds, qml: `import QtQuick
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
    Loader { id: loader; active: true; sourceComponent: Component { P.OatsWaiting { shell: fakeShell; manifest: ({ id: "ai.aweb.oats" }); execArgv: function(argv) { scene.probe("exec", argv) } } } }
  }
  readonly property var w: loader.item
  function key(k, mods) { var e = { key: k, modifiers: mods || 0, text: "", accepted: false }; scene.w.keyPressed(e); return e.accepted }
  function texts() {
    var out = []
    var items = scene.all(scene.w, [])
    for (var i = 0; i < items.length; i++) if (typeof items[i].text === "string" && items[i].text !== "" && items[i].visible) out.push(items[i].text)
    return out
  }
  function cards() { return scene.all(scene.w, []).filter(function(x) { return x.shown !== undefined && x.highlighted !== undefined && x.visible }) }
  function state() { return { opened: scene.w.opened, reading: scene.w.reading, index: scene.w.selectedIndex, texts: scene.texts(), lit: scene.cards().filter(function(c) { return c.highlighted }).map(function(c) { return c.label }) } }
  // Steps a frame or more apart, so the list has laid out what a key changed.
  property var steps: []
  property int step: 0
  function run(list) { scene.steps = list; scene.step = 0; stepper.start() }
  Timer { id: stepper; interval: 250; repeat: true; onTriggered: { if (scene.step < scene.steps.length) scene.steps[scene.step++](); else stop() } }
${body}
  Timer { interval: ${seconds * 1000}; running: true; onTriggered: Qt.quit() }
}
` });

const LISTED = {
  ok: true, count: 2,
  rows: [
    { instance: "alpha", home: "/h/alpha", deployment: "/d/one", workspace: "github.com/acme/one", waitingOnYou: CLAIM },
    { instance: "beta", home: "/h/beta", deployment: "/d/one", workspace: "github.com/acme/one", waitingOnYou: { since: null, producer: "agent", reason: "attention", message: null } },
  ],
  deployments: [
    { path: "/d/one", name: "one", workspace: "github.com/acme/one", ok: true },
    { path: "/d/two", name: "two", workspace: null, ok: false, reason: "oats-lock.json is unreadable" },
  ],
};

// A reader that logs each read and answers `result` after `delay` seconds.
function reader(w, result, delay = 0) {
  const log = join(w.root, "reads.log");
  const read = w.exe("waiting.sh", `#!/bin/sh\necho "$*" >> '${log}'\nsleep ${delay}\ncat <<'E'\n${JSON.stringify(result)}\nE\n`);
  const count = `n=$(cat '${log}' 2>/dev/null | wc -l); echo $n`;
  return { read, count, log };
}

test("the popup reads only when it opens and says so; it shows the panel's cards; Up/Down and Ctrl+J/K move; Enter opens the session as argv", { skip }, (t) => {
  const w = world(t);
  const r = reader(w, LISTED, 1);
  // A plugin.json setup 0.6.0 wrote, with Alt+O: the hint names the key it records.
  w.plugin({ deployment: null, attach: ["s", "--detach-key", "M-o", "--home"], waiting: ["/bin/sh", r.read, "--list"] });
  const records = w.play(popupScene(`
  Process { id: reads; command: ["/bin/sh", "-c", ${JSON.stringify(r.count)}]; stdout: StdioCollector { waitForEnd: true; onStreamFinished: scene.probe("reads", Number(text.trim())) } }
  Timer { interval: 1000; running: true; onTriggered: reads.running = true }
  Timer { interval: 1500; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 1800; running: true; onTriggered: scene.probe("reading", scene.state()) }
  Timer { interval: 4500; running: true; onTriggered: scene.run([
    function() { scene.probe("read", scene.state()); scene.key(Qt.Key_Down) },
    function() { scene.probe("down", scene.state()); scene.key(Qt.Key_K, Qt.ControlModifier) },
    function() { scene.probe("up", scene.state()); scene.key(Qt.Key_J, Qt.ControlModifier); scene.key(Qt.Key_Up) },
    function() { scene.probe("back", scene.state()); scene.key(Qt.Key_Return); scene.probe("after", { opened: scene.w.opened }) },
    function() { reads.running = true },
  ]) }`, 8));
  const by = (what) => records.filter((x) => x.what === what).map((x) => x.value);
  assert.deepEqual(by("reads"), [0, 1], "nothing before it opened; one read for one opening");
  const [reading] = by("reading");
  assert.equal(reading.reading, true);
  assert.ok(reading.texts.includes("Reading who is waiting on you…"), JSON.stringify(reading.texts));
  const [read] = by("read");
  assert.equal(read.reading, false);
  for (const text of ["Waiting on you", "alpha", "Allow Bash?", "beta", "attention · agent", "two: oats-lock.json is unreadable", "Alt+O leaves the viewer"]) assert.ok(read.texts.includes(text), `${text} in ${JSON.stringify(read.texts)}`);
  assert.ok(read.texts.some((x) => /^permission · oats\.core · \d+ (min|h|d)$/.test(x)), JSON.stringify(read.texts));
  assert.deepEqual(read.lit, ["alpha"], "the cursor is on the first card");
  assert.deepEqual([by("down")[0].lit, by("up")[0].lit, by("back")[0].lit], [["beta"], ["alpha"], ["alpha"]]);
  assert.deepEqual(by("exec"), [["omarchy-launch-floating-terminal-with-presentation", "'s' '--detach-key' 'M-o' '--home' '/h/alpha'"]]);
  assert.deepEqual(by("hide"), ["ai.aweb.oats"]);
  assert.deepEqual(by("after"), [{ opened: false }]);
  assert.equal(readFileSync(r.log, "utf8"), "--list --json\n", "the read is the plugin's waiting command with --json");
});

test("Esc closes the popup; an answer with nobody waiting never says nobody is; a failed read says why", { skip }, (t) => {
  const w = world(t);
  const quiet = w.exe("quiet.sh", `#!/bin/sh\necho '{"ok":true,"count":0,"rows":[]}'\n`);
  const failing = w.exe("fail.sh", `#!/bin/sh\necho '{"ok":false,"reason":"oats-lock.json is unreadable"}'\nexit 1\n`);
  w.plugin({ waiting: ["/bin/sh", quiet] });
  const next = JSON.stringify({ deployment: "/d", tui: null, desktop: null, attach: ["s", "--home"], setup: ["n", "s"], waiting: ["/bin/sh", failing] });
  const records = w.play(popupScene(`
  Process { id: write; command: ["/bin/sh", "-c", ${JSON.stringify(`cat > "$XDG_STATE_HOME/oats-omarchy/plugin.json" <<'E'\n${next}\nE\n`)}] }
  Timer { interval: 1000; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 2500; running: true; onTriggered: { scene.probe("quiet", scene.state()); scene.key(Qt.Key_Return); scene.key(Qt.Key_Escape); scene.probe("closed", scene.w.opened); write.running = true } }
  Timer { interval: 3500; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 5000; running: true; onTriggered: scene.probe("failed", scene.state()) }`, 6));
  const by = (what) => records.filter((x) => x.what === what).map((x) => x.value);
  const [quietState] = by("quiet");
  assert.ok(quietState.texts.includes("No agent has said it is waiting on you"), JSON.stringify(quietState.texts));
  assert.deepEqual(by("exec"), [], "Enter on no card opens nothing");
  assert.deepEqual(by("closed"), [false]);
  assert.deepEqual(by("hide"), ["ai.aweb.oats"]);
  const [failed] = by("failed");
  assert.ok(failed.texts.includes("oats-lock.json is unreadable"), JSON.stringify(failed.texts));
  assert.ok(!failed.texts.some((x) => /^No agent/.test(x)), "a failed read claims nothing");
  for (const state of [quietState, failed]) assert.ok(!state.texts.some((x) => /nobody|no one/i.test(x)));
});

test("before setup the popup offers setup only, and reads nothing", { skip }, (t) => {
  const w = world(t);
  const records = w.play(popupScene(`
  Timer { interval: 1000; running: true; onTriggered: scene.w.open("{}") }
  Timer { interval: 2000; running: true; onTriggered: { scene.probe("none", scene.state()); scene.key(Qt.Key_Return) } }`, 3));
  const by = (what) => records.filter((x) => x.what === what).map((x) => x.value);
  const [none] = by("none");
  assert.ok(none.texts.includes("OATS is not set up here yet: Enter runs setup."), JSON.stringify(none.texts));
  assert.ok(!none.texts.some((x) => /^No agent|^Reading/.test(x)), JSON.stringify(none.texts));
  assert.deepEqual(by("exec"), [["omarchy-launch-floating-terminal-with-presentation", setupLine(w)]]);
  assert.equal(existsSync(join(w.root, "reads.log")), false);
});
