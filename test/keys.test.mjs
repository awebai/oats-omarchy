// The suggested key binding: parsing `omarchy menu keybindings --print`, the
// conflict rules, and the snippet in both config formats. CI also runs each
// printed snippet through Hyprland --verify-config (test/omarchy-container.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentPop, definesSubmap, nextFreeKey, normalizeCombo, onlyStatic, parsePrint, planKeys, POP } from "../oats-package/capabilities/oats-omarchy/lib/keys.mjs";
import { fixture } from "./helpers/sandbox.mjs";

const captured = readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8");
const lua = { kind: "lua", file: "/h/.config/hypr/bindings.lua" };
const conf = { kind: "conf", file: "/h/.config/hypr/bindings.conf" };
const TUI = "omarchy-launch-or-focus-tui --app-id=org.oats.tui /d/oats tui --dir /dep";
const DESKTOP = `omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- '/a b/OATS.AppImage' --dir /dep"`;
const rebind = (text, combo, action) => text.split("\n").map((l) => (l.startsWith(`${combo} `) ? `${combo.padEnd(35)} → ${action}` : l)).join("\n");

test("--print lines parse into combos, modifiers in one order, each line once", () => {
  assert.equal(normalizeCombo("SUPER SHIFT + F"), "SUPER + SHIFT + F");
  assert.equal(normalizeCombo("SUPER SHIFT CTRL + SPACE"), "SUPER + SHIFT + CTRL + SPACE");
  assert.equal(normalizeCombo("ctrl alt + delete"), "CTRL + ALT + DELETE");
  assert.equal(normalizeCombo("XF86AudioMute"), "XF86AUDIOMUTE");
  const binds = parsePrint(`${captured}${captured}`);
  assert.equal(binds.length, parsePrint(captured).length, "a doubled print gives the same binds");
  assert.deepEqual(binds.find((b) => b.combo === "SUPER + O"), { combo: "SUPER + O", action: POP.description });
  assert.deepEqual(binds.filter((b) => b.combo === "ALT + TAB").map((b) => b.action), ["Focus on next window", "Reveal active window on top"]);
  assert.ok(binds.some((b) => b.combo === "SUPER + SHIFT + O"));
});

test("only Omarchy's two static bindings means no Hyprland answered", () => {
  assert.equal(onlyStatic(parsePrint(readFileSync(fixture("print", "no-hyprland.txt"), "utf8"))), true);
  assert.equal(onlyStatic(parsePrint(captured)), false);
});

test("what SUPER + O does now", () => {
  const isCommand = (t) => t.startsWith("my-");
  assert.equal(currentPop(parsePrint(captured), isCommand).kind, "default");
  assert.deepEqual(currentPop(parsePrint(rebind(captured, "SUPER + O", "my-thing --flag")), isCommand), { kind: "command", description: "my-thing --flag", command: "my-thing --flag" });
  assert.deepEqual(currentPop(parsePrint(rebind(captured, "SUPER + O", "Obsidian notes")), isCommand), { kind: "description", description: "Obsidian notes" });
  assert.equal(currentPop(parsePrint(captured.split("\n").filter((l) => !l.startsWith("SUPER + O ")).join("\n")), isCommand).kind, "unbound");
  assert.equal(currentPop(parsePrint(rebind(captured, "SUPER + O", "OATS")), isCommand).kind, "ours");
});

test("a submap named oats is found in Lua and hyprlang, and not in a comment's lookalike", () => {
  assert.equal(definesSubmap(`hl.define_submap("oats", "reset", function() end)`, "oats"), true);
  assert.equal(definesSubmap(`hl.define_submap( 'oats' , function() end)`, "oats"), true);
  assert.equal(definesSubmap("submap = oats, reset\nsubmap = reset", "oats"), true);
  assert.equal(definesSubmap("submap = oatsy\nhl.define_submap(\"boats\")", "oats"), false);
});

test("the next free key tries SUPER + SHIFT + O first", () => {
  assert.equal(nextFreeKey(parsePrint("SUPER + A → x")), "SUPER + SHIFT + O");
  // The capture binds SUPER + SHIFT + O (Obsidian) and SUPER + A..; the first free letter wins.
  const binds = parsePrint(captured);
  const free = nextFreeKey(binds);
  assert.match(free, /^SUPER \+ [A-Z]$/);
  assert.ok(!binds.some((b) => b.combo === free));
});

