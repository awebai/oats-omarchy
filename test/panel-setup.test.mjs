// What setup gives the bar widget, and how it finds a deployment the first
// time. The widget's file (plugin.json, in setup's state directory) holds the
// commands the key and the menu run, as argv; with no deployment found and a
// terminal, setup asks for its path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths as discoverPaths } from "../lib/discover.mjs";
import * as files from "../lib/files.mjs";
import * as menu from "../lib/menu.mjs";
import { shellQuote, shellWord } from "../lib/quote.mjs";
import { PLUGIN_DIR, setup } from "../lib/setup.mjs";
import { sandbox } from "./helpers/sandbox.mjs";
import { parsePlugin, pluginFilePath } from "../widget.mjs";

const pluginPath = (s) => join(discoverPaths(s.env).stateDir, "plugin.json");
const readPlugin = (s) => JSON.parse(readFileSync(pluginPath(s), "utf8"));

test("--apply writes plugin.json: the key's and the menu's commands as argv; --remove deletes it", (t) => {
  const s = sandbox(t, { node: true });
  assert.equal(s.run(["setup", "--plan"]).status, 0);
  assert.equal(existsSync(pluginPath(s)), false, "--plan writes nothing");
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const p = discoverPaths(s.env);
  const plugin = readPlugin(s);
  assert.deepEqual(Object.keys(plugin), ["deployment", "tui", "desktop", "waiting", "attach", "setup", "agents", "spawn"]);
  assert.equal(plugin.deployment, s.deployment);
  assert.deepEqual(plugin.tui, files.tuiArgv({ shimPath: p.shim, deployment: s.deployment }));
  assert.equal(plugin.desktop, null, "no Desktop found");
  assert.deepEqual(plugin.attach, [p.shim, "session", "attach", "--detach-key", "M-o", "--home"]);
  const node = plugin.waiting[0];
  assert.deepEqual(plugin.waiting, [node, `${PLUGIN_DIR}/bin/waiting.mjs`, "--dir", s.deployment]);
  assert.deepEqual(plugin.setup, [node, `${PLUGIN_DIR}/bin/setup.mjs`, "--dir", s.deployment]);
  // The picker's reader and its spawn, by the same node.
  assert.deepEqual(plugin.agents, [node, `${PLUGIN_DIR}/bin/agents.mjs`, "--dir", s.deployment]);
  assert.deepEqual(plugin.spawn, [node, `${PLUGIN_DIR}/bin/spawn.mjs`]);
  assert.equal(statSync(pluginPath(s)).mode & 0o777, 0o644);
  // The bar widget finds it where setup wrote it, and reads all of it.
  assert.equal(pluginFilePath(s.env.HOME, s.env.XDG_STATE_HOME), pluginPath(s));
  assert.equal(pluginFilePath(s.env.HOME, ""), join(s.home, ".local/state/oats-omarchy/plugin.json"));
  assert.deepEqual(parsePlugin(readFileSync(pluginPath(s), "utf8")), plugin);

  // The same commands the menu runs, from the same code.
  const items = menu.omarchyParse(readFileSync(p.menuFile, "utf8")).items;
  assert.equal(items["oats.tui"].action, plugin.tui.map(shellWord).join(" "));
  assert.equal(items["oats.waiting"].action, menu.pickerAction("waiting", `${shellQuote(node)} ${shellQuote(plugin.waiting[1])} --dir ${shellQuote(s.deployment)}`));
  assert.equal(items["oats.agents"].action, menu.pickerAction("agents"));

  assert.deepEqual(s.run(["setup", "--apply", "--json"]).json.result.written, [], "a second --apply writes nothing");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.equal(existsSync(pluginPath(s)), false);
});

test("a re-apply picks up a CLI that gained or lost the detach key; --check reports plugin.json missing", (t) => {
  const s = sandbox(t, { node: true });
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.60.0", features: ["session-start"] }));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const shim = discoverPaths(s.env).shim;
  assert.deepEqual(readPlugin(s).attach, [shim, "session", "attach", "--home"]);
  rmSync(join(s.root, "version.json"));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.deepEqual(readPlugin(s).attach, [shim, "session", "attach", "--detach-key", "M-o", "--home"]);

  rmSync(pluginPath(s));
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`the bar widget's ${pluginPath(s)} is missing: run setup --apply again`));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.ok(existsSync(pluginPath(s)), "a re-apply writes it back");
});

