// The oats block in the user's Omarchy menu file: where it goes, how it
// comes out byte for byte, and setup's menu part end to end. Omarchy's own
// parser runs in the container test; here omarchyParse stands in for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as menu from "../lib/menu.mjs";
import { repo, sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

const BLOCK = menu.block({ ui: "tui", tui: "launch-tui", desktop: null, waiting: "wait-cmd", status: "status-cmd" });
const OURS = ["oats-ui", "oats", "oats.tui", "oats.waiting", "oats.status"];

// Inserted, read the way Omarchy reads it, then taken out again.
function roundTrip(text) {
  const ins = menu.insertBlock(text, BLOCK);
  assert.ok(ins, "insertable");
  const parsed = menu.omarchyParse(ins.text);
  assert.ok(parsed.ok, parsed.reason);
  assert.deepEqual(Object.keys(parsed.items).filter((id) => id.startsWith("oats")), OURS);
  assert.equal(menu.verifyEdit(text, ins.text, BLOCK), null);
  const out = menu.removeBlock(ins.text, { ...ins, block: BLOCK });
  return { ins, parsed, out };
}

test("the block: a delimited set of rows, one per line, each with a trailing comma", () => {
  const lines = BLOCK.split("\n");
  assert.equal(lines[0], "  // >>> oats-omarchy (managed by setup; remove with setup --remove) >>>");
  assert.equal(lines.at(-2), "  // <<< oats-omarchy <<<");
  assert.deepEqual(lines.slice(1, -2).map((l) => JSON.parse(`{${l.trim().replace(/,$/, "")}}`)).map((o) => Object.keys(o)[0]), OURS);
  const items = menu.omarchyParse(`{\n${BLOCK}}\n`).items;
  assert.deepEqual(items["oats.waiting"], { icon: "\u{F009A}", label: "Waiting on you", action: `[ "$(omarchy-shell shell summon ai.aweb.oats '{}' 2>/dev/null)" = ok ] || wait-cmd` });
  // The root row opens the default UI; the submenu is found by "oats".
  assert.deepEqual(items["oats-ui"], { icon: "\u{F06A9}", label: "OATS", action: "launch-tui" });
  assert.deepEqual(items.oats, { icon: "\u{F066F}", label: "Agent team", aliases: ["oats"] });
  assert.equal(menu.omarchyParse(`{\n${menu.block({ ui: "desktop", tui: "t", desktop: "d", waiting: "w", status: "s" })}}\n`).items["oats-ui"].action, "d");
  assert.ok(menu.block({ tui: null, desktop: "d", waiting: "w", status: "s" }).includes('"oats.desktop"'));
  assert.ok(!menu.block({ tui: null, desktop: null, waiting: "w", status: "s" }).includes('"oats.tui"'));
  assert.ok(!menu.block({ ui: null, tui: "t", desktop: null, waiting: "w", status: "s" }).includes('"oats-ui"'), "no default UI, no row");
});

test("the user's last entry with and without a trailing comma, one line, empty object: every byte comes back", () => {
  for (const text of [
    '{\n  "mine": {"label":"Mine","action":"true"},\n}\n',
    '{\n  "mine": {"label":"Mine","action":"true"}\n}\n',
    '{\n  "mine": {"label":"Mine","action":"true"}\n  // a closing comment, with a } and a "quote\n}\n',
    '{"mine":{"label":"Mine"}}',
    '{}\n',
    '{\n  // only comments\n}\n',
    '  {\n\t"mine": {"label":"x } // not a comment"},\n\t"n": 1\n  }  \n\n',
  ]) {
    const { parsed, out } = roundTrip(text);
    assert.equal(out, text, JSON.stringify(text));
    if (text.includes('"mine"')) assert.ok(parsed.items.mine, "the user's item is still read");
  }
  assert.equal(menu.insertBlock('{\n  "mine": {"label":"Mine"},\n}\n', BLOCK).comma, false, "a trailing comma is kept, none added");
  assert.equal(menu.insertBlock('{\n  "mine": {"label":"Mine"}\n}\n', BLOCK).comma, true);
  assert.equal(menu.insertBlock("{}\n", BLOCK).comma, false);
  assert.equal(menu.insertBlock('{"mine":1}', BLOCK).text, `{"mine":1,\n${BLOCK}}`);
});

test("no file, or only comments and whitespace: an object holding the block goes after the user's bytes", () => {
  const ins = menu.insertBlock("", BLOCK);
  assert.equal(ins.text, `{\n${BLOCK}}\n`);
  assert.equal(ins.created, true);
  assert.equal(menu.removeBlock(ins.text, { ...ins, block: BLOCK }), ins.skeleton);
  const notes = "// My menu customization notes\n// Keep the work shortcuts here.\n";
  for (const text of [notes, " \n", "// no newline at the end"]) {
    const it = menu.insertBlock(text, BLOCK);
    assert.ok(it.text.startsWith(text), "every byte the user had stays in place");
    assert.deepEqual(Object.keys(menu.omarchyParse(it.text).items), OURS);
    assert.equal(menu.removeBlock(it.text, { ...it, block: BLOCK }), it.skeleton);
  }
});

test("a byte-order mark before a leading comment: Omarchy reads the file, and so does setup", () => {
  const text = '\uFEFF// menu\n{\n  "mine": {"label":"Mine","action":"true"}\n}\n';
  assert.deepEqual(Object.keys(menu.omarchyParse(text).items), ["mine"]);
  const { out } = roundTrip(text);
  assert.equal(out, text);
  // A mark before the object itself is not JSON: Omarchy cannot read it, nor setup.
  assert.equal(menu.omarchyParse('\uFEFF{"mine":1}').ok, false);
  assert.equal(menu.insertBlock('\uFEFF{"mine":1}', BLOCK), null);
});

test("an `items` wrapper: the block goes inside items, where Omarchy reads", () => {
  const text = '{\n  "items": {\n    "mine": {"label":"Mine"}\n  },\n  "other": {"x": 1}\n}\n';
  const { ins, parsed, out } = roundTrip(text);
  assert.equal(parsed.wrapped, true);
  assert.ok(ins.text.indexOf(menu.START) < ins.text.indexOf('"other"'));
  assert.equal(out, text);
});

test("a user entry added after the block: the separating comma stays, and the file stays readable", () => {
  const text = '{\n  "mine": {"label":"Mine"}\n}\n';
  const ins = menu.insertBlock(text, BLOCK);
  const later = ins.text.replace(/\}\n$/, '  "later": {"label":"Later"}\n}\n');
  const out = menu.removeBlock(later, { ...ins, block: BLOCK });
  assert.equal(out, '{\n  "mine": {"label":"Mine"},\n  "later": {"label":"Later"}\n}\n');
  assert.deepEqual(Object.keys(menu.omarchyParse(out).items), ["mine", "later"]);
});

