// The installer part: ~/.local/bin/omarchy-install-oats, a two-line sh
// wrapper that runs the plugin's bin/omarchy-install-oats (sh, so no node).
// Setup writes it the same way as the launcher: never over a file or link
// it did not write, and --remove takes it out. The real installer is never
// run here: the wrapper runs only against a stub in a temporary plugin
// directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths as discoverPaths } from "../lib/discover.mjs";
import * as files from "../lib/files.mjs";
import { repo, sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

const part = (r, name) => r.json.result.parts.find((x) => x.part === name);
const stateOf = (s) => JSON.parse(readFileSync(join(discoverPaths(s.env).stateDir, "state.json"), "utf8"));
const installerOf = (s) => discoverPaths(s.env).installer;
const binDir = (s) => join(s.home, ".local", "bin");

test("files.installer: the plugin's bin/omarchy-install-oats, single-quoted, with every argument passed on", (t) => {
  assert.equal(
    files.installer({ pluginDir: "/srv/plug in $x/it's" }),
    `#!/bin/sh\nexec '/srv/plug in $x/it'\\''s/bin/omarchy-install-oats' "$@"\n`,
  );
  assert.equal(files.INSTALLER_NAME, "omarchy-install-oats");

  // The rendered wrapper, run by sh, against a stub that logs its argv.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oats-omarchy-installer-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, "plug in $(touch pwned) 'x'");
  const log = join(root, "argv.log");
  writeExecutable(join(plugin, "bin", "omarchy-install-oats"), `#!/bin/sh\nfor a; do printf '%s\\n' "$a"; done > '${log}'\n`);
  const wrapper = join(root, "omarchy-install-oats");
  writeExecutable(wrapper, files.installer({ pluginDir: plugin }));
  const r = spawnSync("/bin/sh", [wrapper, "--now", "--harness", "a b"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(log, "utf8"), "--now\n--harness\na b\n");
  assert.ok(!existsSync(join(root, "pwned")));
});

test("--apply writes the installer, 0755, recorded; a second --apply leaves it; --remove takes it out", (t) => {
  const s = sandbox(t);
  const w = installerOf(s);
  assert.equal(part(s.run(["setup", "--plan", "--json"]), "installer").status, "will apply");
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(part(r, "installer"), { part: "installer", status: "applied", paths: [w] });
  const state = stateOf(s);
  assert.equal(readFileSync(w, "utf8"), files.installer({ pluginDir: state.pluginDir }));
  assert.equal(state.pluginDir, repo);
  assert.equal(statSync(w).mode & 0o777, 0o755);
  assert.ok(state.parts.includes("installer"));
  assert.deepEqual(state.files.filter((f) => f.role === "installer").map((f) => f.path), [w]);
  assert.equal(part(s.run(["setup", "--apply", "--json"]), "installer").status, "already applied");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);

  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.ok(!existsSync(w));
  assert.ok(!existsSync(binDir(s)), "~/.local/bin, which setup made, goes too");
});

// What can be at the installer's path that setup did not write: each is left
// exactly as it is, and only the installer part is skipped.
for (const [name, what, arrange] of [
  ["a file", "a file", (s, w) => { writeFileSync(w, "#!/bin/sh\necho my own installer\n"); chmodSync(w, 0o700); }],
  ["a link", "a link", (s, w) => { writeExecutable(join(s.root, "elsewhere"), "#!/bin/sh\nexit 0\n"); symlinkSync(join(s.root, "elsewhere"), w); }],
]) test(`${name} at the installer's path: the installer is skipped with why, the rest applies, and it is left as it is`, (t) => {
  const s = sandbox(t);
  const w = installerOf(s);
  mkdirSync(binDir(s), { recursive: true });
  arrange(s, w);
  const mine = () => snapshot(binDir(s), { exclude: [files.LAUNCHER_NAME] });
  const before = mine();
  const reason = `${w} is ${what} setup did not write, and setup never replaces it: move it away, then run setup again`;

  assert.deepEqual(part(s.run(["setup", "--plan", "--json"]), "installer"), { part: "installer", status: "skipped", reason, paths: [] });
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "installer").status, "skipped");
  assert.equal(part(r, "launcher").status, "applied");
  assert.ok(!r.json.result.written.includes(w));
  assert.deepEqual(mine(), before, "bytes, mode and link target untouched");
  assert.ok(!stateOf(s).files.some((f) => f.role === "installer"));
  assert.ok(!s.run(["setup", "--check", "--json"]).json.result.drift.some((line) => line.includes(w)), "not reported as new: the plan says why");

  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(binDir(s)), before, "--remove leaves it too");
});

test("a state from before the installer part: --check says it is new; --apply writes it, and --check is clean", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const w = installerOf(s);
  const statePath = join(discoverPaths(s.env).stateDir, "state.json");
  const state = stateOf(s);
  rmSync(w);
  writeFileSync(statePath, `${JSON.stringify({ ...state, files: state.files.filter((f) => f.role !== "installer"), parts: state.parts.filter((x) => x !== "installer") }, null, 2)}\n`);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, [`the installer ${w} is new in this version of setup and not applied yet: run setup --apply again`]);
  assert.equal(part(s.run(["setup", "--apply", "--json"]), "installer").status, "applied");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

test("an installer the person edited: --check reports it, and --remove leaves it", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const w = installerOf(s);
  writeFileSync(w, "#!/bin/sh\necho edited\n");
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`${w} changed since setup wrote it`));
  s.run(["setup", "--remove"]);
  assert.equal(readFileSync(w, "utf8"), "#!/bin/sh\necho edited\n");
});
