// This computer's list of deployments (awebai/oats#1390): with a CLI that
// lists the feature deployments-list, setup is for no deployment of its own.
// The launchers open the TUI and the Desktop without --dir, and the menu and
// the bar widget read every listed deployment, one after another. Without the
// feature everything stays for the one deployment setup is applied for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths as discoverPaths } from "../lib/discover.mjs";
import { parseList } from "../lib/deployments.mjs";
import * as menu from "../lib/menu.mjs";
import { PLUGIN_DIR } from "../lib/setup.mjs";
import { labels, listOf, statusEvery, waiting } from "../lib/waiting.mjs";
import { BIN, repo, sandbox, writeExecutable } from "./helpers/sandbox.mjs";
import * as W from "../widget.mjs";

const W8 = { since: "2026-10-19T10:00:00.000Z", producer: "agent", reason: "attention", message: "needs a decision" };
const agent = (...instances) => ({ name: "a", instances: instances.map(([instance, home, w]) => ({ agent: "a", instance, home, running: true, waitingOnYou: w ? W8 : null })) });

function withFeature(s, features = ["session-attach-detach-key", "deployments-list"]) {
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.65.0", features }));
}

// A deployment beside the sandbox's, with what its `oats status --json` says.
function deploymentAt(s, name, agents, workspace) {
  const d = join(s.root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "oats-local.yaml"), "# a test deployment\n");
  writeFileSync(join(d, "status.json"), JSON.stringify({ root: d, agents, features: [], workspace: workspace ? { key: workspace } : {} }));
  return d;
}

// The kernel's list: rows of { path, name, state }, as `oats deployments --json` answers it.
function listed(s, rows) {
  const deployments = rows.map((r) => ({ path: r.path, name: r.name, state: r.state || "ok", addedAt: "2026-10-19T10:00:00.000Z", via: "cli" }));
  writeFileSync(join(s.root, "deployments.json"), JSON.stringify({ deploymentsApi: 1, file: join(s.home, ".oats/config/deployments.json"), deployments, imports: {} }));
}