test("a changed block is not taken out; a replaced block keeps its place, `$` and all", () => {
  const ins = menu.insertBlock('{\n  "mine": 1\n}\n', BLOCK);
  const rec = { ...ins, block: BLOCK };
  assert.equal(menu.removeBlock(ins.text.replace('"Status"', '"My status"'), rec), null);
  assert.equal(menu.removeBlock('{\n  "mine": 1\n}\n', rec), null);
  const next = menu.block({ tui: "launch-tui", desktop: "run $& $1 $$", waiting: "wait-cmd", status: "status-cmd" });
  const replaced = menu.replaceBlock(ins.text, rec, next);
  assert.ok(replaced.text.includes('"action":"run $& $1 $$"'));
  assert.equal(menu.removeBlock(replaced.text, { ...rec, block: next, inserted: replaced.inserted }), '{\n  "mine": 1\n}\n');
});

test("what setup refuses to edit: Omarchy cannot read the file, ids of ours already there, rows Omarchy would misread", () => {
  assert.equal(menu.omarchyParse('{\n  "mine": 1, // an inline comment\n}\n').ok, false);
  assert.equal(menu.omarchyParse('{ /* block */ "mine": 1 }').ok, false);
  assert.equal(menu.omarchyParse("[1]").ok, false);
  assert.deepEqual(menu.conflicts('{\n  "oats": {"label":"Mine"},\n  "oats.status": {}\n}\n'), ["oats", "oats.status"]);
  const odd = menu.block({ tui: null, desktop: null, waiting: "echo a, }", status: "s" });
  const ins = menu.insertBlock("{}\n", odd);
  assert.match(menu.verifyEdit("{}\n", ins.text, odd), /would not read the menu item oats\.waiting as written/);
});

// ---------------------------------------------------------------------------
// Setup's menu part.

const MENU = (s) => join(s.home, ".config/omarchy/extensions/omarchy-menu.jsonc");
const part = (r, name) => r.json.result.parts.find((x) => x.part === name);

