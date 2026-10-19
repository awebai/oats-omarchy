// The bar widget itself, in Quickshell: OatsBarWidget.qml loaded with
// Omarchy's own Ui and Commons modules, offscreen, with a temporary HOME and
// XDG directories and a stand-in for the bar. The panel's layer-shell window
// needs a Wayland compositor, so only that one type, KeyboardPanel, is a
// stand-in: an Item with its properties, a card on a short screen. Each case
// is a small QML scene that logs "PROBE <json>" lines. Runs in CI's Omarchy
// container (OATS_OMARCHY_CONTAINER=1), where Quickshell and the shell are
// installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  for (const name of ["OatsBarWidget.qml", "widget.mjs", "assets"]) cpSync(join(repo, name), join(cfg, "plugin", name), { recursive: true });
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
    scene.probe("layout", { badge: scene.w.badge, card: card.height, flick: flick, texts: texts })
  } }`, 4));
  const { badge, card, flick, texts } = report.value;
  assert.equal(badge, "50");
  assert.ok(flick && flick.interactive && flick.height < flick.contentHeight && flick.height > 0, JSON.stringify(flick));
  for (const label of ["Alt+O leaves the viewer", "Open OATS TUI", "Open OATS Desktop", "Set up keys and launchers", "agent-0"]) {
    assert.equal(texts[label], true, `${label} is inside the ${card}px card`);
  }
  assert.equal(texts["agent-49"], false, "the last rows are scrolled out of view, not pushed out of the card");
  // Beyond the instance names: the badge, the button labels and the hint.
  const allowed = ["50", "OATS", "Alt+O leaves the viewer", "Open OATS TUI", "Open OATS Desktop", "Set up keys and launchers"];
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
  Timer { interval: 2500; running: true; onTriggered: ps.running = true }
  Timer { interval: 3500; running: true; onTriggered: loader.active = false }
  Timer { interval: 5000; running: true; onTriggered: ps.running = true }`, 6));
  assert.deepEqual(records.map((r) => r.value), [3, 0], "waiting, the shim's sleep and its child; then none");
});

test("a read whose program cannot start shows ? at the deadline, at the shortest refresh interval", { skip }, (t) => {
  const w = world(t);
  w.plugin({ waiting: [join(w.root, "gone", "node"), "waiting.mjs"] });
  const records = w.play(scene(`
  Timer { interval: 20000; running: true; onTriggered: scene.probe("at 20 s", scene.w.badge) }
  Timer { interval: 33000; running: true; onTriggered: scene.probe("at 33 s", scene.w.badge) }`, 34, { settings: "({ refreshIntervalSec: 15 })" }));
  assert.deepEqual(records.map((r) => [r.what, r.value]), [["at 20 s", ""], ["at 33 s", "?"]]);
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
