// findSteward (lib/steward.mjs): the machine's steward, from the kernel's own
// `oats deployments --json` and `oats status --json` (fixtures in
// test/fixtures/steward, shaped like 0.67.1's), through setup's shim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findSteward, STEWARD_AGENT, stewardsIn } from "../lib/steward.mjs";
import { ALL_FEATURES, fakeKernel, gone } from "./helpers/fake-kernel.mjs";
import { fixture, sandbox } from "./helpers/sandbox.mjs";

const STATUS = JSON.parse(readFileSync(fixture("steward", "status-0.67.1.json"), "utf8"));
const DEPLOYMENTS = JSON.parse(readFileSync(fixture("steward", "deployments-0.67.1.json"), "utf8")).result;
const STEWARD_HOME = "/home/person/Machine/agents/oats-machine--steward/instances/steward";

// The fixture's status with the steward agent's instances replaced (none,
// or several), and other agents added.
function status({ stewards, extra = [] } = {}) {
  const out = structuredClone(STATUS);
  const agent = out.agents.find((a) => a.name === STEWARD_AGENT);
  const template = agent.instances[0];
  if (stewards) agent.instances = stewards.map(([instance, home]) => ({ ...template, instance, home }));
  out.agents.push(...extra);
  return out;
}

// Two deployments (the fixture's list, with this sandbox's paths) whose
// status is `a` and `b` (an object, or a mode such as "envelope:E_LOCK").
function world(t, { a, b, features = ALL_FEATURES, states = ["ok", "ok"] } = {}) {
  const s = sandbox(t);
  const k = fakeKernel(s);
  const paths = [join(s.root, "machine"), join(s.root, "work", "acme")];
  const rows = DEPLOYMENTS.deployments.map((row, i) => ({ ...row, path: paths[i], state: states[i] }));
  writeFileSync(join(k.k, "deployments.json"), JSON.stringify({ ...DEPLOYMENTS, deployments: rows }));
  writeFileSync(join(k.k, "version.json"), JSON.stringify({ schemaVersion: 1, name: "@awebai/oats", version: "0.67.1", features }));
  for (const [path, given] of [[paths[0], a], [paths[1], b]]) {
    mkdirSync(path, { recursive: true });
    if (typeof given === "string") writeFileSync(join(path, "status.mode"), given);
    else if (given) writeFileSync(join(path, "status.json"), JSON.stringify(given));
  }
  return { s, k, paths, find: (opts) => findSteward(s.env, opts) };
}

test("STEWARD_AGENT is the agent name the kernel gives oats.machine/steward", () => {
  // awebai/oats lib/workspace.mjs packageSoulAgentName (0.67.1).
  const packageSoulAgentName = (id, soul) => `${String(id).replace(/[^a-z0-9-]/g, "-")}--${soul}`;
  assert.equal(STEWARD_AGENT, packageSoulAgentName("oats.machine", "steward"));
});