test("--apply with no menu file creates it with the block; --remove deletes it and the directory it made", (t) => {
  const s = sandbox(t);
  mkdirSync(join(s.home, ".config/omarchy"), { recursive: true });
  const before = snapshot(s.home);
  const plan = s.run(["setup", "--plan", "--json"]);
  assert.deepEqual(part(plan, "menu"), { part: "menu", status: "will apply", paths: [MENU(s)] });
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const text = readFileSync(MENU(s), "utf8");
  assert.ok(text.startsWith(`{\n${menu.START}`));
  const items = menu.omarchyParse(text).items;
  assert.deepEqual(Object.keys(items), OURS);
  assert.equal(items["oats.waiting"].action, menu.popupAction(`'${process.execPath}' '${repo}/bin/waiting.mjs' --dir '${s.deployment}'`));
  assert.equal(items["oats-ui"].action, items["oats.tui"].action);
  assert.equal(items["oats.status"].action, `omarchy-launch-floating-terminal-with-presentation "cd '${s.deployment}' && '${join(s.home, ".local/share/oats-omarchy/oats")}' status"`);
  assert.equal(part(s.run(["setup", "--apply", "--json"]), "menu").status, "already applied");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

for (const [name, text] of [
  ["with a trailing comma", '{\n  // my menu\n  "mine": {"icon":"m","label":"Mine","action":"true"},\n}\n'],
  ["without a trailing comma", '{\n  "mine": {"icon":"m","label":"Mine","action":"true"}\n}'],
]) {
  test(`a user menu file ${name}: only the block (and its comma) is added and taken out`, (t) => {
    const s = sandbox(t);
    mkdirSync(join(MENU(s), ".."), { recursive: true });
    writeFileSync(MENU(s), text);
    const before = snapshot(s.home);
    assert.equal(s.run(["setup", "--apply"]).status, 0);
    const after = readFileSync(MENU(s), "utf8");
    assert.deepEqual(Object.keys(menu.omarchyParse(after).items), ["mine", ...OURS]);
    // The user adds a row of their own, before ours; --remove keeps it.
    writeFileSync(MENU(s), after.replace('"mine"', '"first": {"label":"First"},\n  "mine"'));
    assert.equal(s.run(["setup", "--remove"]).status, 0);
    assert.equal(readFileSync(MENU(s), "utf8"), text.replace('"mine"', '"first": {"label":"First"},\n  "mine"'));
    writeFileSync(MENU(s), text);
    assert.deepEqual(snapshot(s.home), before);
  });
}

test("a comment-only menu file: --apply keeps the comments, and a row the user adds in our object survives --remove", (t) => {
  const s = sandbox(t);
  const notes = "// My menu customization notes\n// Keep the work shortcuts here.\n";
  mkdirSync(join(MENU(s), ".."), { recursive: true });
  writeFileSync(MENU(s), notes);
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.ok(readFileSync(MENU(s), "utf8").startsWith(`${notes}{\n${menu.START}`));
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before, "nothing else was added: the file is as it was");

  assert.equal(s.run(["setup", "--apply"]).status, 0);
  writeFileSync(MENU(s), readFileSync(MENU(s), "utf8").replace(`{\n${menu.START}`, `{\n  "mine": {"label":"Mine","action":"true"},\n${menu.START}`));
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(readFileSync(MENU(s), "utf8"), `${notes}{\n  "mine": {"label":"Mine","action":"true"},\n}\n`);
});

test("a user edit inside the block: --check reports it, --apply and --remove leave the file alone (E_MODIFIED)", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const edited = readFileSync(MENU(s), "utf8").replace('"label":"Status"', '"label":"OATS status"');
  writeFileSync(MENU(s), edited);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, [`the oats block in ${MENU(s)} changed since setup wrote it`]);
  const apply = s.run(["setup", "--apply", "--json"]);
  assert.equal(apply.json.error.code, "E_MODIFIED");
  const remove = s.run(["setup", "--remove", "--json"]);
  assert.equal(remove.json.error.code, "E_MODIFIED");
  assert.match(remove.json.error.message, /omarchy-menu\.jsonc/);
  assert.equal(readFileSync(MENU(s), "utf8"), edited);
});

test("the Desktop found later: --apply replaces the block in place, and --remove still restores the user's file", (t) => {
  const s = sandbox(t);
  const text = '{\n  "mine": {"label":"Mine"}\n}\n';
  mkdirSync(join(MENU(s), ".."), { recursive: true });
  writeFileSync(MENU(s), text);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.ok(!readFileSync(MENU(s), "utf8").includes("oats.desktop"));
  writeExecutable(join(s.home, "Applications/OATS-Desktop.AppImage"), "#!/bin/sh\n");
  const again = s.run(["setup", "--apply", "--ui", "tui", "--json"]);
  assert.equal(part(again, "menu").status, "applied");
  const items = menu.omarchyParse(readFileSync(MENU(s), "utf8")).items;
  assert.match(items["oats.desktop"].action, /^omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- .*OATS-Desktop\.AppImage --dir /);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(readFileSync(MENU(s), "utf8"), text);
});

