// `bin/agents.mjs --json`, the OATS picker's read, against the sandbox's
// fake kernel (test/helpers/sandbox.mjs) through the shim setup writes: one
// deployment and the list, a deployment that fails, waiting and not
// waiting, no souls, and each contract used only when the kernel lists it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agents } from "../lib/agents.mjs";
import { parseAgents } from "../picker.mjs";
import { BIN, sandbox, writeExecutable } from "./helpers/sandbox.mjs";

const W = { since: "2026-10-19T10:00:00.000Z", producer: "oats.core", reason: "permission", message: "Allow Bash?" };
const ALL = ["session-attach-detach-key", "deployments-list", "waiting-on-you", "launch-preference"];

const shimPath = (s) => join(s.home, ".local/share/oats-omarchy/oats");
const writeShim = (s) => writeExecutable(shimPath(s), `#!/bin/sh\nexec '${process.execPath}' '${s.cli}' "$@"\n`);
const withFeatures = (s, features = ALL) => writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.65.0", features }));
const lines = (s, file) => { try { return readFileSync(join(s.root, file), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

// A deployment: its roster (agents as [name, key, [[instance, running, waiting?]]])
// and, unless `souls` is null, the souls it offers.
function deploymentAt(s, name, roster, { workspace = null, souls = [] } = {}) {
  const d = name === null ? s.deployment : join(s.root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "oats-local.yaml"), "# a test deployment\n");
  const agentsList = roster.map(([agent, key, instances]) => ({
    name: agent, key, instances: instances.map(([instance, running, waiting]) => ({ instance, home: join(d, "agents", agent, "instances", instance), running, waitingOnYou: waiting ? W : null })),
  }));
  writeFileSync(join(d, "status.json"), JSON.stringify({ root: d, agents: agentsList, workspace: workspace ? { key: workspace } : {} }));
  if (souls !== null) writeFileSync(join(d, "souls.json"), JSON.stringify({ schemaVersion: 1, ok: true, result: { soulsApi: 1, workspace: null, souls, problems: [] } }));
  return d;
}
const soul = (name, extra = {}) => ({ name, origin: "member", kind: "member", description: `${name}'s description`, spawnable: true, problem: null, ...extra });
const home = (d, agent, instance) => join(d, "agents", agent, "instances", instance);

function listed(s, rows) {
  const deployments = rows.map((r) => ({ path: r.path, name: r.name, state: r.state || "ok", addedAt: "2026-10-19T10:00:00.000Z", via: "cli" }));
  writeFileSync(join(s.root, "deployments.json"), JSON.stringify({ deploymentsApi: 1, file: join(s.home, ".oats/config/deployments.json"), deployments, imports: {} }));
}

async function read(s, args, opts = {}) {
  if (!existsSync(shimPath(s))) writeShim(s);
  let stdout = "";
  let stderr = "";
  const status = await agents(args, s.env, { write: (x) => { stderr += x; } }, { ...opts, out: { write: (x) => { stdout += x; } } });
  return { status, stderr, stdout, result: stdout ? JSON.parse(stdout) : null };
}

test("--dir: every instance with its claim as given, waiting or not; every soul with its instance count; one JSON line", async (t) => {
  const s = sandbox(t);
  withFeatures(s);
  const d = deploymentAt(s, null, [
    ["writer", "writer", [["writer-1", true, true], ["writer-2", false]]],
    ["oats-okf--knowledge-maintainer", "oats.okf/knowledge-maintainer", [["km-1", null]]],
  ], {
    workspace: "github.com/acme/agents",
    souls: [
      soul("writer"),
      soul("knowledge-maintainer", { qualifiedName: "oats.okf/knowledge-maintainer", key: "oats.okf/knowledge-maintainer" }),
      soul("reviewer", { spawnable: false, problem: { code: "E_TEAM_UNKNOWN", message: "team \"reviewers\" is not declared" } }),
    ],
  });
  const r = await read(s, ["--dir", d, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split("\n").length, 2, "one line");
  assert.deepEqual(r.result, {
    ok: true,
    features: { waitingOnYou: true, soulCounts: true },
    deployments: [{
      path: d, name: "deployment", workspace: "github.com/acme/agents", ok: true,
      agents: [
        { agent: "writer", instance: "writer-1", home: home(d, "writer", "writer-1"), running: true, waitingOnYou: W },
        { agent: "writer", instance: "writer-2", home: home(d, "writer", "writer-2"), running: false, waitingOnYou: null },
        { agent: "oats-okf--knowledge-maintainer", instance: "km-1", home: home(d, "oats-okf--knowledge-maintainer", "km-1"), running: null, waitingOnYou: null },
      ],
      souls: [
        { key: "writer", name: "writer", description: "writer's description", spawnable: true, problem: null, instances: 2 },
        { key: "oats.okf/knowledge-maintainer", name: "knowledge-maintainer", description: "knowledge-maintainer's description", spawnable: true, problem: null, instances: 1 },
        { key: "reviewer", name: "reviewer", description: "reviewer's description", spawnable: false, problem: { code: "E_TEAM_UNKNOWN", message: "team \"reviewers\" is not declared" }, instances: 0 },
      ],
    }],
  });
  assert.deepEqual(lines(s, "souls-dirs.log"), [d]);
  assert.deepEqual(lines(s, "kernel.log"), [], "nothing but the reads ran");

  // As the picker shows it: one card for the agent waiting on you.
  const view = parseAgents(r.stdout, Date.parse("2026-10-19T10:03:00.000Z"));
  assert.deepEqual(view.waiting.map((x) => [x.label, x.message, x.meta, x.since]), [["writer-1", "Allow Bash?", "permission · oats.core · 3 min", W.since]]);
  assert.deepEqual(view.agents.map((x) => [x.label, x.running, x.waiting]), [["writer-1", "running", true], ["writer-2", "stopped", false], ["km-1", "unknown", false]]);
  assert.deepEqual(view.souls.map((x) => [x.key, x.meta, x.act, x.message]), [["writer", "2 instances", true, ""], ["oats.okf/knowledge-maintainer", "1 instance", true, ""], ["reviewer", "0 instances", false, "team \"reviewers\" is not declared"]]);
});

test("--list: every ok deployment in the list's order, one after another; a failed one is shown as such and the rest are listed", async (t) => {
  const s = sandbox(t);
  withFeatures(s);
  const a = deploymentAt(s, "a", [["writer", "writer", [["w-1", true]]]], { workspace: "github.com/acme/one", souls: [soul("writer")] });
  const b = deploymentAt(s, "b", [], { workspace: "github.com/acme/two", souls: [] });
  const c = deploymentAt(s, "c", []);
  writeFileSync(join(c, "status.mode"), "envelope");
  listed(s, [{ path: a, name: "a" }, { path: join(s.root, "gone"), name: "gone", state: "missing" }, { path: c, name: "c" }, { path: b, name: "b" }]);
  const r = await read(s, ["--list", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(s, "status-dirs.log"), [a, c, b], "the missing row is not read; the rest in order");
  assert.deepEqual(lines(s, "souls-dirs.log"), [a, b], "no souls read for a deployment whose roster failed");
  const [da, dc, db] = r.result.deployments;
  assert.deepEqual([da.name, da.ok, da.agents.length, da.souls.length], ["a", true, 1, 1]);
  assert.deepEqual(dc, { path: c, name: "c", workspace: null, ok: false, reason: "oats-lock.json is unreadable: Unexpected end of JSON input" });
  assert.deepEqual([db.name, db.ok, db.agents, db.souls], ["b", true, [], []], "no souls: an empty list, not unknown");
  const view = parseAgents(r.stdout, Date.now());
  assert.equal(view.known, true);
  assert.deepEqual(view.notes, ["c: oats-lock.json is unreadable: Unexpected end of JSON input"]);
  assert.deepEqual(view.agents.map((x) => [x.group, x.label]), [["github.com/acme/one", "w-1"]]);

  // No deployment could be read: the whole answer fails, with the first one's reason.
  writeFileSync(join(a, "status.mode"), "envelope");
  writeFileSync(join(b, "status.mode"), "envelope");
  const none = await read(s, ["--list", "--json"]);
  assert.equal(none.status, 1);
  assert.deepEqual(none.result, { ok: false, reason: "no deployment could be read: a: oats-lock.json is unreadable: Unexpected end of JSON input" });
  assert.deepEqual(parseAgents(none.stdout, Date.now()), { known: false, reason: none.result.reason });

  // An empty list says how to fill it.
  listed(s, []);
  const empty = await read(s, ["--list", "--json"]);
  assert.equal(empty.status, 0);
  assert.deepEqual(Object.keys(empty.result), ["ok", "features", "deployments", "note"]);
  assert.match(empty.result.note, /^This computer's list holds no deployment to read: /);
});

test("souls that cannot be read are unknown on their own: a kernel refusal, or an answer that is not soulsApi 1", async (t) => {
  const s = sandbox(t);
  withFeatures(s);
  const d = deploymentAt(s, null, [["writer", "writer", [["w-1", true, true]]]]);
  writeFileSync(join(d, "souls.mode"), "envelope");
  const refused = await read(s, ["--dir", d, "--json"]);
  assert.equal(refused.status, 0);
  const [dep] = refused.result.deployments;
  assert.deepEqual([dep.ok, dep.agents.length, dep.souls, dep.soulsReason], [true, 1, null, "the workspace cannot be read"]);
  const view = parseAgents(refused.stdout, Date.now());
  assert.deepEqual([view.waiting.length, view.souls, view.soulNotes], [1, [], ["deployment: the workspace cannot be read"]]);

  writeFileSync(join(d, "souls.mode"), "");
  writeFileSync(join(d, "souls.json"), JSON.stringify({ schemaVersion: 1, ok: true, result: { soulsApi: 2, souls: [] } }));
  const later = await read(s, ["--dir", d, "--json"]);
  assert.equal(later.result.deployments[0].soulsReason, "oats souls --json is not soulsApi 1");
});

test("a CLI without waiting-on-you: no claim is read, and the answer says the CLI does not report it; without launch-preference, no counts", async (t) => {
  const s = sandbox(t);
  withFeatures(s, ["session-attach-detach-key"]);
  const d = deploymentAt(s, null, [["writer", "writer", [["w-1", true, true]]]], { souls: [soul("writer")] });
  const r = await read(s, ["--dir", d, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.result.features, { waitingOnYou: false, soulCounts: false });
  assert.equal(r.result.deployments[0].agents[0].waitingOnYou, null, "a claim the CLI does not vouch for is not shown");
  assert.equal(r.result.deployments[0].souls[0].instances, null);
  const view = parseAgents(r.stdout, Date.now());
  assert.deepEqual([view.waiting, view.waitingReported, view.souls[0].meta], [[], false, ""]);
});

test("a failed version read fails the whole answer; a missing shim says to run setup; bad arguments exit 2", async (t) => {
  const s = sandbox(t);
  const d = deploymentAt(s, null, []);
  writeFileSync(join(s.root, "version.json"), "not json");
  const r = await read(s, ["--dir", d, "--json"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.result, { ok: false, reason: "oats version --json: it printed no JSON" });
  assert.deepEqual(lines(s, "status-dirs.log"), [], "nothing else is read");

  const t2 = sandbox(t);
  let out = "";
  assert.equal(await agents(["--dir", t2.deployment, "--json"], t2.env, { write() {} }, { out: { write: (x) => { out += x; } } }), 1);
  assert.match(JSON.parse(out).reason, /^setup's shim .* is missing: run setup --apply$/);

  for (const bad of [["--dir", d], ["--json"], ["--list", "--dir", d, "--json"], ["--dir", d, "--json", "--bogus"]]) {
    const run = spawnSync(process.execPath, [BIN.agents, ...bad], { env: s.env, encoding: "utf8" });
    assert.equal(run.status, 2, bad.join(" "));
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /^agents: .*\nusage: agents /);
  }
});

// Whether a pid is gone: no such process, or one that has exited and waits
// only to be reaped.
const gone = (pid) => {
  try { return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
};

test("each read has its own limit and all of them a budget: a kernel that hangs is stopped with its children, and a deployment not reached in time says so", async (t) => {
  const s = sandbox(t);
  withFeatures(s);
  const a = deploymentAt(s, "a", [], { souls: [] });
  const b = deploymentAt(s, "b", [], { souls: [] });
  writeFileSync(join(b, "status.mode"), "hang");
  const c = deploymentAt(s, "c", [], { souls: [] });
  listed(s, [{ path: a, name: "a" }, { path: b, name: "b" }, { path: c, name: "c" }]);
  const r = await read(s, ["--list", "--json"], { perReadMs: 1500, budgetMs: 1500 });
  assert.equal(r.status, 0, r.stderr);
  const [da, db, dc] = r.result.deployments;
  assert.equal(da.ok, true);
  assert.equal(db.ok, false);
  assert.deepEqual([dc.ok, dc.workspace], [false, null]);
  assert.match(dc.reason, /^not read: the \d+ s for every deployment ran out$/);
  assert.deepEqual(lines(s, "status-dirs.log"), [a, b], "c is not read");
  const pids = lines(s, "status.pids").flatMap((l) => l.split(" ").map(Number));
  assert.equal(pids.length, 2);
  const end = Date.now() + 5000;
  while (!pids.every(gone) && Date.now() < end) await new Promise((done) => setTimeout(done, 50));
  assert.ok(pids.every(gone), "the kernel and its child are stopped");
});
