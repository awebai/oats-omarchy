// The default UI: the TUI or the Desktop, which OATS in SUPER + SPACE (the
// menu's root row) and a right click on the bar icon open. --ui sets it;
// with both set up and no --ui, --apply asks in a terminal and refuses
// without one; with one set up, that one is the default and nothing is
// asked; a record from before 0.5.0 has none. No UI is ever started here:
// the launchers are the sandbox's stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths as discoverPaths } from "../lib/discover.mjs";
import * as menu from "../lib/menu.mjs";
import { shellWord } from "../lib/quote.mjs";
import { setup, UI_QUESTION } from "../lib/setup.mjs";
import { parsePlugin } from "../widget.mjs";
import { sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

// The Desktop's standard install, beside the TUI every sandbox has.
function withDesktop(s) {
  const image = join(s.home, ".local/opt/oats-desktop/OATS-Desktop.AppImage");
  writeExecutable(image, "#!/bin/sh\nexit 0\n");
  mkdirSync(join(s.home, ".local/share/applications"), { recursive: true });
  writeFileSync(join(s.home, ".local/share/applications/oats-desktop.desktop"), `[Desktop Entry]\nType=Application\nName=OATS Desktop\nExec=${image} %U\n`);
  return image;
}

const stateOf = (s) => JSON.parse(readFileSync(join(discoverPaths(s.env).stateDir, "state.json"), "utf8"));
const pluginOf = (s) => JSON.parse(readFileSync(join(discoverPaths(s.env).stateDir, "plugin.json"), "utf8"));
const itemsOf = (s) => menu.omarchyParse(readFileSync(discoverPaths(s.env).menuFile, "utf8")).items;

// setup() in this process, as from a terminal: the answers are given in
// turn; what it printed and each question asked come back.
function fromTerminal(s, args, answers) {
  let out = "";
  const asked = [];
  const queue = [...answers];
  const write = { write: (x) => { out += x; } };
  const status = setup([...args, "--dir", s.deployment], s.env, write, write, { interactive: true, ask: () => { asked.push(out.slice(out.lastIndexOf("\n") + 1)); return queue.shift() ?? ""; } });
  return { status, out, asked };
}

for (const ui of ["tui", "desktop"]) {
  test(`--ui ${ui}: --plan shows it, --apply records it, and the OATS row and a right click open it`, (t) => {
    const s = sandbox(t);
    withDesktop(s);
    const plan = s.run(["setup", "--plan", "--ui", ui, "--json"]);
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
    assert.deepEqual(plan.json.result.ui, { ui, from: "--ui", found: ["tui", "desktop"] });
    assert.match(s.run(["setup", "--plan", "--ui", ui]).stdout, new RegExp(`\\nDefault UI\\n  the ${ui === "tui" ? "TUI" : "Desktop"} \\(--ui\\): OATS in SUPER \\+ SPACE and a right click on the bar icon open it\\n`));
    const r = s.run(["setup", "--apply", "--ui", ui, "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(stateOf(s).ui, ui);
    const plugin = pluginOf(s);
    assert.equal(plugin.ui, ui);
    assert.equal(parsePlugin(JSON.stringify(plugin)).ui, ui);
    const items = itemsOf(s);
    assert.equal(items["oats-ui"].label, "OATS");
    assert.equal(items["oats-ui"].action, plugin[ui].map(shellWord).join(" "));
    assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
    // A re-apply keeps the choice without --ui, and --ui changes it.
    assert.deepEqual(s.run(["setup", "--apply", "--json"]).json.result.written, []);
    const other = ui === "tui" ? "desktop" : "tui";
    assert.equal(s.run(["setup", "--apply", "--ui", other]).status, 0);
    assert.equal(stateOf(s).ui, other);
    assert.equal(itemsOf(s)["oats-ui"].action, pluginOf(s)[other].map(shellWord).join(" "));
  });
}

test("both set up, no --ui, in a terminal: --apply asks which opens first; Enter is the TUI", (t) => {
  const s = sandbox(t);
  withDesktop(s);
  const r = fromTerminal(s, ["--apply"], ["", "y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [UI_QUESTION, "Apply it? [y/N] "]);
  assert.equal(UI_QUESTION, "Open which OATS first: TUI or Desktop? [TUI/desktop] ");
  assert.match(r.out, /\nDefault UI\n {2}the TUI \(your answer\)/, "the plan it shows has the answer");
  assert.equal(stateOf(s).ui, "tui");
  // Asked again only when no choice is recorded.
  const again = fromTerminal(s, ["--apply"], ["y"]);
  assert.deepEqual(again.asked, ["Apply it? [y/N] "]);
});

test("--yes in a terminal still asks which opens first; it answers only Apply it?", (t) => {
  const s = sandbox(t);
  withDesktop(s);
  const r = fromTerminal(s, ["--apply", "--yes"], ["desktop"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [UI_QUESTION]);
  assert.equal(stateOf(s).ui, "desktop");
  assert.equal(itemsOf(s)["oats-ui"].action, pluginOf(s).desktop.map(shellWord).join(" "));
});

test("the question takes TUI or Desktop in any case, and asks again for anything else; n still aborts", (t) => {
  const s = sandbox(t);
  withDesktop(s);
  const r = fromTerminal(s, ["--apply"], ["web", "DESKTOP", "y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [UI_QUESTION, UI_QUESTION, "Apply it? [y/N] "]);
  assert.ok(r.out.includes("Answer TUI or Desktop (Enter is TUI).\n"));
  assert.equal(stateOf(s).ui, "desktop");
  const fresh = sandbox(t);
  withDesktop(fresh);
  const before = snapshot(fresh.home);
  const no = fromTerminal(fresh, ["--apply"], ["d", "n"]);
  assert.equal(no.status, 1);
  assert.match(no.out, /aborted: nothing was changed/);
  assert.deepEqual(snapshot(fresh.home), before);
});

test("both set up, no --ui, no terminal: --apply refuses with E_UI_REQUIRED, says to pass --ui, and writes nothing; --plan says it is not chosen", (t) => {
  const s = sandbox(t);
  withDesktop(s);
  const before = snapshot(s.home);
  // With --yes, and without it: the refusal names --ui first, then the
  // --yes still missing, so one command follows it.
  for (const [yes, remedy] of [[true, "run setup --apply --ui tui|desktop"], [false, "run setup --apply --ui tui|desktop --yes"]]) {
    const r = s.run(["setup", "--apply", "--json"], {}, { yes });
    assert.equal(r.status, 1);
    assert.equal(r.json.error.code, "E_UI_REQUIRED", `yes: ${yes}`);
    assert.equal(r.json.error.message, `both the OATS TUI and OATS Desktop are set up, and setup cannot ask which opens first without a terminal: ${remedy}`);
    const text = s.run(["setup", "--apply"], {}, { yes });
    assert.equal(text.status, 1);
    assert.equal(text.stderr, `setup: ${r.json.error.message}\n`);
  }
  // Following the remedy works.
  assert.equal(s.run(["setup", "--apply", "--ui", "tui", "--yes", "--json"], {}, { yes: false }).status, 0);
  assert.equal(stateOf(s).ui, "tui");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
  const plan = s.run(["setup", "--plan", "--json"]);
  assert.equal(plan.status, 0);
  assert.deepEqual(plan.json.result.ui, { ui: "tui", from: "not chosen yet", found: ["tui", "desktop"], pending: true });
  assert.match(s.run(["setup", "--plan"]).stdout, /\n {2}--apply asks which opens first, TUI unless you answer Desktop; or pass --ui tui\|desktop\n/);
});

test("only one set up: it is the default, nothing is asked, and no choice is recorded; the other found later asks", (t) => {
  const s = sandbox(t);
  const r = fromTerminal(s, ["--apply"], ["y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, ["Apply it? [y/N] "]);
  assert.match(r.out, /\nDefault UI\n {2}the TUI \(the only one set up\)/);
  assert.equal(stateOf(s).ui, null);
  assert.equal(pluginOf(s).ui, "tui");
  assert.equal(itemsOf(s)["oats-ui"].action, pluginOf(s).tui.map(shellWord).join(" "));
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  // --ui naming the one that is not set up is refused, with why.
  const bad = s.run(["setup", "--apply", "--ui", "desktop", "--json"]);
  assert.equal(bad.json.error.code, "E_UI");
  assert.match(bad.json.error.message, /^--ui desktop: setup has no OATS Desktop to open \(no OATS Desktop found.*\); pass --ui tui$/);
  // The Desktop arrives: now there is a choice to make.
  withDesktop(s);
  assert.equal(s.run(["setup", "--apply", "--json"]).json.error.code, "E_UI_REQUIRED");
  const asked = fromTerminal(s, ["--apply"], ["desktop", "y"]);
  assert.deepEqual(asked.asked, [UI_QUESTION, "Apply it? [y/N] "]);
  assert.equal(stateOf(s).ui, "desktop");
});

test("--ui with one set up is recorded and kept: the other found later asks nothing, and a --ui alone rewrites the state", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["setup", "--apply", "--ui", "tui"]).status, 0);
  assert.equal(stateOf(s).ui, "tui");
  assert.match(s.run(["setup", "--plan", "--ui", "tui"]).stdout, /\nDefault UI\n {2}the TUI \(--ui\)/);
  withDesktop(s);
  const r = fromTerminal(s, ["--apply"], ["y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, ["Apply it? [y/N] "]);
  assert.match(r.out, /\nDefault UI\n {2}the TUI \(chosen at an earlier --apply\)/);
  assert.equal(stateOf(s).ui, "tui");
  assert.equal(s.run(["setup", "--apply", "--json"]).status, 0, "no terminal: the recorded choice stands");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);

  // One UI, no choice recorded: a --ui that changes only the state writes it.
  const one = sandbox(t);
  assert.equal(one.run(["setup", "--apply"]).status, 0);
  assert.equal(stateOf(one).ui, null);
  const again = one.run(["setup", "--apply", "--ui", "tui", "--json"]);
  assert.equal(again.status, 0);
  assert.deepEqual(again.json.result.written, []);
  assert.equal(stateOf(one).ui, "tui");
  assert.deepEqual(one.run(["setup", "--apply", "--json"]).json.result.written, []);
  assert.equal(stateOf(one).ui, "tui", "a later --apply without --ui keeps it");
});

test("the Desktop alone: it is the default; --ui tui is refused, with why", (t) => {
  const s = sandbox(t, { launchers: ["omarchy-launch-or-focus-tui", "omarchy-launch-or-focus", "uwsm-app", "omarchy-hook", "omarchy-menu-select", "omarchy-launch-floating-terminal-with-presentation", "omarchy-notification-send"], kernel: "none" });
  withDesktop(s);
  const plan = s.run(["setup", "--plan", "--json"]);
  assert.equal(plan.json.result.parts.find((x) => x.part === "tui").status, "skipped");
  assert.deepEqual(plan.json.result.ui, { ui: "desktop", from: "the only one set up", found: ["desktop"] });
  assert.match(s.run(["setup", "--plan", "--ui", "tui", "--json"]).json.error.message, /^--ui tui: setup has no OATS TUI to open \(the OATS CLI cannot be used: .*\); pass --ui desktop$/);
});

test("a record from before 0.5.0 with both UIs: --check says the default UI is not chosen; the widget reads it as the TUI", (t) => {
  const s = sandbox(t);
  withDesktop(s);
  assert.equal(s.run(["setup", "--apply", "--ui", "tui"]).status, 0);
  const statePath = join(discoverPaths(s.env).stateDir, "state.json");
  const { ui: _ui, ...old } = stateOf(s);
  writeFileSync(statePath, `${JSON.stringify({ ...old, version: "0.4.0" }, null, 2)}\n`);
  const { ui: _p, ...plugin } = pluginOf(s);
  writeFileSync(join(discoverPaths(s.env).stateDir, "plugin.json"), `${JSON.stringify(plugin, null, 2)}\n`);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, ["default UI not chosen: run setup --apply --ui tui|desktop"]);
  assert.equal(parsePlugin(JSON.stringify(plugin)).ui, "tui");
  // Without a terminal the re-apply needs --ui, as on a new home.
  assert.equal(s.run(["setup", "--apply", "--json"]).json.error.code, "E_UI_REQUIRED");
  assert.equal(s.run(["setup", "--apply", "--ui", "desktop"]).status, 0);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  assert.equal(pluginOf(s).ui, "desktop");
});

test("a record from before 0.5.0 with one UI: no choice to make, nothing reported", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const statePath = join(discoverPaths(s.env).stateDir, "state.json");
  const { ui: _ui, ...old } = stateOf(s);
  writeFileSync(statePath, `${JSON.stringify({ ...old, version: "0.3.0" }, null, 2)}\n`);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

test("--ui takes tui or desktop, with --plan or --apply only", (t) => {
  const s = sandbox(t);
  for (const args of [["setup", "--plan", "--ui", "web"], ["setup", "--apply", "--ui"], ["setup", "--check", "--ui", "tui"], ["setup", "--remove", "--ui=desktop"]]) {
    const r = s.run(args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /--ui/);
  }
  assert.equal(s.run(["setup", "--plan", "--ui=tui", "--json"]).json.result.ui.from, "--ui");
  assert.equal(existsSync(join(s.home, ".local/state/oats-omarchy")), false);
});
