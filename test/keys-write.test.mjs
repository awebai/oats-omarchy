// Setup writes the SUPER + O block into the user's bindings.lua: only over
// Omarchy's stock binding, only after Hyprland verifies a copy of the config
// with the block, and --remove takes out the block alone (or restores the
// file, when it is exactly as --apply wrote it). Hyprland is the sandbox's
// fake; test/omarchy-container.test.mjs runs the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as bindings from "../lib/bindings.mjs";
import { paths as discoverPaths } from "../lib/discover.mjs";
import { setup } from "../lib/setup.mjs";
import { verifyBindings } from "../lib/verify.mjs";
import { fixture, sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

const USER_BINDINGS = '-- My bindings\no.bind("SUPER + RETURN", "Terminal", "uwsm-app -- xdg-terminal-exec")\n';
const NOTE_PREFIX = "SUPER+O becomes a prefix; pop-out moves to SUPER+O, O.";
const NOTE_REMOVE = "--remove deletes only the marked block; it restores the backup only if the file is byte-identical to what apply wrote.";

// The user's Lua layout: a hyprland.lua and their bindings.lua.
function hypr(s, text = USER_BINDINGS, mode = 0o640) {
  const dir = join(s.home, ".config", "hypr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hyprland.lua"), 'require("hypr.bindings")\n');
  const file = join(dir, "bindings.lua");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

const part = (r, name) => r.json.result.parts.find((x) => x.part === name);
const hyprCalls = (s) => {
  try { return readFileSync(join(s.root, "hyprland.log"), "utf8").split("--\n").filter(Boolean).map((c) => Object.fromEntries(c.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))); } catch { return []; }
};
const record = (s) => JSON.parse(readFileSync(join(s.home, ".local/state/oats-omarchy/state.json"), "utf8")).files.find((f) => f.role === "keys");

test("--plan says what the key part does, verifies a copy, and writes nothing", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const before = snapshot(s.home);
  const r = s.run(["setup", "--plan", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(part(r, "keys").status, "will apply");
  assert.deepEqual(part(r, "keys").paths, [file]);
  assert.ok(r.json.result.notes.includes(NOTE_PREFIX));
  assert.ok(r.json.result.notes.includes(NOTE_REMOVE));
  assert.deepEqual(snapshot(s.home), before);
  const text = s.run(["setup", "--plan"]).stdout;
  assert.match(text, /Setup writes this block at the end of .*bindings\.lua, between the oats-omarchy markers/);
  assert.match(text, /SUPER\+O becomes a prefix; pop-out moves to SUPER\+O, O\./);
});

test("--apply appends the block after a blank line, verified first on a temporary home, once", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "keys").status, "applied");
  const rec = record(s);
  assert.equal(readFileSync(file, "utf8"), `${USER_BINDINGS}\n${rec.block}`);
  assert.equal(statSync(file).mode & 0o777, 0o640, "the file keeps its mode");
  assert.ok(rec.block.startsWith(bindings.START) && rec.block.endsWith(bindings.END));
  for (const line of ['hl.unbind("SUPER + O")', 'o.bind("SUPER + O", "OATS", hl.dsp.submap("oats"))', 'hl.define_submap("oats", "reset", function()', 'o.bind("O", "Pop window out", "omarchy-hyprland-window-pop")', 'o.bind("SUPER + T", "OATS TUI",']) {
    assert.ok(rec.block.includes(line), line);
  }
  assert.deepEqual([rec.separator, rec.prior.state, rec.prior.mode], ["\n", "file", 0o640]);
  assert.equal(readFileSync(join(s.home, ".local/state/oats-omarchy", rec.prior.backup), "utf8"), USER_BINDINGS);

  // Hyprland checked the unchanged copy, then the candidate, never in the
  // real home.
  const calls = hyprCalls(s);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.ok(!c.HOME.startsWith(s.home) && c.config === join(c.HOME, ".config/hypr/hyprland.lua"), c.HOME);
    assert.deepEqual([c.XDG_CONFIG_HOME, c.XDG_STATE_HOME], [join(c.HOME, ".config"), join(c.HOME, ".local/state")]);
    assert.deepEqual([c.WAYLAND_DISPLAY, c.HYPRLAND_INSTANCE_SIGNATURE], ["unset", "unset"]);
    assert.equal(existsSync(c.HOME), false, "the temporary home is gone");
  }
  assert.equal(readFileSync(join(s.root, "hyprland-saw.lua"), "utf8"), readFileSync(file, "utf8"), "the last check saw exactly what was written");

  const again = s.run(["setup", "--apply", "--json"]);
  assert.equal(part(again, "keys").status, "already applied");
  assert.equal(hyprCalls(s).length, 2, "a current block is not verified again");
});