test("Omarchy's defaults: the snippet takes SUPER + O and keeps pop-out on the double tap", () => {
  const k = planKeys({ layout: lua, print: { ok: true, text: captured }, tui: TUI, desktop: DESKTOP });
  assert.equal(k.status, "suggested");
  assert.equal(k.entry, "SUPER + O");
  assert.equal(k.snippet, `-- OATS: SUPER + O, then T (TUI) or D (Desktop); O again pops the window out.
hl.unbind("SUPER + O")
o.bind("SUPER + O", "OATS", hl.dsp.submap("oats"))
hl.define_submap("oats", "reset", function()
  o.bind("T", "OATS TUI", "omarchy-launch-or-focus-tui --app-id=org.oats.tui /d/oats tui --dir /dep")
  o.bind("SUPER + T", "OATS TUI", "omarchy-launch-or-focus-tui --app-id=org.oats.tui /d/oats tui --dir /dep")
  o.bind("D", "OATS Desktop", "omarchy-launch-or-focus awebai-oats-desktop \\"uwsm-app -- '/a b/OATS.AppImage' --dir /dep\\"")
  o.bind("SUPER + D", "OATS Desktop", "omarchy-launch-or-focus awebai-oats-desktop \\"uwsm-app -- '/a b/OATS.AppImage' --dir /dep\\"")
  o.bind("O", "Pop window out", "omarchy-hyprland-window-pop")
  o.bind("SUPER + O", "Pop window out", "omarchy-hyprland-window-pop")
  hl.bind("escape", hl.dsp.submap("reset"))
  hl.bind("catchall", hl.dsp.submap("reset"))
end)
`);
  assert.ok(k.notes.some((n) => /two taps/.test(n)), "the plan states the cost");
});

test("the hyprlang snippet is the same binding", () => {
  const k = planKeys({ layout: conf, print: { ok: true, text: captured }, tui: TUI, desktop: DESKTOP });
  assert.equal(k.format, "conf");
  assert.equal(k.snippet, `# OATS: SUPER + O, then T (TUI) or D (Desktop); O again pops the window out.
unbind = SUPER, O
bindd = SUPER, O, OATS, submap, oats
submap = oats, reset
bindd = , T, OATS TUI, exec, omarchy-launch-or-focus-tui --app-id=org.oats.tui /d/oats tui --dir /dep
bindd = SUPER, T, OATS TUI, exec, omarchy-launch-or-focus-tui --app-id=org.oats.tui /d/oats tui --dir /dep
bindd = , D, OATS Desktop, exec, omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- '/a b/OATS.AppImage' --dir /dep"
bindd = SUPER, D, OATS Desktop, exec, omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- '/a b/OATS.AppImage' --dir /dep"
bindd = , O, Pop window out, exec, omarchy-hyprland-window-pop
bindd = SUPER, O, Pop window out, exec, omarchy-hyprland-window-pop
bind = , escape, submap, reset
bind = , catchall, submap, reset
submap = reset
`);
  const hash = planKeys({ layout: conf, print: { ok: true, text: captured }, tui: "x --dir '/a#b'", desktop: null });
  assert.match(hash.snippet, /exec, x --dir '\/a##b'$/m, "hyprlang reads # as a comment, so it is doubled");
});

test("SUPER + O rebound to a command: the double tap runs that command, and the plan says so", () => {
  const k = planKeys({ layout: lua, print: { ok: true, text: rebind(captured, "SUPER + O", "my-tool --pop") }, tui: TUI, desktop: DESKTOP, isCommand: (t) => t.startsWith("my-tool") });
  assert.equal(k.pop.kind, "command");
  assert.match(k.snippet, /o\.bind\("O", "my-tool --pop", "my-tool --pop"\)/);
  assert.match(k.snippet, /o\.bind\("SUPER \+ O", "my-tool --pop", "my-tool --pop"\)/);
  assert.match(k.snippet, /O again runs what SUPER \+ O ran/);
  assert.ok(k.notes.some((n) => n.includes("runs `my-tool --pop`")));
});

