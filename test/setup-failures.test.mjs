// Setup when things go wrong: hostile paths, failing and short writes, and
// what is already on disk where setup keeps its own files. Failures are
// injected by replacing node:fs functions for one call of setup().
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setup } from "../lib/setup.mjs";
import { sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

const HOOK = (s) => join(s.home, ".config/omarchy/hooks/post-update.d/oats-omarchy.hook");

// setup() in this process, so a replaced fs function applies to it.
function direct(s, args) {
  let stdout = "";
  const status = setup([...args, "--dir", s.deployment, "--yes", "--json"], s.env, { write: (x) => { stdout += x; } }, { write() {} });
  return { status, json: JSON.parse(stdout) };
}

function withFs(name, replacement, fn) {
  const original = fs[name];
  fs[name] = replacement(original);
  syncBuiltinESMExports();
  try { return fn(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}

for (const name of ["dep$(printf injected>PWNED)", 'dep "quoted" `x`']) {
  test(`the hook treats the deployment path as data, also when the deployment is gone: ${name}`, (t) => {
    const s = sandbox(t, { deploymentName: name });
    assert.equal(s.run(["setup", "--apply"]).status, 0);
    const syntax = spawnSync("bash", ["-n", HOOK(s)], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    fs.rmSync(s.deployment, { recursive: true });
    const r = spawnSync("bash", [HOOK(s)], { cwd: s.home, env: s.env, encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(join(s.home, "PWNED")), false, "a command substitution in the deployment path ran");
    assert.equal(r.stdout, `oats-omarchy: the OATS deployment ${s.deployment} is gone, so its Omarchy setup cannot be checked\n`);
  });
}

test("--remove leaves what it did not write in its state directory, and a directory that was there", (t) => {
  const s = sandbox(t);
  const backup = join(s.home, ".local/state/oats-omarchy/backup");
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(join(backup, "user-data"), "must survive");
  fs.writeFileSync(join(backup, "tui-entry"), "not a backup of ours");
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(fs.readFileSync(join(backup, "tui-entry"), "utf8"), "not a backup of ours", "a backup never overwrites a file it finds");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("a failed write over a user's symlink leaves the symlink as it was", (t) => {
  const s = sandbox(t);
  const target = join(s.home, "original-hook");
  fs.writeFileSync(target, "echo original\n");
  fs.mkdirSync(join(HOOK(s), ".."), { recursive: true });
  fs.symlinkSync(target, HOOK(s));
  const before = snapshot(s.home);
  const r = withFs("renameSync", (rename) => (from, to) => {
    if (to === HOOK(s)) throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    return rename(from, to);
  }, () => direct(s, ["--apply"]));
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "E_APPLY_FAILED");
  assert.equal(fs.readlinkSync(HOOK(s)), target);
  assert.deepEqual(snapshot(s.home), before);
});

test("a failing write leaves no temporary file and no new directory", (t) => {
  const s = sandbox(t);
  const before = snapshot(s.home);
  const r = withFs("writeSync", () => () => { throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" }); }, () => direct(s, ["--apply"]));
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "E_APPLY_FAILED");
  assert.deepEqual(snapshot(s.home), before);
});

test("short writes still write every byte: --remove restores the whole original", (t) => {
  const s = sandbox(t);
  const file = join(s.home, ".local/share/applications/org.oats.tui.desktop");
  fs.mkdirSync(join(file, ".."), { recursive: true });
  const original = "[Desktop Entry]\nName=Original\nExec=true\n";
  fs.writeFileSync(file, original);
  let short = 0;
  const r = withFs("writeSync", (write) => (fd, bytes, offset = 0, length = bytes.length - offset) => {
    short++;
    return write(fd, bytes, offset, Math.min(length, 7));
  }, () => direct(s, ["--apply"]));
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.ok(short > 10, "the writes were short");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("--check reports what a found Desktop entry runs when it is gone: its program, or its AppImage like any other", (t) => {
  for (const [program, drift] of [
    ["bin/oats-desktop-launcher", (path, entry) => `the Desktop program ${path}, which the launcher entry ${entry} runs, is gone`],
    ["Applications/OATS-Desktop.AppImage", (path) => `the Desktop AppImage ${path} is gone`],
  ]) {
    const s = sandbox(t);
    const path = join(s.home, program);
    writeExecutable(path, "#!/bin/sh\nexit 0\n");
    const entry = join(s.home, ".local/share/applications/existing.desktop");
    fs.mkdirSync(join(entry, ".."), { recursive: true });
    fs.writeFileSync(entry, `[Desktop Entry]\nType=Application\nName=OATS Desktop\nStartupWMClass=awebai-oats-desktop\nExec=env FOO=1 ${path}\n`);
    assert.equal(s.run(["setup", "--apply", "--ui", "tui"]).status, 0);
    assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
    fs.unlinkSync(path);
    const r = s.run(["setup", "--check", "--json"]);
    assert.equal(r.status, 0);
    assert.deepEqual(r.json.result.drift, [drift(path, entry)]);
  }
});

test("a partial --remove keeps every backup until everything is restored, then deletes only those", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(join(HOOK(s), ".."), { recursive: true });
  fs.writeFileSync(HOOK(s), "echo the user's own hook\n");
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const stateDir = join(s.home, ".local/state/oats-omarchy");
  const hookBackup = JSON.parse(fs.readFileSync(join(stateDir, "state.json"), "utf8")).files.find((f) => f.role === "hook").prior.backup;
  const tuiEntry = join(s.home, ".local/share/applications/org.oats.tui.desktop");
  fs.appendFileSync(tuiEntry, "# the user's edit\n");

  const partial = s.run(["setup", "--remove", "--json"]);
  assert.equal(partial.status, 1);
  assert.equal(partial.json.error.code, "E_MODIFIED");
  assert.equal(fs.readFileSync(HOOK(s), "utf8"), "echo the user's own hook\n", "the hook was restored");
  assert.ok(fs.existsSync(join(stateDir, hookBackup)), "its backup stays until everything is restored");
  assert.deepEqual(JSON.parse(fs.readFileSync(join(stateDir, "state.json"), "utf8")).backups, [hookBackup]);

  fs.unlinkSync(tuiEntry);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("--apply after a partial --remove keeps the kept backups for the final --remove", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(join(HOOK(s), ".."), { recursive: true });
  fs.writeFileSync(HOOK(s), "echo the user's own hook\n");
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const stateFile = join(s.home, ".local/state/oats-omarchy/state.json");
  const tuiEntry = join(s.home, ".local/share/applications/org.oats.tui.desktop");
  const written = fs.readFileSync(tuiEntry);
  fs.appendFileSync(tuiEntry, "# the user's edit\n");
  assert.equal(s.run(["setup", "--remove"]).status, 1);
  const kept = JSON.parse(fs.readFileSync(stateFile, "utf8")).backups;
  assert.equal(kept.length, 1);

  fs.writeFileSync(tuiEntry, written);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).backups, kept, "the kept backup is still owned");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});