test("--remove restores the file byte for byte, mode included, when it is as --apply wrote it", (t) => {
  const s = sandbox(t);
  const file = hypr(s, "-- no final newline", 0o600);
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(record(s).separator, "\n\n");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(readFileSync(file, "utf8"), "-- no final newline");
  assert.deepEqual(snapshot(s.home), before);
});

test("--remove after the user changed the file elsewhere takes out the block alone; the rest stays byte for byte", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const rec = record(s);
  const edited = `-- top\n${readFileSync(file, "utf8")}o.bind("SUPER + P", "Mine", "true")\n`;
  writeFileSync(file, edited);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(readFileSync(file, "utf8"), edited.replace(rec.block, ""));
  assert.equal(readFileSync(file, "utf8"), `-- top\n${USER_BINDINGS}\no.bind("SUPER + P", "Mine", "true")\n`, "the separator stays");
});

test("an edited block: --check says so, --apply and --remove leave the file alone (E_MODIFIED); a missing block or file is reported", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const edited = readFileSync(file, "utf8").replace('"OATS"', '"Mine"');
  writeFileSync(file, edited);
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`the oats key block in ${file} changed since setup wrote it`));
  assert.equal(s.run(["setup", "--apply", "--json"]).json.error.code, "E_MODIFIED");
  const removed = s.run(["setup", "--remove", "--json"]);
  assert.equal(removed.json.error.code, "E_MODIFIED");
  assert.equal(readFileSync(file, "utf8"), edited);

  writeFileSync(file, USER_BINDINGS);
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`the oats key block is missing from ${file}`));
  unlinkSync(file);
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`${file}, which holds the oats key block, is missing`));
});

// A Desktop AppImage to pass with --desktop: the block's D binding changes,
// so a re-apply rewrites the block.
function appImage(s) {
  const path = join(s.root, "OATS-Desktop.AppImage");
  writeExecutable(path, "#!/bin/sh\nexit 0\n");
  return path;
}

test("a re-apply that rewrites the block keeps the user's edits, and --remove then takes out the block alone", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  writeFileSync(file, `${readFileSync(file, "utf8")}-- user edit\n`);
  const again = s.run(["setup", "--apply", "--desktop", appImage(s), "--json"]);
  assert.equal(part(again, "keys").status, "applied", again.stdout);
  const rec = record(s);
  assert.equal(rec.restorable, false);
  const updated = readFileSync(file, "utf8");
  assert.ok(updated.includes("-- user edit\n") && updated.includes(rec.block));
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(readFileSync(file, "utf8"), updated.replace(rec.block, ""));
  assert.equal(readFileSync(file, "utf8"), `${USER_BINDINGS}\n-- user edit\n`);

  // Without the user's edit the rewritten file is still restorable whole.
  const clean = sandbox(t);
  const cleanFile = hypr(clean, USER_BINDINGS, 0o600);
  assert.equal(clean.run(["setup", "--apply"]).status, 0);
  assert.equal(part(clean.run(["setup", "--apply", "--desktop", appImage(clean), "--json"]), "keys").status, "applied");
  assert.equal(record(clean).restorable, true);
  assert.equal(clean.run(["setup", "--remove"]).status, 0);
  assert.equal(readFileSync(cleanFile, "utf8"), USER_BINDINGS);
  assert.equal(statSync(cleanFile).mode & 0o777, 0o600);
});

