// What setup reads back from its own state, and what the plan says about
// files it did not write. state.json sits in the user's state directory:
// --remove trusts none of it beyond the paths setup manages and the backups
// in its own backup directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../oats-package/capabilities/oats-omarchy/lib/state.mjs";
import { sandbox } from "./helpers/sandbox.mjs";

const paths = (s) => ({
  shim: join(s.home, ".local/share/oats-omarchy/oats"),
  tuiEntry: join(s.home, ".local/share/applications/org.oats.tui.desktop"),
  tuiIcon: join(s.home, ".local/share/icons/hicolor/256x256/apps/org.oats.tui.png"),
  hook: join(s.home, ".config/omarchy/hooks/post-update.d/oats-omarchy.hook"),
  stateDir: join(s.home, ".local/state/oats-omarchy"),
  state: join(s.home, ".local/state/oats-omarchy/state.json"),
  menu: join(s.home, ".config/omarchy/extensions/omarchy-menu.jsonc"),
});

const MY_ENTRY = "[Desktop Entry]\nName=My own OATS entry\nExec=true\n";
const MY_HOOK = "echo the user's own hook\n";

function write(path, text) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); }

// Applied over the user's own TUI entry and hook, so both are backed up.
function applied(t) {
  const s = sandbox(t);
  const p = paths(s);
  write(p.tuiEntry, MY_ENTRY);
  write(p.hook, MY_HOOK);
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { s, p };
}

const readState = (p) => JSON.parse(readFileSync(p.state, "utf8"));
function tamper(p, edit) {
  const state = readState(p);
  edit(state);
  writeFileSync(p.state, `${JSON.stringify(state, null, 2)}\n`);
}

test("a recorded backup outside setup's backup directory is refused by name; the rest is restored", (t) => {
  const { s, p } = applied(t);
  const decoy = join(s.root, "decoy");
  writeFileSync(decoy, "not a backup\n");
  const hookWritten = readFileSync(p.hook, "utf8");
  for (const backup of [decoy, "backup/../../../../../decoy", "../backup-elsewhere/hook"]) {
    tamper(p, (state) => { state.files.find((f) => f.role === "hook").prior.backup = backup; });
    const r = s.run(["setup", "--remove", "--json"]);
    assert.equal(r.status, 1, backup);
    assert.equal(r.json.error.code, "E_STATE_REFUSED", backup);
    assert.match(r.json.error.message, new RegExp(`${p.hook.replace(/[.]/g, "\\.")}: its backup .* is not in ${p.stateDir.replace(/[.]/g, "\\.")}/backup`));
    assert.equal(readFileSync(p.hook, "utf8"), hookWritten, "the refused entry is left as setup wrote it");
    assert.equal(readFileSync(decoy, "utf8"), "not a backup\n");
  }
  // Everything else was restored on the first run; the shim stays while
  // an entry is left, and the state keeps exactly those entries.
  assert.equal(readFileSync(p.tuiEntry, "utf8"), MY_ENTRY);
  assert.equal(existsSync(p.menu), false);
  assert.deepEqual(readState(p).files.map((f) => f.role).sort(), ["hook", "shim"]);
  assert.ok(existsSync(p.shim));
});

test("a recorded backup that is a link is refused", (t) => {
  const { s, p } = applied(t);
  const outside = join(s.root, "outside");
  writeFileSync(outside, "outside\n");
  const backup = readState(p).files.find((f) => f.role === "hook").prior.backup;
  const file = join(p.stateDir, backup);
  // Replaced by a link with the same name: in the directory, but not ours.
  unlinkSync(file);
  symlinkSync(outside, file);
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.json.error.code, "E_STATE_REFUSED");
  assert.match(r.json.error.message, /is not a regular file/);
  assert.notEqual(readFileSync(p.hook, "utf8"), "outside\n");
});

test("a backup recorded by its absolute path is refused, and the next entry is still restored", (t) => {
  const { s, p } = applied(t);
  const hookWritten = readFileSync(p.hook, "utf8");
  tamper(p, (state) => { const prior = state.files.find((f) => f.role === "hook").prior; prior.backup = join(p.stateDir, prior.backup); });
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "E_STATE_REFUSED");
  assert.match(r.json.error.message, /its backup ".*" is not in /);
  assert.equal(readFileSync(p.hook, "utf8"), hookWritten);
  assert.equal(readFileSync(p.tuiEntry, "utf8"), MY_ENTRY, "the entry after it is restored");
});