test("SUPER + O rebound with a description: the double tap is shown commented out, with a placeholder to fill in", () => {
  const k = planKeys({ layout: lua, print: { ok: true, text: rebind(captured, "SUPER + O", "Scratch notes") }, tui: TUI, desktop: DESKTOP });
  assert.equal(k.pop.kind, "description");
  assert.match(k.snippet, /^ {2}-- o\.bind\("O", "Scratch notes", "<the command SUPER \+ O ran>"\)$/m);
  assert.match(k.snippet, /^ {2}-- o\.bind\("SUPER \+ O", "Scratch notes", "<the command SUPER \+ O ran>"\)$/m);
  assert.match(k.snippet, /^hl\.unbind\("SUPER \+ O"\)$/m);
  assert.match(k.fillIn, /Fill in the command SUPER \+ O runs \("Scratch notes"\)/);
  assert.ok(k.notes.some((n) => n.includes('SUPER + O runs "Scratch notes"')));
  const c = planKeys({ layout: conf, print: { ok: true, text: rebind(captured, "SUPER + O", "Scratch notes") }, tui: TUI, desktop: DESKTOP });
  assert.match(c.snippet, /^# bindd = , O, Scratch notes, exec, <the command SUPER \+ O ran>$/m);
});

test("SUPER + O unbound by the user: no unbind and no double tap", () => {
  const text = captured.split("\n").filter((l) => !l.startsWith("SUPER + O ")).join("\n");
  const k = planKeys({ layout: lua, print: { ok: true, text }, tui: TUI, desktop: DESKTOP });
  assert.equal(k.pop.kind, "unbound");
  assert.doesNotMatch(k.snippet, /unbind|Pop window out/);
  assert.match(k.snippet, /^-- OATS: SUPER \+ O, then T \(TUI\) or D \(Desktop\)\.$/m);
  assert.ok(k.notes.some((n) => /no double-tap/.test(n)));
});

test("keys already pasted (SUPER + O → OATS): in place, no snippet", () => {
  const k = planKeys({ layout: lua, print: { ok: true, text: rebind(captured, "SUPER + O", "OATS") }, userText: 'hl.define_submap("oats", "reset", f)', tui: TUI, desktop: DESKTOP });
  assert.equal(k.status, "in-place");
  assert.equal(k.snippet, null);
});

test("a user submap named oats that is not ours: the next free key and another submap name", () => {
  const k = planKeys({ layout: lua, print: { ok: true, text: captured }, userText: 'hl.define_submap("oats", "reset", function() end)', tui: TUI, desktop: DESKTOP });
  const free = nextFreeKey(parsePrint(captured));
  assert.equal(k.entry, free);
  assert.equal(k.submap, "oats-omarchy");
  assert.doesNotMatch(k.snippet, /unbind|Pop window out/, "SUPER + O is left alone");
  assert.match(k.snippet, new RegExp(`o\\.bind\\("${free.replace(/\+/g, "\\+")}", "OATS", hl\\.dsp\\.submap\\("oats-omarchy"\\)\\)`));
  const shifted = planKeys({ layout: lua, print: { ok: true, text: "SUPER + O → Pop window out (float & pin)" }, userText: "submap = oats, reset", tui: TUI, desktop: null });
  assert.equal(shifted.entry, "SUPER + SHIFT + O");
});

test("the key check could not run: the default snippet, and the plan says why", () => {
  const k = planKeys({ layout: lua, print: { ok: false, reason: "no running Hyprland answered" }, tui: TUI, desktop: DESKTOP });
  assert.equal(k.status, "unchecked");
  assert.match(k.snippet, /hl\.unbind\("SUPER \+ O"\)/);
  assert.match(k.notes[0], /could not run \(no running Hyprland answered\)/);
});

test("a skipped Desktop leaves out the D lines and says why", () => {
  const k = planKeys({ layout: lua, print: { ok: true, text: captured }, tui: TUI, desktop: null, desktopSkipped: "no OATS Desktop found" });
  assert.doesNotMatch(k.snippet, /"D"|SUPER \+ D/);
  assert.match(k.snippet, /^-- OATS: SUPER \+ O, then T \(TUI\); O again pops the window out\.$/m);
  assert.ok(k.notes.includes("The D lines are left out: no OATS Desktop found."));
});

test("descriptions and commands are Lua-escaped", () => {
  const k = planKeys({ layout: lua, print: { ok: true, text: captured }, tui: 'x "q" \\ y', desktop: null });
  assert.match(k.snippet, /o\.bind\("T", "OATS TUI", "x \\"q\\" \\\\ y"\)/);
});