const updateRefusals = [
  ["a user SUPER + O added outside the block", (s, file) => {
    writeFileSync(file, `o.bind("SUPER + O", "Mine", "true")\n${readFileSync(file, "utf8")}`);
    writeFileSync(join(s.root, "print.txt"), readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8").replace("→ Pop window out (float & pin)", "→ OATS"));
  }, /your bindings\.lua binds SUPER \+ O itself \(o\.bind\("SUPER \+ O"/],
  ["another effective SUPER + O action beside the block's", (s) => {
    writeFileSync(join(s.root, "print.txt"), `${readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8").replace("→ Pop window out (float & pin)", "→ OATS")}SUPER + O                           → Mine\n`);
  }, /SUPER \+ O runs "Mine", not Omarchy's stock/],
  ["a user submap named oats added since", (s) => writeFileSync(join(s.home, ".config/hypr/extra.lua"), 'hl.define_submap("oats", function() end)\n'), /defines a submap named oats \(in .*extra\.lua\)/],
];

for (const [name, arrange, reason] of updateRefusals) {
  test(`a re-apply that would rewrite the block is skipped and writes nothing: ${name}`, (t) => {
    const s = sandbox(t);
    const file = hypr(s);
    assert.equal(s.run(["setup", "--apply"]).status, 0);
    arrange(s, file);
    const before = readFileSync(file, "utf8");
    const again = s.run(["setup", "--apply", "--desktop", appImage(s), "--json"]);
    assert.equal(again.status, 0, again.stdout);
    assert.equal(part(again, "keys").status, "skipped");
    assert.match(part(again, "keys").reason, reason);
    assert.equal(readFileSync(file, "utf8"), before);
  });
}

test("a save while Hyprland verifies the block: --apply writes nothing and rolls back", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  s.env.FAKE_HYPR_SAVE_TO = file;
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.json.error.code, "E_APPLY_FAILED");
  assert.match(r.json.error.message, /bindings\.lua changed while setup checked it, so setup leaves it alone: run setup --apply again/);
  assert.equal(readFileSync(file, "utf8"), `${USER_BINDINGS}-- concurrent save\n`);
  assert.equal(existsSync(join(s.home, ".local/state/oats-omarchy/state.json")), false);
});

test("--remove keeps bytes outside the block that are not UTF-8, and --check still finds the block", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const latin1 = Buffer.from("-- caf\xe9\n", "latin1");
  writeFileSync(file, Buffer.concat([readFileSync(file), latin1]));
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift.filter((d) => d.includes("bindings.lua")), []);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(readFileSync(file), Buffer.concat([Buffer.from(`${USER_BINDINGS}\n`), latin1]));
});