test("the menu part is skipped, file untouched, when Omarchy cannot read the file, an id is taken, or the menu is not there", (t) => {
  for (const [text, reason] of [
    ['{\n  "mine": 1, // inline\n}\n', /Omarchy cannot read .* as it is .*so setup leaves it alone/],
    ['{\n  "oats": {"label":"My own"}\n}\n', /has its own oats, which the oats block would override/],
    [`{\n${menu.START}}\n`, /already holds an oats-omarchy block that setup has no record of/],
  ]) {
    const s = sandbox(t);
    mkdirSync(join(MENU(s), ".."), { recursive: true });
    writeFileSync(MENU(s), text);
    const r = s.run(["setup", "--apply", "--json"]);
    assert.equal(r.status, 0);
    assert.equal(part(r, "menu").status, "skipped");
    assert.match(part(r, "menu").reason, reason);
    assert.equal(readFileSync(MENU(s), "utf8"), text);
  }
  const none = sandbox(t, { menu: false });
  assert.match(part(none.run(["setup", "--plan", "--json"]), "menu").reason, /Omarchy's menu definition .*omarchy-menu\.jsonc is not there/);
  const noSelect = sandbox(t, { launchers: ["omarchy-launch-or-focus-tui", "omarchy-launch-or-focus", "uwsm-app", "omarchy-hook", "omarchy-launch-floating-terminal-with-presentation"] });
  assert.match(part(noSelect.run(["setup", "--plan", "--json"]), "menu").reason, /not on .*: omarchy-menu-select/);
});

test("a symlinked menu file: the block goes into its target, and the link stays a link", (t) => {
  const s = sandbox(t);
  const target = join(s.home, "dotfiles/omarchy-menu.jsonc");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, '{\n  "mine": 1,\n}\n');
  mkdirSync(join(MENU(s), ".."), { recursive: true });
  symlinkSync(target, MENU(s));
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(readlinkSync(MENU(s)), target);
  assert.ok(readFileSync(target, "utf8").includes(menu.START));
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("Waiting on you with the shell running: the waiting popup opens, and no selector runs", (t) => {
  const s = sandbox(t, { shell: "ok" });
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const items = menu.omarchyParse(readFileSync(MENU(s), "utf8")).items;
  const r = spawnSync("bash", ["-c", items["oats.waiting"].action], { cwd: s.home, env: s.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(s.root, "shell.log"), "utf8"), "shell summon ai.aweb.oats {}\n");
  assert.equal(existsSync(join(s.root, "select.log")), false, "no selector");
});

test("Waiting on you when the popup cannot open (the plugin disabled): the selector, as before", (t) => {
  const s = sandbox(t, { shell: "unknown" });
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ agents: [{ instances: [{ instance: "alpha", home: "/h/a", waitingOnYou: { reason: "attention" } }] }] }));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const items = menu.omarchyParse(readFileSync(MENU(s), "utf8")).items;
  assert.equal(spawnSync("bash", ["-c", items["oats.waiting"].action], { cwd: s.home, env: s.env, encoding: "utf8", timeout: 30_000 }).status, 0);
  assert.equal(readFileSync(join(s.root, "shell.log"), "utf8"), "shell summon ai.aweb.oats {}\n");
  assert.equal(readFileSync(join(s.root, "select.log"), "utf8"), "Waiting on you (1)\nalpha\n--\n");
});

test("the menu's actions run: waiting reaches the selector through the shim and the kernel when no shell runs; status runs the kernel's own status", (t) => {
  const s = sandbox(t, { deploymentName: "my agents" });
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ agents: [{ instances: [{ instance: "alpha", home: "/h/a", waitingOnYou: { reason: "attention" } }] }] }));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const items = menu.omarchyParse(readFileSync(MENU(s), "utf8")).items;
  // Omarchy runs an action with bash -lc, from wherever the shell is.
  const waitingRun = spawnSync("bash", ["-c", items["oats.waiting"].action], { cwd: s.home, env: s.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(waitingRun.status, 0, waitingRun.stderr);
  assert.equal(readFileSync(join(s.root, "select.log"), "utf8"), "Waiting on you (1)\nalpha\n--\n");
  const statusRun = spawnSync("bash", ["-c", items["oats.status"].action], { cwd: s.home, env: { ...s.env, FAKE_FLOATING_RUN: "1" }, encoding: "utf8", timeout: 30_000 });
  assert.equal(statusRun.status, 0, statusRun.stderr);
  assert.deepEqual(readFileSync(join(s.root, "kernel.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)), [["status"]]);
  rmSync(join(s.root, "kernel.log"));
  assert.equal(existsSync(join(s.root, "kernel.log")), false);
});