test("stewardsIn: the steward agent's instances only, not an instance named steward elsewhere", () => {
  assert.deepEqual(stewardsIn(JSON.stringify(STATUS)), [{ instance: "steward", home: STEWARD_HOME }]);
  const decoy = { ...STATUS.agents[0], name: "helper", instances: [{ ...STATUS.agents[0].instances[0], instance: "steward", home: "/h/helper/steward" }] };
  assert.deepEqual(stewardsIn(JSON.stringify(status({ extra: [decoy] }))), [{ instance: "steward", home: STEWARD_HOME }]);
  assert.deepEqual(stewardsIn(JSON.stringify(status({ stewards: [] }))), []);
  assert.throws(() => stewardsIn(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_LOCK", message: "oats-lock.json is unreadable" } })), /oats-lock.json is unreadable/);
  assert.throws(() => stewardsIn("{}"), /no agents list/);
});

test("one steward in the list's deployments: its home, and the deployment it is in; status runs in each deployment", async (t) => {
  const w = world(t, { a: STATUS, b: status({ stewards: [] }) });
  const found = await w.find();
  assert.deepEqual(found, { ok: true, instance: "steward", home: STEWARD_HOME, deployment: { path: w.paths[0], name: "machine" }, unread: [] });
  const calls = w.k.calls();
  assert.deepEqual(calls.map((c) => c.argv.join(" ")), ["version --json", "deployments --json", "status --json", "status --json"]);
  assert.deepEqual(calls.slice(2).map((c) => c.cwd), w.paths);
});

test("no steward: how to spawn one; a deployment that could not be read is named", async (t) => {
  const w = world(t, { a: status({ stewards: [] }), b: status({ stewards: [] }) });
  assert.deepEqual(await w.find(), { ok: false, reason: "no steward on this machine: spawn one with `oats spawn oats.machine/steward --name steward` in the machine's deployment" });
  const failed = world(t, { a: status({ stewards: [] }), b: "envelope:E_LOCK" });
  const r = await failed.find();
  assert.equal(r.ok, false);
  assert.match(r.reason, /^no steward on this machine: spawn one with .*; not read: acme \(.*\/work\/acme\): the kernel refused status \(E_LOCK\)$/);
});

test("a deployment whose status fails does not hide a steward found in another one, and is named", async (t) => {
  const w = world(t, { a: "envelope:E_LOCK", b: status({ stewards: [["steward", "/h/acme/steward"]] }) });
  const r = await w.find();
  assert.equal(r.ok, true);
  assert.equal(r.home, "/h/acme/steward");
  assert.equal(r.deployment.name, "acme");
  assert.deepEqual(r.unread, [`machine (${w.paths[0]}): the kernel refused status (E_LOCK)`]);
  const several = world(t, { a: "envelope:E_LOCK", b: status({ stewards: [["steward", "/h/1"], ["steward-2", "/h/2"]] }) });
  assert.deepEqual(await several.find(), { ok: false, reason: `several stewards on this machine, and none is chosen: steward @ acme, steward-2 @ acme; not read: machine (${several.paths[0]}): the kernel refused status (E_LOCK)` });
});

test("several stewards, in one deployment or two: listed, and none is picked", async (t) => {
  const two = world(t, { a: status({ stewards: [["steward", "/h/1"], ["steward-2", "/h/2"]] }) });
  assert.deepEqual(await two.find(), { ok: false, reason: "several stewards on this machine, and none is chosen: steward @ machine, steward-2 @ machine" });
  const apart = world(t, { a: STATUS, b: status({ stewards: [["steward", "/h/acme/steward"]] }) });
  assert.deepEqual(await apart.find(), { ok: false, reason: "several stewards on this machine, and none is chosen: steward @ machine, steward @ acme" });
});

test("a listed deployment the kernel marks other than ok is not read", async (t) => {
  const w = world(t, { a: STATUS, b: STATUS, states: ["ok", "missing"] });
  assert.equal((await w.find()).ok, true);
  assert.deepEqual(w.k.calls().filter((c) => c.argv[0] === "status").map((c) => c.cwd), [w.paths[0]]);
});

test("an empty list says how to fill it; a list the kernel refuses is the reason", async (t) => {
  const w = world(t);
  writeFileSync(join(w.k.k, "deployments.json"), JSON.stringify({ ...DEPLOYMENTS, deployments: [] }));
  assert.match((await w.find()).reason, /^no steward on this machine: spawn one .* \(this computer's list holds no deployment: run any oats command in a deployment, or `oats deployments add <path>`\)$/);
  writeFileSync(join(w.k.k, "deployments.mode"), "envelope:E_DEPLOYMENTS_INVALID");
  assert.deepEqual(await w.find(), { ok: false, reason: "the kernel refused deployments (E_DEPLOYMENTS_INVALID)" });
});

test("a kernel without deployments-list: the deployment setup's state records, else a reason", async (t) => {
  const w = world(t, { a: STATUS, features: ["session-attach-detach-key"] });
  assert.deepEqual(await w.find(), { ok: false, reason: "this OATS CLI keeps no list of deployments, and setup's state records none: run setup --apply" });
  const stateDir = join(w.s.env.XDG_STATE_HOME, "oats-omarchy");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ schemaVersion: 1, deployment: w.paths[0], files: [] }));
  assert.deepEqual(await w.find(), { ok: true, instance: "steward", home: STEWARD_HOME, deployment: { path: w.paths[0], name: w.paths[0] }, unread: [] });
  assert.ok(!w.k.calls().some((c) => c.argv[0] === "deployments"), "the list is not asked for");
});

test("no shim, or a shim whose CLI is gone", async (t) => {
  const s = sandbox(t);
  const r = await findSteward(s.env);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^setup's shim .*oats-omarchy\/oats is missing: run setup --apply$/);
  const w = world(t);
  writeFileSync(join(w.k.k, "version.mode"), "stderr");
  assert.match((await w.find()).reason, /^oats version --json failed: node:internal.*Cannot find module/);
});

for (const [what, set] of [
  ["version --json", (w) => writeFileSync(join(w.k.k, "version.mode"), "hang")],
  ["deployments --json", (w) => writeFileSync(join(w.k.k, "deployments.mode"), "hang")],
  ["status --json", (w) => writeFileSync(join(w.paths[0], "status.mode"), "hang")],
]) test(`a ${what} that hangs is ended at its bound, with its child`, async (t) => {
  const w = world(t, { a: STATUS });
  set(w);
  const start = Date.now();
  const r = await w.find({ timeoutMs: 400 });
  assert.ok(Date.now() - start < 10_000);
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out after 400 ms/);
  const cmd = what.split(" ")[0];
  const pids = readFileSync(join(w.k.k, `${cmd}.pids`), "utf8").trim().split(/\s+/).map(Number);
  assert.equal(pids.length, 2);
  assert.ok(await gone(pids), "the kernel and its child are gone");
});