const shimPath = (s) => join(s.home, ".local/share/oats-omarchy/oats");
const writeShim = (s) => writeExecutable(shimPath(s), `#!/bin/sh\nexec '${process.execPath}' '${s.cli}' "$@"\n`);
const statusDirs = (s) => { try { return readFileSync(join(s.root, "status-dirs.log"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const calls = (s, log) => {
  let text;
  try { text = readFileSync(join(s.root, log), "utf8"); } catch { return []; }
  return text.split("--\n").filter(Boolean).map((c) => c.replace(/\n$/, "").split("\n"));
};

// Whether a pid is gone: no such process, or one that has exited and waits
// only to be reaped.
const gone = (pid) => {
  try { return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
};
const pidsIn = (s, file) => { try { return readFileSync(join(s.root, file), "utf8").trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
async function allGone(pids, ms = 5000) {
  const end = Date.now() + ms;
  while (!pids.every(gone) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return pids.every(gone);
}

async function listJson(s, opts = {}) {
  if (!existsSync(shimPath(s))) writeShim(s);
  let stdout = "";
  let stderr = "";
  const status = await waiting(["--list", "--json"], s.env, { write: (x) => { stderr += x; } }, { ...opts, out: { write: (x) => { stdout += x; } } });
  return { status, stderr, stdout, result: stdout ? JSON.parse(stdout) : null };
}

test("the list as the kernel answers it: its envelope, its refusals, and a CLI without it", () => {
  const doc = { deploymentsApi: 1, file: "/h/.oats/config/deployments.json", deployments: [{ path: "/a", name: "a", state: "ok", addedAt: "x", via: "cli" }, { path: "/b", name: "b", state: "missing", addedAt: "x", via: "tui" }], imports: {} };
  const rows = [{ path: "/a", name: "a", state: "ok" }, { path: "/b", name: "b", state: "missing" }];
  assert.deepEqual(parseList(JSON.stringify({ schemaVersion: 1, ok: true, result: doc })), { ok: true, rows });
  assert.deepEqual(parseList(JSON.stringify(doc)), { ok: true, rows }, "bare, too");
  assert.equal(parseList(JSON.stringify({ ok: false, error: { message: "cannot be read" } })).reason, "cannot be read");
  assert.match(parseList(JSON.stringify({ ...doc, deploymentsApi: 2 })).reason, /not deploymentsApi 1/);
  assert.match(parseList(JSON.stringify({ ...doc, deployments: [{ path: "rel", name: "r", state: "ok" }] })).reason, /a row this plugin cannot read/);
  assert.match(parseList(JSON.stringify({ ...doc, deployments: [{ path: "/a", name: "a", state: "gone" }] })).reason, /a row this plugin cannot read/);
  assert.match(parseList("oats: crashed").reason, /no JSON/);
  const old = listOf({ ok: false, status: 2, stdout: JSON.stringify({ ok: false, error: { code: "E_UNKNOWN_COMMAND", message: "no capability provides deployments" } }), stderr: "" });
  assert.match(old.reason, /^this OATS CLI keeps no list of deployments \(it lacks the feature deployments-list\)/);
});

test("--list --json: every ok deployment read in the list's order, one at a time; a failed one is unknown on its own", async (t) => {
  const s = sandbox(t);
  withFeature(s);
  const a = deploymentAt(s, "a", [agent(["alpha", "/h/alpha", true], ["idle", "/h/idle"])], "github.com/acme/one");
  const b = deploymentAt(s, "b", [agent(["beta", "/h/beta", true])], "github.com/acme/two");
  const c = deploymentAt(s, "c", [], "github.com/acme/two");
  writeFileSync(join(c, "status.mode"), "envelope");
  listed(s, [{ path: a, name: "a" }, { path: b, name: "b" }, { path: join(s.root, "gone"), name: "gone", state: "missing" }, { path: c, name: "c" }]);
  const r = await listJson(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(statusDirs(s), [a, b, c], "the missing row is not read; the rest in order");
  assert.deepEqual(r.result, {
    ok: true, count: 2,
    rows: [{ instance: "alpha", home: "/h/alpha", waitingOnYou: W8, deployment: a, workspace: "github.com/acme/one" }, { instance: "beta", home: "/h/beta", waitingOnYou: W8, deployment: b, workspace: "github.com/acme/two" }],
    deployments: [
      { path: a, name: "a", workspace: "github.com/acme/one", ok: true },
      { path: b, name: "b", workspace: "github.com/acme/two", ok: true },
      { path: c, name: "c", workspace: null, ok: false, reason: "oats-lock.json is unreadable: Unexpected end of JSON input" },
    ],
  });
  const shown = W.parseWaiting(r.stdout);
  assert.deepEqual([shown.known, shown.count], [true, 2], "a failed deployment does not make the whole read unknown");
  assert.deepEqual(shown.groups, [
    { title: "github.com/acme/one", rows: [{ instance: "alpha", home: "/h/alpha", label: "alpha", waitingOnYou: W8 }], unknown: [] },
    { title: "github.com/acme/two", rows: [{ instance: "beta", home: "/h/beta", label: "beta", waitingOnYou: W8 }], unknown: [] },
    { title: "c", rows: [], unknown: ["c: oats-lock.json is unreadable: Unexpected end of JSON input"] },
  ]);
});

test("--list --json: ? only when no deployment could be read; an empty list says how to fill it; an old CLI says so", async (t) => {
  const s = sandbox(t);
  withFeature(s);
  const a = deploymentAt(s, "a", []);
  writeFileSync(join(a, "status.mode"), "stderr");
  listed(s, [{ path: a, name: "a" }]);
  const failed = await listJson(s);
  assert.equal(failed.status, 1);
  assert.match(failed.result.reason, /^no deployment could be read: a: oats: no oats-local\.yaml/);
  assert.equal(W.parseWaiting(failed.stdout).known, false, "the panel shows why");

  listed(s, [{ path: join(s.root, "gone"), name: "gone", state: "missing" }]);
  const none = await listJson(s);
  assert.equal(none.status, 0);
  assert.match(none.result.note, /holds no deployment to read: run any oats command in a deployment, or `oats deployments add <path>`/);
  assert.deepEqual(W.parseWaiting(none.stdout).rows, [], "no rows, and no claim that nobody waits");
  assert.equal(W.parseWaiting(none.stdout).note, none.result.note, "the panel shows it");

  writeFileSync(join(s.root, "deployments.mode"), "envelope");
  assert.match((await listJson(s)).result.reason, /deployments\.json cannot be read/);
  withFeature(s, ["session-attach-detach-key"]);
  const old = await listJson(s);
  assert.equal(old.status, 1);
  assert.match(old.result.reason, /keeps no list of deployments/);
});

test("--list --json: reads stop at the budget; a deployment not reached by then is not read", async (t) => {
  const s = sandbox(t);
  withFeature(s);
  const a = deploymentAt(s, "a", []);
  const b = deploymentAt(s, "b", [agent(["beta", "/h/beta", true])]);
  writeFileSync(join(a, "status.mode"), "hang");
  listed(s, [{ path: a, name: "a" }, { path: b, name: "b" }]);
  const r = await listJson(s, { statusTimeoutMs: 5000, listBudgetMs: 1500 });
  assert.equal(r.status, 1);
  assert.deepEqual(statusDirs(s), [a], "b was never started");
  assert.match(r.result.deployments[0].reason, /^timed out after 1[0-9]{3} ms$/, "a's read had what was left of the budget");
  assert.deepEqual(r.result.deployments[1], { path: b, name: "b", workspace: null, ok: false, reason: "not read: the 2 s for every deployment ran out" });
});

test("the menu with --list: labels by workspace, the chosen session in its deployment; a failure says which", async (t) => {
  const s = sandbox(t);
  withFeature(s);
  writeShim(s);
  const a = deploymentAt(s, "a", [agent(["alpha", "/h/alpha", true])], "github.com/acme/one");
  const b = deploymentAt(s, "b", [agent(["alpha", "/h/alpha-b", true])], "github.com/acme/two");
  listed(s, [{ path: a, name: "a" }, { path: b, name: "b" }]);
  let stderr = "";
  const err = { write: (x) => { stderr += x; } };
  assert.equal(await waiting(["--list"], { ...s.env, FAKE_SELECT: "alpha (github.com/acme/two)" }, err), 0, stderr);
  assert.deepEqual(calls(s, "select.log"), [["Waiting on you (2)", "alpha (github.com/acme/one)", "alpha (github.com/acme/two)"]]);
  const end = Date.now() + 10_000;
  while (!existsSync(join(s.root, "floating.log")) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.match(readFileSync(join(s.root, "floating.log"), "utf8"), /session' 'attach' '--detach-key' 'M-o' '--home' '\/h\/alpha-b'/);

  writeFileSync(join(b, "status.mode"), "envelope");
  writeFileSync(join(a, "status.json"), JSON.stringify({ root: a, agents: [], workspace: {} }));
  stderr = "";
  assert.equal(await waiting(["--list"], s.env, err), 0);
  assert.deepEqual(calls(s, "notify.log"), [["Waiting on you (0)", "Not read: b"]]);
  assert.match(stderr, /b \(.*\/b\) could not be read: oats-lock\.json is unreadable/);

  // Labels stay apart when the workspace is not enough.
  assert.deepEqual(labels([{ instance: "x", workspace: "w", deployment: "/1" }, { instance: "x", workspace: "w", deployment: "/2" }], true), ["x (/1)", "x (/2)"]);
  assert.equal(waiting(["--list", "--dir", a], s.env, { write: () => {} }), 2, "--list takes no --dir");
});

test("the menu with --list stops a kernel that never answers, with its child, before reading the next", async (t) => {
  const s = sandbox(t);
  withFeature(s);
  writeShim(s);
  const a = deploymentAt(s, "a", []);
  const b = deploymentAt(s, "b", [agent(["beta", "/h/beta", true])]);
  writeFileSync(join(a, "status.mode"), "hang");
  listed(s, [{ path: a, name: "a" }, { path: b, name: "b" }]);
  let stderr = "";
  assert.equal(await waiting(["--list"], s.env, { write: (x) => { stderr += x; } }, { statusTimeoutMs: 700 }), 0, stderr);
  assert.match(stderr, /a \(.*\/a\) could not be read: timed out after 700 ms/);
  assert.deepEqual(statusDirs(s), [a, b]);
  const pids = pidsIn(s, "status.pids");
  assert.equal(pids.length, 2);
  assert.ok(await allGone(pids), "the hanging kernel and its child are gone");
});

test("the menu with --list stopped by a signal during the list read leaves no kernel behind", async (t) => {
  const s = sandbox(t);
  withFeature(s);
  writeShim(s);
  writeFileSync(join(s.root, "deployments.mode"), "hang");
  const proc = spawn(process.execPath, [BIN.waiting, "--list"], { env: s.env, stdio: "ignore" });
  t.after(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } });
  const end = Date.now() + 10_000;
  while (pidsIn(s, "deployments.pids").length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  const pids = pidsIn(s, "deployments.pids");
  assert.equal(pids.length, 2, "the list read started");
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  proc.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 143, signal: null });
  assert.ok(await allGone(pids), "the list read and its child are gone");
});

test("the menu's Status with the list stops a status that never answers, with its child", async (t) => {
  const s = sandbox(t);
  withFeature(s);
  writeShim(s);
  const a = deploymentAt(s, "a", []);
  writeFileSync(join(a, "status.mode"), "hang");
  listed(s, [{ path: a, name: "a" }]);
  let stderr = "";
  const code = await statusEvery(s.env, { write: (x) => { stderr += x; } }, { timeoutMs: 700 });
  assert.equal(code, 1);
  assert.match(stderr, /oats status --dir .*\/a: timed out after 700 ms/);
  const pids = pidsIn(s, "status.pids");
  assert.equal(pids.length, 2);
  assert.ok(await allGone(pids));
});

test("the menu's Status with the list: the kernel's own status of each ok deployment, in turn", (t) => {
  const s = sandbox(t);
  withFeature(s);
  writeShim(s);
  const a = deploymentAt(s, "a", []);
  const b = deploymentAt(s, "b", []);
  listed(s, [{ path: a, name: "a" }, { path: join(s.root, "gone"), name: "gone", state: "missing" }, { path: b, name: "b" }]);
  const run = () => spawnSync(process.execPath, [join(repo, "bin", "status.mjs")], { env: s.env, cwd: s.home, encoding: "utf8", timeout: 30_000 });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `oats status — agents root ${a}/agents\noats status — agents root ${b}/agents\n`);
  listed(s, []);
  const empty = run();
  assert.equal(empty.status, 0);
  assert.match(empty.stderr, /holds no deployment to read: run any oats command in a deployment, or `oats deployments add <path>`/);
});

test("setup with the list: no deployment needed; the launchers, the menu and the widget use the list", (t) => {
  const s = sandbox(t, { node: true });
  withFeature(s);
  const image = join(s.home, ".local/opt/oats-desktop/OATS-Desktop.AppImage");
  writeExecutable(image, "#!/bin/sh\nexit 0\n");
  listed(s, []);
  const plan = s.run(["setup", "--plan", "--json"], {}, { cwd: s.home });
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.equal(plan.json.result.deployment, null);
  assert.deepEqual(plan.json.result.found.deployment, { list: true, from: "this computer's list of deployments", listed: [] });
  assert.ok(plan.json.result.notes.includes("This computer's list holds no deployment yet: run any oats command in a deployment, or `oats deployments add <path>`."));
  assert.ok(!plan.json.result.notes.some((n) => /not switched to this deployment/.test(n)));
  const text = s.run(["setup", "--plan"], {}, { cwd: s.home });
  assert.match(text.stdout, /deployment {2}this computer's list of deployments \(`oats deployments`\): 0 listed, 0 to read/);

  // --dir checks only that it is listed.
  const unlisted = s.run(["setup", "--plan", "--json", "--dir", s.deployment], {}, { cwd: s.home });
  assert.ok(unlisted.json.result.notes.includes(`${s.deployment} is not in this computer's list of deployments: run \`oats deployments add ${s.deployment}\`, or any oats command in it.`));
  listed(s, [{ path: s.deployment, name: "deployment" }]);
  assert.ok(!s.run(["setup", "--plan", "--json", "--dir", s.deployment], {}, { cwd: s.home }).json.result.notes.some((n) => /is not in this computer's list/.test(n)));

  const r = s.run(["setup", "--apply", "--ui", "desktop", "--json"], {}, { cwd: s.home });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const p = discoverPaths(s.env);
  const plugin = JSON.parse(readFileSync(join(p.stateDir, "plugin.json"), "utf8"));
  const node = plugin.waiting[0];
  assert.equal(plugin.deployment, null);
  assert.deepEqual(plugin.tui, ["omarchy-launch-or-focus-tui", "--app-id=org.oats.tui", p.shim, "tui"]);
  assert.deepEqual(plugin.desktop, ["omarchy-launch-or-focus", "awebai-oats-desktop", `uwsm-app -- ${image}`]);
  assert.equal(plugin.ui, "desktop");
  assert.deepEqual(plugin.waiting, [node, `${PLUGIN_DIR}/bin/waiting.mjs`, "--list"]);
  assert.deepEqual(plugin.setup, [node, `${PLUGIN_DIR}/bin/setup.mjs`]);
  assert.ok(W.isList(W.parsePlugin(JSON.stringify(plugin))));
  assert.equal(W.readTimeoutMs(plugin), 120000);
  assert.deepEqual(W.readArgv(plugin), [node, `${PLUGIN_DIR}/bin/waiting.mjs`, "--list", "--json"]);
  const items = menu.omarchyParse(readFileSync(p.menuFile, "utf8")).items;
  assert.equal(items["oats.waiting"].action, menu.popupAction(`'${node}' '${PLUGIN_DIR}/bin/waiting.mjs' --list`));
  assert.equal(items["oats-ui"].action, items["oats.desktop"].action);
  assert.equal(items["oats.status"].action, `omarchy-launch-floating-terminal-with-presentation "'${node}' '${PLUGIN_DIR}/bin/status.mjs'"`);
  assert.doesNotMatch(readFileSync(join(p.applications, "org.oats.tui.desktop"), "utf8"), /--dir/);
  assert.doesNotMatch(readFileSync(join(p.applications, "awebai-oats-desktop.desktop"), "utf8"), /--dir/);
  const hook = readFileSync(join(s.home, ".config/omarchy/hooks/post-update.d/oats-omarchy.hook"), "utf8");
  assert.doesNotMatch(hook, /^cd /m, "no deployment to check from");
  const state = JSON.parse(readFileSync(join(p.stateDir, "state.json"), "utf8"));
  assert.equal(state.deployment, null);
  assert.deepEqual(s.run(["setup", "--check", "--json"], {}, { cwd: s.deployment }).json.result, { mode: "check", applied: true, deployment: null, drift: [] }, "from inside any deployment, nothing drifted");
  const hookRun = spawnSync("bash", [join(s.home, ".config/omarchy/hooks/post-update.d/oats-omarchy.hook")], { env: s.env, cwd: s.home, encoding: "utf8" });
  assert.deepEqual([hookRun.status, hookRun.stdout], [0, ""]);
  assert.equal(s.run(["setup", "--remove"], {}, { cwd: s.deployment }).status, 0, "removed from anywhere");
  assert.equal(existsSync(join(p.stateDir, "state.json")), false);
});

test("a single-deployment setup: --check says when the CLI gains the list, and --apply switches to it, and back", (t) => {
  const s = sandbox(t, { node: true });
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const p = discoverPaths(s.env);
  const plugin = () => JSON.parse(readFileSync(join(p.stateDir, "plugin.json"), "utf8"));
  assert.equal(plugin().deployment, s.deployment, "without the feature, unchanged");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);

  withFeature(s);
  listed(s, [{ path: s.deployment, name: "deployment" }]);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, [`the OATS CLI now keeps this computer's list of deployments: run setup --apply again to use every listed deployment, not ${s.deployment} alone`]);
  const plan = s.run(["setup", "--plan", "--json"], {}, { cwd: s.home });
  assert.ok(plan.json.result.notes.includes(`Setup is applied for the deployment ${s.deployment} alone; --apply switches it to this computer's list of deployments.`));
  const r = s.run(["setup", "--apply", "--json"], {}, { cwd: s.home });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(plugin().deployment, null);
  assert.ok(r.json.result.written.includes(join(p.applications, "org.oats.tui.desktop")), "the TUI entry loses --dir");

  withFeature(s, ["session-attach-detach-key"]);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, ["the OATS CLI no longer keeps this computer's list of deployments, which setup is applied for: run setup --apply --dir <deployment> again"]);
  assert.equal(s.run(["setup", "--apply", "--json"], {}, { cwd: s.home }).json.error.code, "E_NO_DEPLOYMENT");
  const back = s.run(["setup", "--plan", "--json"]);
  assert.ok(back.json.result.notes.some((n) => n.startsWith("Setup is applied for this computer's list of deployments, which this OATS CLI no longer keeps")));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(plugin().deployment, s.deployment);
});

test("the widget: plugin.json with the list, grouped rows, the list's deadline", () => {
  const plugin = { deployment: null, tui: ["t"], desktop: null, ui: "tui", waiting: ["n", "w", "--list"], attach: ["s", "--home"], setup: ["n", "s"] };
  assert.deepEqual(W.parsePlugin(JSON.stringify(plugin)), plugin);
  assert.equal(W.parsePlugin(JSON.stringify({ ...plugin, deployment: 1 })), null);
  assert.equal(W.isList(plugin), true);
  assert.equal(W.readTimeoutMs({ ...plugin, deployment: "/d" }), W.READ_TIMEOUT_MS);
  const state = W.newReadState();
  const attempt = W.beginRead(state);
  assert.deepEqual(W.expireRead(state, attempt, W.LIST_READ_TIMEOUT_MS), { known: false, reason: "waiting --json did not answer within 120 s" });

  // Two deployments of one workspace: one group, each row names its deployment.
  const deployments = [{ path: "/1", name: "one", workspace: "w", ok: true }, { path: "/2", name: "two", workspace: "w", ok: true }];
  const rows = [{ instance: "x", home: "/h/1", deployment: "/1", workspace: "w" }, { instance: "x", home: "/h/2", deployment: "/2", workspace: "w" }];
  assert.deepEqual(W.groups(rows, deployments), [{ title: "", rows: [{ instance: "x", home: "/h/1", label: "x (one)", waitingOnYou: null }, { instance: "x", home: "/h/2", label: "x (two)", waitingOnYou: null }], unknown: [] }]);
  assert.deepEqual(W.groups([], deployments), [], "nothing waiting, nothing unknown: no group");
  assert.deepEqual(W.groups([{ instance: "x", home: "/h" }], null), [{ title: "", rows: [{ instance: "x", home: "/h", label: "x", waitingOnYou: null }], unknown: [] }], "one deployment, as before");

  // Two deployments of one workspace with the same name: the path tells them apart.
  const twins = [{ path: "/p/a/oats", name: "oats", workspace: "w", ok: true }, { path: "/p/b/oats", name: "oats", workspace: "w", ok: true }];
  assert.deepEqual(W.groups([{ instance: "r", home: "/1", deployment: "/p/a/oats" }, { instance: "r", home: "/2", deployment: "/p/b/oats" }], twins)[0].rows.map((x) => x.label), ["r (/p/a/oats)", "r (/p/b/oats)"]);

  // Names that look like an object's own keys, and two failed deployments with one name.
  const odd = [
    { path: "/a", name: "a", workspace: "w", ok: true },
    { path: "/constructor", name: "constructor", workspace: null, ok: false, reason: "unreadable" },
    { path: "/x/__proto__", name: "__proto__", workspace: null, ok: false, reason: "gone" },
    { path: "/y/toString", name: "toString", workspace: null, ok: false, reason: "r1" },
    { path: "/z/toString", name: "toString", workspace: null, ok: false, reason: "r2" },
  ];
  const text = JSON.stringify({ ok: true, count: 1, rows: [{ instance: "r", home: "/h", deployment: "/a", workspace: "w" }], deployments: odd });
  const shown = W.parseWaiting(text);
  assert.deepEqual([shown.known, shown.count], [true, 1]);
  assert.deepEqual(shown.groups.map((g) => [g.title, g.rows.length, g.unknown]), [
    ["w", 1, []], ["constructor", 0, ["constructor: unreadable"]], ["__proto__", 0, ["__proto__: gone"]], ["toString", 0, ["toString: r1"]], ["toString", 0, ["toString: r2"]],
  ]);
});
