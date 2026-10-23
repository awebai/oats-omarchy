// The launcher part: ~/.local/bin/omarchy-launch-oats, a two-line sh wrapper
// that runs the plugin's bin/launch.mjs with the node setup recorded. Setup
// writes it with the shim, never over a file or link it did not write, and
// --remove takes it out (and ~/.local/bin, when setup made it and it is
// empty). The real bin/launch.mjs is never run here: the wrapper runs only
// against a stub in a temporary plugin directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bindings from "../lib/bindings.mjs";
import { paths as discoverPaths } from "../lib/discover.mjs";
import * as files from "../lib/files.mjs";
import { repo, sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

// The user's Lua layout: a hyprland.lua and their bindings.lua.
function hypr(s) {
  const dir = join(s.home, ".config", "hypr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hyprland.lua"), 'require("hypr.bindings")\n');
  writeFileSync(join(dir, "bindings.lua"), "-- My bindings\n");
  return join(dir, "bindings.lua");
}

const part = (r, name) => r.json.result.parts.find((x) => x.part === name);
const stateOf = (s) => JSON.parse(readFileSync(join(discoverPaths(s.env).stateDir, "state.json"), "utf8"));
const wrapperOf = (s) => discoverPaths(s.env).wrapper;
const binDir = (s) => join(s.home, ".local", "bin");

test("files.launcher: the recorded node runs <plugin>/bin/launch.mjs, both single-quoted, with every argument passed on", (t) => {
  assert.equal(
    files.launcher({ node: "/opt/my node $HOME/bin/node", pluginDir: "/srv/plug in $x/oats-omarchy" }),
    `#!/bin/sh\nexec '/opt/my node $HOME/bin/node' '/srv/plug in $x/oats-omarchy/bin/launch.mjs' "$@"\n`,
  );
  assert.equal(files.LAUNCHER_NAME, "omarchy-launch-oats");

  // The rendered wrapper, run by sh, against a stub launch.mjs that prints
  // its arguments: the node and the plugin directory hold spaces and `$`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oats-omarchy-launcher-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nodeDir = join(root, "my node $HOME");
  mkdirSync(nodeDir);
  symlinkSync(process.execPath, join(nodeDir, "node"));
  const plugin = join(root, "plug in $x");
  mkdirSync(join(plugin, "bin"), { recursive: true });
  writeFileSync(join(plugin, "bin", "launch.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const wrapper = join(root, "omarchy-launch-oats");
  writeExecutable(wrapper, files.launcher({ node: join(nodeDir, "node"), pluginDir: plugin }));
  const args = ["--steward", "two  words", "$HOME", "", "it's", 'a"b', "*", "back\\slash", "--"];
  for (const argv of [["sh", wrapper, ...args], [wrapper, ...args]]) {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), args, argv[0]);
  }
});

test("--apply writes the launcher, 0755, creating ~/.local/bin and recording both; --remove takes both out again", (t) => {
  const s = sandbox(t);
  const wrapper = wrapperOf(s);
  assert.equal(wrapper, join(s.home, ".local/bin/omarchy-launch-oats"));
  const before = snapshot(s.home);
  assert.equal(part(s.run(["setup", "--plan", "--json"]), "launcher").status, "will apply");
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(part(r, "launcher"), { part: "launcher", status: "applied", paths: [wrapper] });
  assert.ok(r.json.result.written.includes(wrapper));
  assert.equal(readFileSync(wrapper, "utf8"), `#!/bin/sh\nexec '${process.execPath}' '${repo}/bin/launch.mjs' "$@"\n`);
  assert.equal(statSync(wrapper).mode & 0o7777, 0o755);
  const state = stateOf(s);
  assert.equal(readFileSync(wrapper, "utf8"), files.launcher({ node: state.node, pluginDir: state.pluginDir }));
  assert.ok(state.parts.includes("launcher"));
  assert.ok(state.dirs.includes(binDir(s)), "setup made ~/.local/bin, and says so");
  const rec = state.files.find((f) => f.role === "launcher");
  assert.deepEqual({ path: rec.path, mode: rec.mode, prior: rec.prior }, { path: wrapper, mode: 0o755, prior: { state: "absent" } });
  assert.match(rec.digest, /^sha256:/);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  assert.equal(part(s.run(["setup", "--apply", "--json"]), "launcher").status, "already applied");

  const removed = s.run(["setup", "--remove", "--json"]);
  assert.equal(removed.status, 0, removed.stdout);
  assert.ok(removed.json.result.restored.includes(wrapper));
  assert.equal(existsSync(binDir(s)), false, "the empty directory setup made is gone");
  assert.deepEqual(snapshot(s.home), before);
});

test("--remove leaves ~/.local/bin when something else is in it, or when it was there before setup", (t) => {
  // Setup made it, and the person has put a file of their own there since.
  const s = sandbox(t);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const mine = join(binDir(s), "my-tool");
  writeExecutable(mine, "#!/bin/sh\necho mine\n");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(existsSync(wrapperOf(s)), false);
  assert.equal(readFileSync(mine, "utf8"), "#!/bin/sh\necho mine\n");

  // It was there before setup (empty): setup neither records it nor removes it.
  const there = sandbox(t);
  mkdirSync(binDir(there), { recursive: true });
  const before = snapshot(there.home);
  assert.equal(there.run(["setup", "--apply"]).status, 0);
  assert.ok(!stateOf(there).dirs.includes(binDir(there)));
  assert.ok(existsSync(wrapperOf(there)));
  assert.equal(there.run(["setup", "--remove"]).status, 0);
  assert.ok(lstatSync(binDir(there)).isDirectory());
  assert.deepEqual(snapshot(there.home), before);
});