const refusals = [
  ["SUPER + O rebound in the effective bindings", (s) => {
    const print = readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8").replace("→ Pop window out (float & pin)", "→ My own thing");
    writeFileSync(join(s.root, "print.txt"), print);
  }, /SUPER \+ O runs "My own thing", not Omarchy's stock "Pop window out \(float & pin\)" \(omarchy-hyprland-window-pop\)/],
  ["SUPER + O bound to another action beside the stock one", (s) => {
    writeFileSync(join(s.root, "print.txt"), `${readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8")}SUPER + O                           → Mine\n`);
  }, /SUPER \+ O runs "Mine" as well as Omarchy's stock "Pop window out \(float & pin\)"/],
  ["SUPER + O bound in the user's bindings.lua", (s) => hypr(s, `${USER_BINDINGS}o.bind("super+o", "Mine", "true")\n`), /your bindings\.lua binds SUPER \+ O itself \(o\.bind\("super\+o"/],
  ["a user submap named oats", (s) => writeFileSync(join(s.home, ".config/hypr/extra.lua"), 'hl.define_submap("oats", function() end)\n'), /defines a submap named oats \(in .*extra\.lua\)/],
  ["no key check", (s) => writeFileSync(join(s.root, "print.txt"), ""), /setup could not read what SUPER \+ O does now/],
  ["the .conf layout", (s) => { unlinkSync(join(s.home, ".config/hypr/bindings.lua")); writeFileSync(join(s.home, ".config/hypr/bindings.conf"), "# mine\n"); }, /the hyprlang layout\), and setup writes the key only into bindings\.lua/],
  ["no Hyprland on PATH", (s) => unlinkSync(join(s.fakebin, "Hyprland")), /Hyprland is not on PATH, so setup cannot verify the key block/],
  ["a current config that does not verify", (s) => hypr(s, `${USER_BINDINGS}-- BREAKS_VERIFY\n`), /your current Hyprland config does not verify, so setup does not add the key block:\n======== Config parsing result:\nconfig error in/],
  ["a block that does not verify", (s) => { s.env.FAKE_HYPR_REFUSE_BLOCK = "1"; }, /Hyprland --verify-config refuses your config with the key block added, so setup writes nothing:\n======== Config parsing result:\nconfig error in .*bindings\.lua:3/],
];

for (const [name, arrange, reason] of refusals) {
  test(`the key part is skipped, the snippet still printed and nothing written: ${name}`, (t) => {
    const s = sandbox(t);
    hypr(s);
    arrange(s);
    const before = snapshot(join(s.home, ".config"));
    const plan = s.run(["setup", "--plan", "--json"]);
    assert.equal(part(plan, "keys").status, "skipped");
    assert.match(part(plan, "keys").reason, reason);
    assert.ok(plan.json.result.keys.snippet, "the snippet is printed for the person");
    assert.ok(!plan.json.result.notes.includes(NOTE_PREFIX));
    assert.equal(s.run(["setup", "--apply"]).status, 0);
    const after = snapshot(join(s.home, ".config"));
    for (const [path, entry] of before) if (path.startsWith("hypr")) assert.equal(after.get(path), entry, path);
  });
}

test("the verify copy: the config tree and the state Lua it loads, in a private home, bounded in size", (t) => {
  const s = sandbox(t);
  hypr(s);
  const p = discoverPaths(s.env);
  const state = join(s.home, ".local/state/omarchy");
  for (const [rel, text] of [["current/theme/hyprland.lua", "-- theme\n"], ["current/theme/background.png", "not lua"], ["toggles/hypr/flags.lua", "-- flags\n"], ["toggles/hypr/touchpad-disabled-name", "ELAN\n"], ["workspace-layouts/1.lua", "-- layout\n"]]) {
    mkdirSync(join(state, rel, ".."), { recursive: true });
    writeFileSync(join(state, rel), text);
  }
  // A Hyprland that keeps what it saw.
  const seen = join(s.root, "seen");
  const hyprland = join(s.root, "Hyprland-copying");
  writeExecutable(hyprland, `#!${process.execPath}
const { cpSync, statSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
cpSync(process.env.HOME, ${JSON.stringify(seen)}, { recursive: true });
writeFileSync(${JSON.stringify(join(s.root, "seen-mode"))}, (statSync(dirname(process.env.HOME)).mode & 0o777).toString(8));
console.log("config ok");
`);
  const ok = verifyBindings({ hyprland, p, env: s.env, candidate: "-- candidate\n" });
  assert.deepEqual(ok, { ok: true });
  assert.equal(readFileSync(join(seen, ".config/hypr/bindings.lua"), "utf8"), "-- candidate\n");
  assert.equal(readFileSync(join(seen, ".config/hypr/hyprland.lua"), "utf8"), 'require("hypr.bindings")\n');
  for (const rel of ["current/theme/hyprland.lua", "toggles/hypr/flags.lua", "toggles/hypr/touchpad-disabled-name", "workspace-layouts/1.lua"]) {
    assert.ok(existsSync(join(seen, ".local/state/omarchy", rel)), rel);
  }
  assert.equal(existsSync(join(seen, ".local/state/omarchy/current/theme/background.png")), false, "only the theme's Lua");
  assert.equal(readFileSync(join(s.root, "seen-mode"), "utf8"), "700");

  const big = verifyBindings({ hyprland, p, env: s.env, candidate: "x", limit: 10 });
  assert.equal(big.ok, false);
  assert.equal(big.stage, "copy");
  assert.match(big.reason, /are over 0 MB .*so setup does not copy them to verify the key block/);
});

test("--apply and --remove ask in a terminal and refuse without one unless --yes", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const before = snapshot(s.home);
  for (const args of [["setup", "--apply"], ["setup", "--apply", "--json"]]) {
    const r = s.run(args, {}, { yes: false });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr + r.stdout, /E_CONFIRM|refusing to --apply without confirmation: run it in a terminal, or pass --yes/);
  }
  assert.deepEqual(snapshot(s.home), before, "nothing was written");

  const direct = (args, answer) => {
    let out = "";
    let asked = 0;
    const status = setup([...args, "--dir", s.deployment], s.env, { write: (x) => { out += x; } }, { write: (x) => { out += x; } }, { interactive: true, ask: () => { asked += 1; return answer; } });
    return { status, out, asked };
  };
  const no = direct(["--apply"], "n");
  assert.deepEqual([no.status, no.asked], [1, 1]);
  assert.match(no.out, /^setup --plan \(nothing was written\)/);
  assert.match(no.out, /Apply it\? \[y\/N\] setup: aborted: nothing was changed\n$/);
  assert.deepEqual(snapshot(s.home), before);

  const yes = direct(["--apply"], "y");
  assert.equal(yes.status, 0, yes.out);
  assert.ok(readFileSync(file, "utf8").includes(bindings.START));
  assert.equal(s.run(["setup", "--remove"], {}, { yes: false }).status, 1, "--remove refuses too");
  const removed = direct(["--remove"], "yes");
  assert.equal(removed.status, 0, removed.out);
  assert.match(removed.out, /setup --remove puts back what --apply changed, as it was before:\n/);
  assert.match(removed.out, /bindings\.lua \(setup's block only\)/);
  assert.deepEqual(snapshot(s.home), before);
  assert.equal(direct(["--remove"], "n").asked, 0, "nothing to remove: no question");
});

test("an interactive --apply verifies once, after the answer: a change made while it asked is caught", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  let out = "";
  let callsWhenAsked = null;
  const direct = (sb, ask) => setup(["--apply", "--dir", sb.deployment], sb.env, { write: (x) => { out += x; } }, { write: (x) => { out += x; } }, { interactive: true, ask });
  assert.equal(direct(s, () => { callsWhenAsked = hyprCalls(s).length; return "y"; }), 0);
  assert.equal(callsWhenAsked, 0, "the plan shown before the question runs no Hyprland");
  assert.match(out, /Once you confirm, and before it writes the key block, setup runs Hyprland --verify-config/);
  assert.equal(hyprCalls(s).length, 2, "the current copy and the candidate, checked once, after the answer");
  assert.ok(readFileSync(file, "utf8").includes(bindings.START));

  // Something the config depends on changes while setup waits for the answer:
  // the check after the answer sees it, and the key is not written.
  const s2 = sandbox(t);
  const file2 = hypr(s2);
  assert.equal(direct(s2, () => { s2.env.FAKE_HYPR_REFUSE_BLOCK = "1"; return "y"; }), 0);
  assert.equal(readFileSync(file2, "utf8"), USER_BINDINGS, "the key block was not written");
  assert.ok(existsSync(join(s2.home, ".local/share/applications/org.oats.tui.desktop")), "the rest was applied");
});

test("the plan says the verify runs the config's own commands, on a copy", (t) => {
  const s = sandbox(t);
  hypr(s);
  const r = s.run(["setup", "--plan", "--json"]);
  assert.ok(r.json.result.notes.some((n) => /runs the config's own commands \(its io\.popen calls\), on the copy/.test(n)), r.json.result.notes.join("\n"));
  const none = sandbox(t, { hyprland: false });
  hypr(none);
  assert.ok(!none.run(["setup", "--plan", "--json"]).json.result.notes.some((n) => /io\.popen/.test(n)), "no verify, no note");
});
