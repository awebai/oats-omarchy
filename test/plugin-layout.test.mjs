// The plugin's layout: no OATS capability left, `setup` at the root as a
// POSIX sh launcher that finds node, and nothing written inside the plugin's
// own directory (Omarchy reloads plugin code on any change there, and the
// directory is a git checkout that updates fast-forward).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { repo, sandbox, snapshot } from "./helpers/sandbox.mjs";

const self = new URL(import.meta.url).pathname;

function files(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

test("no OATS capability is left: no manifests, no skill, no kernel environment, no --soul", () => {
  for (const gone of ["oats-package", "schemas", "scripts/validate-manifests.mjs", "oats.json", "oats-package.json"]) {
    assert.equal(existsSync(join(repo, gone)), false, gone);
  }
  // Spelled in pieces, so this file does not name them itself.
  const names = ["TEAM_SCOPE", "CLI_BIN", "NODE_BIN", "SOUL_ID", "AGENT", "SETTINGS"].map((n) => `OATS_${n}`);
  const pattern = new RegExp(`\\b(?:${names.join("|")})\\b|--${"soul"}\\b`);
  const hits = files(repo).filter((f) => f !== self && pattern.test(readFileSync(f, "latin1"))).map((f) => relative(repo, f));
  assert.deepEqual(hits, []);
});

test("the layout: setup, bin/, lib/ and assets/ at the root, no symlink anywhere (Omarchy's validator refuses them)", () => {
  for (const path of ["setup", "bin/setup.mjs", "bin/waiting.mjs", "lib/setup.mjs", "assets/oats-256.png"]) assert.ok(existsSync(join(repo, path)), path);
  assert.match(readFileSync(join(repo, "setup"), "utf8"), /^#!\/bin\/sh\n/);
  assert.equal(lstatSync(join(repo, "setup")).mode & 0o111, 0o111, "setup is executable");
  assert.deepEqual(files(repo).filter((f) => lstatSync(f).isSymbolicLink()).map((f) => relative(repo, f)), []);
});

for (const [command, usage] of [["setup", /^usage: setup /], ["waiting", /^usage: waiting /]]) {
  test(`bin/${command}.mjs: --help prints its usage, a bad argument exits 2`, () => {
    const help = spawnSync(process.execPath, [join(repo, "bin", `${command}.mjs`), "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, usage);
    const bad = spawnSync(process.execPath, [join(repo, "bin", `${command}.mjs`), "--bogus"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown argument: --bogus\nusage: /);
  });
}

// The launcher with a PATH that holds only what it needs, and node when
// `withNode`: a copy of the plugin in a directory with a space, run by
// absolute path from elsewhere.
function launcherBox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oats-omarchy-launcher-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, "my plugins", "oats-omarchy");
  mkdirSync(join(plugin, ".."), { recursive: true });
  cpSync(repo, plugin, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)$/.test(src) });
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const tool of ["sh", "dirname"]) symlinkSync(["/usr/bin", "/bin"].map((d) => join(d, tool)).find((f) => existsSync(f)), join(bin, tool));
  const nodeBin = join(root, "node-bin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  const home = join(root, "home");
  mkdirSync(home);
  const run = (args, { withNode = false, env = {} } = {}) => spawnSync(join(bin, "sh"), [join(plugin, "setup"), ...args], {
    env: { HOME: home, PATH: withNode ? `${nodeBin}:${bin}` : bin, ...env }, cwd: root, encoding: "utf8",
  });
  return { root, plugin, home, run };
}

test("the launcher runs bin/setup.mjs with node from PATH, from a copy anywhere", (t) => {
  const b = launcherBox(t);
  const r = b.run(["--help"], { withNode: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^usage: setup /);
});

test("without node on PATH it runs the node the last --apply recorded, else says node is needed", (t) => {
  const b = launcherBox(t);
  const none = b.run(["--help"]);
  assert.equal(none.status, 1);
  assert.equal(none.stdout, "");
  assert.equal(none.stderr, "setup: Node.js is needed: install it so that node is on your PATH, then run setup again\n");

  const state = join(b.home, ".local", "state", "oats-omarchy");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "node"), `${process.execPath}\n`);
  const recorded = b.run(["--help"]);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /^usage: setup /);

  // XDG_STATE_HOME when absolute, as setup itself reads it; a relative one is ignored.
  const xdg = join(b.root, "xdg-state");
  mkdirSync(join(xdg, "oats-omarchy"), { recursive: true });
  writeFileSync(join(xdg, "oats-omarchy", "node"), `${join(b.root, "gone", "node")}\n`);
  assert.equal(b.run(["--help"], { env: { XDG_STATE_HOME: xdg } }).status, 1, "a recorded node that is gone");
  assert.equal(b.run(["--help"], { env: { XDG_STATE_HOME: "relative/state" } }).status, 0);
});

test("--apply and --remove through ./setup write nothing inside the plugin directory", (t) => {
  const s = sandbox(t, { node: true });
  const before = snapshot(repo, { exclude: [".git", "node_modules"] });
  const sh = (args) => spawnSync("/bin/sh", [join(repo, "setup"), ...args], { env: s.env, cwd: s.deployment, encoding: "utf8", timeout: 60_000 });
  const apply = sh(["--apply", "--json"]);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  assert.equal(JSON.parse(apply.stdout).result.parts.find((x) => x.part === "menu").status, "applied");
  assert.deepEqual(snapshot(repo, { exclude: [".git", "node_modules"] }), before, "after --apply");
  const remove = sh(["--remove"]);
  assert.equal(remove.status, 0, remove.stderr);
  assert.deepEqual(snapshot(repo, { exclude: [".git", "node_modules"] }), before, "after --remove");
});