test("no plugin.json when the CLI cannot be used: nothing it names would run", (t) => {
  const s = sandbox(t, { node: true, kernel: "none" });
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(existsSync(pluginPath(s)), false);
});

// setup() in this process, as from a terminal outside any deployment: the
// answers are given in turn, and what it printed comes back.
function fromTerminal(s, args, answers) {
  let out = "";
  const asked = [];
  const queue = [...answers];
  const write = { write: (x) => { out += x; } };
  const cwd = process.cwd();
  process.chdir(s.root);
  let status;
  try {
    status = setup(args, s.env, write, write, { interactive: true, ask: () => { asked.push(out.slice(out.lastIndexOf("\n") + 1)); return queue.shift() ?? ""; } });
  } finally { process.chdir(cwd); }
  return { status, out, asked };
}

// Directories that are, and are not, deployments.
function places(s) {
  const dir = join(s.root, "places");
  for (const name of ["real", "plain", "linked-file"]) mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, "real", "oats-local.yaml"), "# real\n");
  symlinkSync(join(dir, "real", "oats-local.yaml"), join(dir, "linked-file", "oats-local.yaml"));
  mkdirSync(join(s.home, "mine"));
  writeFileSync(join(s.home, "mine", "oats-local.yaml"), "# mine\n");
  return { real: realpathSync(join(dir, "real")), plain: join(dir, "plain"), linked: join(dir, "linked-file") };
}

test("no deployment, in a terminal: setup asks for its path, offering none; ~/ works", (t) => {
  const s = sandbox(t, { node: true });
  mkdirSync(join(s.home, "Agents", "beta"), { recursive: true });
  writeFileSync(join(s.home, "Agents", "beta", "oats-local.yaml"), "# not offered\n");
  places(s);
  const r = fromTerminal(s, ["--plan"], ["~/mine"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^No OATS deployment here: no oats-local\.yaml at or above the working directory, and no --dir\.\nType the path of the deployment, the directory that holds oats-local\.yaml \(Enter to stop\): /);
  assert.ok(!r.out.includes("Agents"), "nothing is offered");
  assert.equal(r.asked.length, 1);
  const mine = realpathSync(join(s.home, "mine"));
  assert.match(r.out, new RegExp(`deployment.*${mine.replace(/[/.]/g, "\\$&")}.*your answer`));
  assert.equal(existsSync(pluginPath(s)), false, "--plan writes nothing");
});

test("a typed path is checked and asked again; Enter alone stops with E_NO_DEPLOYMENT; without a terminal nothing is asked", (t) => {
  const s = sandbox(t, { node: true });
  const { real, plain, linked } = places(s);
  const r = fromTerminal(s, ["--plan", "--json"], []);
  assert.equal(r.asked.length, 0, "--json is not a terminal");
  assert.equal(JSON.parse(r.out).error.code, "E_NO_DEPLOYMENT");

  const again = fromTerminal(s, ["--plan"], [join(s.root, "gone"), linked, plain, real]);
  assert.equal(again.status, 0, again.out);
  assert.equal(again.asked.length, 4);
  assert.ok(again.out.includes(`${join(s.root, "gone")} does not exist\n`));
  assert.ok(again.out.includes(`${realpathSync(linked)} holds no regular oats-local.yaml, so it is not an OATS deployment\n`), "a linked oats-local.yaml is not one");
  assert.ok(again.out.includes(`${realpathSync(plain)} holds no regular oats-local.yaml`));
  assert.ok(again.out.includes(real));

  const stopped = fromTerminal(s, ["--plan"], [""]);
  assert.equal(stopped.status, 1);
  assert.match(stopped.out, /setup: no OATS deployment: no oats-local\.yaml at or above/);
});

test("--apply from a terminal asks for the deployment first, then shows the plan and asks y/N", (t) => {
  const s = sandbox(t, { node: true });
  const { real } = places(s);
  const r = fromTerminal(s, ["--apply"], [real, "n"]);
  assert.equal(r.status, 1);
  assert.equal(r.asked.length, 2);
  assert.match(r.asked[1], /^Apply it\? \[y\/N\] $/);
  assert.ok(r.out.includes(real));
  assert.match(r.out, /aborted: nothing was changed/);
});