test("a backup directory that is a link out of the state directory is never read or deleted through", (t) => {
  const { s, p } = applied(t);
  const hookWritten = readFileSync(p.hook, "utf8");
  const backupDir = join(p.stateDir, "backup");
  const elsewhere = join(s.root, "elsewhere");
  const backup = readState(p).files.find((f) => f.role === "hook").prior.backup;
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, backup.slice("backup/".length)), "not a backup of setup's\n");
  renameSync(backupDir, join(s.root, "real-backup"));
  symlinkSync(elsewhere, backupDir);
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "E_STATE_REFUSED");
  assert.match(r.json.error.message, /setup's backup directory .* is missing or is not a directory/);
  assert.equal(readFileSync(p.hook, "utf8"), hookWritten, "nothing is restored from it");
  assert.equal(readFileSync(join(elsewhere, backup.slice("backup/".length)), "utf8"), "not a backup of setup's\n", "nothing is deleted through it");
});

test("a recorded path setup does not manage is refused by name and left alone, even when its digest matches", (t) => {
  const { s, p } = applied(t);
  const victim = join(s.root, "victim.txt");
  writeFileSync(victim, "the user's data\n");
  tamper(p, (state) => {
    const hook = state.files.find((f) => f.role === "hook");
    Object.assign(hook, { path: victim, digest: digest(readFileSync(victim)), prior: { state: "absent" } });
  });
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "E_STATE_REFUSED");
  assert.match(r.json.error.message, new RegExp(`${victim.replace(/[.]/g, "\\.")}: not a path setup manages as hook`));
  assert.ok(r.json.error.details.left.some((l) => l.path === victim));
  assert.equal(readFileSync(victim, "utf8"), "the user's data\n");
  assert.equal(readFileSync(p.tuiEntry, "utf8"), MY_ENTRY, "the rest is restored");
});

test("a managed path recorded under another role is refused", (t) => {
  const { s, p } = applied(t);
  tamper(p, (state) => { state.files.find((f) => f.role === "hook").path = p.tuiEntry; });
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.json.error.code, "E_STATE_REFUSED");
  assert.match(r.json.error.message, /not a path setup manages as hook/);
});

test("a kept backup outside the backup directory is never deleted", (t) => {
  const { s, p } = applied(t);
  const victim = join(s.root, "victim.txt");
  writeFileSync(victim, "the user's data\n");
  tamper(p, (state) => { state.backups = [victim]; });
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "E_STATE_REFUSED");
  assert.ok(r.json.error.message.includes(`the backup ${JSON.stringify(victim)}: not in ${p.stateDir}/backup`));
  assert.equal(readFileSync(victim, "utf8"), "the user's data\n");
  assert.equal(readFileSync(p.hook, "utf8"), MY_HOOK, "every file is restored");
  assert.equal(readFileSync(p.tuiEntry, "utf8"), MY_ENTRY);
  assert.deepEqual(readState(p).files.map((f) => f.role), ["shim"], "the shim stays with the state");
});

test("the plan says when --apply replaces a file or a link setup did not write; once applied it does not", (t) => {
  const s = sandbox(t);
  const p = paths(s);
  write(p.tuiEntry, MY_ENTRY);
  write(join(s.home, "dotfiles/icon.png"), "an icon of the user's");
  mkdirSync(join(p.tuiIcon, ".."), { recursive: true });
  symlinkSync(join(s.home, "dotfiles/icon.png"), p.tuiIcon);

  const plan = s.run(["setup", "--plan", "--json"]);
  const tui = plan.json.result.parts.find((x) => x.part === "tui");
  assert.deepEqual(tui.replaces, [{ path: p.tuiEntry, existing: "file" }, { path: p.tuiIcon, existing: "link" }]);
  assert.ok(plan.json.result.parts.filter((x) => x.part !== "tui").every((x) => !x.replaces));
  const text = s.run(["setup", "--plan"]).stdout;
  assert.ok(text.includes(`${p.tuiEntry} (replaces an existing file, backed up; --remove restores it)`), text);
  assert.ok(text.includes(`${p.tuiIcon} (replaces an existing link; --remove restores it)`), text);

  const apply = s.run(["setup", "--apply", "--json"]);
  assert.deepEqual(apply.json.result.parts.find((x) => x.part === "tui").replaces, tui.replaces, "--apply reports what it replaced");
  const again = s.run(["setup", "--plan", "--json"]);
  assert.ok(again.json.result.parts.every((x) => !x.replaces));
  assert.ok(!s.run(["setup", "--plan"]).stdout.includes("replaces an existing"));
});