// What can be at the launcher's path that setup did not write: each is left
// exactly as it is, and the agent key, which runs the launcher, is not moved.
const foreign = [
  ["a file", "a file", (s, w) => { writeFileSync(w, "#!/bin/sh\necho my own launcher\n"); chmodSync(w, 0o700); }],
  ["a link", "a link", (s, w) => { writeExecutable(join(s.root, "elsewhere"), "#!/bin/sh\nexit 0\n"); symlinkSync(join(s.root, "elsewhere"), w); }],
  ["a dangling link", "a link", (s, w) => symlinkSync(join(s.root, "nowhere"), w)],
];

for (const [name, what, arrange] of foreign) {
  test(`${name} at the launcher's path: the launcher and the agent key are skipped with why, and it is left as it is`, (t) => {
    const s = sandbox(t);
    const file = hypr(s);
    const w = wrapperOf(s);
    mkdirSync(binDir(s), { recursive: true });
    arrange(s, w);
    const before = snapshot(binDir(s));
    const reason = `${w} is ${what} setup did not write, and setup never replaces it: move it away, then run setup again`;

    const plan = s.run(["setup", "--plan", "--agent-key", "oats", "--json"]);
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
    assert.deepEqual(part(plan, "launcher"), { part: "launcher", status: "skipped", reason, paths: [] });
    assert.deepEqual(part(plan, "agent-key"), { part: "agent-key", status: "skipped", reason: `the launcher ${w} is not set up (${reason})`, paths: [] });
    assert.equal(part(plan, "keys").status, "will apply", "the SUPER + O section is still written");
    assert.match(s.run(["setup", "--plan", "--agent-key", "oats"]).stdout, /\n {2}Setup does not write it \(see the agent-key part\); to move the key yourself, add this at the end of /);

    const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(part(r, "launcher").status, "skipped");
    assert.equal(part(r, "agent-key").status, "skipped");
    assert.ok(!r.json.result.written.includes(w));
    assert.deepEqual(snapshot(binDir(s)), before, "bytes, mode and link target untouched");
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes(bindings.START) && !text.includes(bindings.AGENT_START), "the block holds the SUPER + O section alone");
    assert.ok(!stateOf(s).files.some((f) => f.role === "launcher"));
    assert.ok(!stateOf(s).dirs.includes(binDir(s)));

    assert.equal(s.run(["setup", "--remove"]).status, 0);
    assert.deepEqual(snapshot(binDir(s)), before, "--remove leaves it too");
  });
}

test("a launcher the person edited: --check reports it, and --remove leaves it (E_MODIFIED) and restores the rest but the shim", (t) => {
  const s = sandbox(t);
  const w = wrapperOf(s);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const edited = `${readFileSync(w, "utf8")}# mine\n`;
  writeFileSync(w, edited);
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`${w} changed since setup wrote it`));

  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "E_MODIFIED");
  assert.match(r.json.error.message, new RegExp(`^left in place because it was changed since setup wrote it: ${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Everything else was restored\\.`));
  // The shim stays too, as it does whenever --remove leaves anything.
  const shim = join(s.home, ".local/share/oats-omarchy/oats");
  assert.deepEqual(r.json.error.details.left, [{ path: w, why: "changed since setup wrote it" }, { path: shim, why: "kept until everything else is restored" }]);
  assert.equal(readFileSync(w, "utf8"), edited);
  for (const gone of [".config/omarchy/extensions/omarchy-menu.jsonc", ".config/omarchy/hooks/post-update.d/oats-omarchy.hook", ".local/share/applications/org.oats.tui.desktop"]) {
    assert.equal(existsSync(join(s.home, gone)), false, gone);
  }
  assert.deepEqual(stateOf(s).files.map((f) => f.path).sort(), [w, shim].sort());
});

test("the launcher goes with the shim: skipped whenever the shim is", (t) => {
  // The OATS CLI cannot be used: every part is skipped, for that reason.
  const broken = sandbox(t, { kernel: "fail" });
  const plan = broken.run(["setup", "--plan", "--agent-key", "oats", "--json"]);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  const shim = part(plan, "shim");
  assert.equal(shim.status, "skipped");
  assert.deepEqual(part(plan, "launcher"), { part: "launcher", status: "skipped", reason: shim.reason, paths: [] });
  assert.deepEqual(part(plan, "agent-key"), { part: "agent-key", status: "skipped", reason: shim.reason, paths: [] });
  assert.equal(broken.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  assert.equal(existsSync(wrapperOf(broken)), false);

  // The CLI is fine, but nothing that calls the shim can be set up.
  const bare = sandbox(t, { launchers: false });
  const r = bare.run(["setup", "--plan", "--json"]);
  assert.deepEqual([part(r, "shim").status, part(r, "shim").reason], ["skipped", "no part that calls it is applied"]);
  assert.deepEqual(part(r, "launcher"), { part: "launcher", status: "skipped", reason: "the shim is not applied, and the launcher goes with it", paths: [] });
  assert.equal(bare.run(["setup", "--apply"]).status, 0);
  assert.equal(existsSync(wrapperOf(bare)), false);
});
