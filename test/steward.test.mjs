// findSteward (lib/steward.mjs): the machine's steward, from the kernel's own
// `oats deployments --json` and `oats status --json` (fixtures in
// test/fixtures/steward, shaped like 0.67.1's), through setup's shim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths as discoverPaths } from "../lib/discover.mjs";
import { STATE_SCHEMA } from "../lib/state.mjs";
import { findSteward, stewardsIn } from "../lib/steward.mjs";
import { STEWARD_AGENT, STEWARD_KEY } from "../lib/steward-agent.mjs";
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
  assert.deepEqual(stewardsIn(JSON.stringify(STATUS)), [{ instance: "steward", home: STEWARD_HOME, address: null }]);
  const decoy = { ...STATUS.agents[0], name: "helper", instances: [{ ...STATUS.agents[0].instances[0], instance: "steward", home: "/h/helper/steward" }] };
  assert.deepEqual(stewardsIn(JSON.stringify(status({ extra: [decoy] }))), [{ instance: "steward", home: STEWARD_HOME, address: null }]);
  assert.deepEqual(stewardsIn(JSON.stringify(status({ stewards: [] }))), []);
  assert.throws(() => stewardsIn(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_LOCK", message: "oats-lock.json is unreadable" } })), /oats-lock.json is unreadable/);
});

test("stewardsIn: the agent row's soul key decides when it has one; its name only when the key is absent or null", () => {
  const steward = STATUS.agents.find((a) => a.name === STEWARD_AGENT);
  assert.equal(steward.key, STEWARD_KEY, "the fixture's row carries the real key");
  const instance = { ...steward.instances[0], instance: "other", home: "/h/other" };
  // A row named like the steward's agent whose key is another soul: never taken.
  const decoy = { ...steward, key: "acme.tools/steward", instances: [instance] };
  assert.deepEqual(stewardsIn(JSON.stringify({ ...STATUS, agents: [STATUS.agents[0], decoy] })), []);
  // Without a key (null, or absent from an older kernel), the name decides.
  for (const key of [null, undefined]) {
    const row = { ...steward, instances: [instance] };
    if (key === null) row.key = null; else delete row.key;
    assert.deepEqual(stewardsIn(JSON.stringify({ ...STATUS, agents: [row] })), [{ instance: "other", home: "/h/other", address: null }], String(key));
  }
  // The key is matched even under another agent name.
  const renamed = { ...steward, name: "something-else", instances: [instance] };
  assert.deepEqual(stewardsIn(JSON.stringify({ ...STATUS, agents: [renamed] })), [{ instance: "other", home: "/h/other", address: null }]);
  assert.throws(() => stewardsIn("{}"), /no agents list/);
});

test("one steward in the list's deployments: its home, and the deployment it is in; status runs in each deployment", async (t) => {
  const w = world(t, { a: STATUS, b: status({ stewards: [] }) });
  const found = await w.find();
  assert.deepEqual(found, { ok: true, instance: "steward", home: STEWARD_HOME, address: null, deployment: { path: w.paths[0], name: "machine" }, unread: [] });
  const calls = w.k.calls();
  assert.deepEqual(calls.map((c) => c.argv.join(" ")), ["version --json", "deployments --json", "status --json", "status --json"]);
  assert.deepEqual(calls.slice(2).map((c) => c.cwd), w.paths);
});

test("no steward: how to spawn one; a deployment that could not be read is named", async (t) => {
  const w = world(t, { a: status({ stewards: [] }), b: status({ stewards: [] }) });
  assert.deepEqual(await w.find(), { ok: false, none: true, reason: "no steward on this machine: spawn one with `oats spawn oats.machine/steward` in the machine's deployment" });
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
  assert.deepEqual(await w.find(), { ok: true, instance: "steward", home: STEWARD_HOME, address: null, deployment: { path: w.paths[0], name: w.paths[0] }, unread: [] });
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

// The launcher's fast path (recordedFirst): the deployment setup's state
// records, read first; the full scan whenever that is inconclusive.
function recorded(w, path) {
  const dir = discoverPaths(w.s.env).stateDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: STATE_SCHEMA, files: [], deployment: path }));
}
const statusReads = (w) => w.k.calls().filter((c) => c.argv.join(" ") === "status --json").map((c) => c.cwd);
const listReads = (w) => w.k.calls().filter((c) => c.argv.join(" ") === "deployments --json").length;

test("recordedFirst: one steward in the recorded deployment is taken from one status read, without the list or the others", async (t) => {
  // A second steward elsewhere: the fast path does not see it (the full
  // scan, without recordedFirst, reports both).
  const w = world(t, { a: STATUS, b: status({ stewards: [["second", "/h/second"]] }) });
  recorded(w, w.paths[0]);
  assert.deepEqual(await w.find({ recordedFirst: true }), { ok: true, instance: "steward", home: STEWARD_HOME, address: null, deployment: { path: w.paths[0], name: w.paths[0] }, unread: [] });
  assert.deepEqual(statusReads(w), [w.paths[0]]);
  assert.equal(listReads(w), 0);
  const full = await w.find();
  assert.equal(full.ok, false);
  assert.match(full.reason, /^several stewards on this machine/);
});

test("recordedFirst: none, or several, in the recorded deployment: the full scan, which reads it once", async (t) => {
  const none = world(t, { a: status({ stewards: [] }), b: STATUS });
  recorded(none, none.paths[0]);
  const found = await none.find({ recordedFirst: true });
  assert.equal(found.ok, true);
  assert.deepEqual(found.deployment, { path: none.paths[1], name: "acme" });
  assert.deepEqual(statusReads(none), none.paths, "the recorded one is not read again");
  assert.equal(listReads(none), 1);

  const two = world(t, { a: status({ stewards: [["one", "/h/one"], ["two", "/h/two"]] }), b: status({ stewards: [] }) });
  recorded(two, two.paths[0]);
  const several = await two.find({ recordedFirst: true });
  assert.equal(several.ok, false);
  assert.match(several.reason, /^several stewards on this machine, and none is chosen: one @ machine, two @ machine/);
});

test("recordedFirst: a recorded deployment whose status cannot be read is named by the full scan, from the one read", async (t) => {
  const w = world(t, { a: "envelope:E_LOCK", b: STATUS });
  recorded(w, w.paths[0]);
  const found = await w.find({ recordedFirst: true });
  assert.equal(found.ok, true);
  assert.equal(found.instance, "steward");
  assert.equal(found.unread.length, 1);
  assert.match(found.unread[0], /E_LOCK/);
  assert.deepEqual(statusReads(w), w.paths);
});

test("recordedFirst: no recorded deployment, or no list: as without it", async (t) => {
  const w = world(t, { a: STATUS, b: status({ stewards: [] }) });
  assert.equal((await w.find({ recordedFirst: true })).deployment.name, "machine", "no state: the list's name");
  const old = world(t, { a: STATUS, features: ["session-inspect-running", "waiting-on-you"] });
  recorded(old, old.paths[0]);
  const found = await old.find({ recordedFirst: true });
  assert.equal(found.ok, true);
  assert.deepEqual(statusReads(old), [old.paths[0]], "read once, as the state's one deployment");
});

// The steward's address: the row's `identityAddress` (the kernel's
// desktop-facts) when it is an aweb namespace/alias and the kernel
// advertises desktop-facts; a bare alias (a local identity), or none, is no
// address.
test("stewardsIn: the address is the row's identityAddress in namespace/alias form, else null", () => {
  const withAddress = (identityAddress) => status({ stewards: [["steward", STEWARD_HOME]] }).agents.map((a) => (a.name === STEWARD_AGENT ? { ...a, instances: a.instances.map((i) => ({ ...i, identityAddress })) } : a));
  const rowOf = (identityAddress, features = ALL_FEATURES) => stewardsIn(JSON.stringify({ ...STATUS, agents: withAddress(identityAddress) }), features)[0];
  assert.deepEqual(rowOf("merak.aweb.ai/steward"), { instance: "steward", home: STEWARD_HOME, address: "merak.aweb.ai/steward" });
  assert.equal(rowOf("steward").address, null, "a local identity's alias is not an address");
  assert.equal(rowOf(null).address, null);
  assert.equal(rowOf(undefined).address, null, "a row without identityAddress");
  assert.equal(rowOf(7).address, null);
  assert.equal(rowOf("merak.aweb.ai/steward", ALL_FEATURES.filter((f) => f !== "desktop-facts")).address, null, "a kernel without desktop-facts");
  assert.equal(stewardsIn(JSON.stringify({ ...STATUS, agents: withAddress("merak.aweb.ai/steward") }))[0].address, null, "features not given");
});

test("findSteward: the address only from a kernel that advertises desktop-facts", async (t) => {
  const row = (s) => ({ ...s, agents: s.agents.map((a) => (a.name === STEWARD_AGENT ? { ...a, instances: a.instances.map((i) => ({ ...i, identityAddress: "merak.aweb.ai/steward" })) } : a)) });
  const facts = world(t, { a: row(STATUS), b: status({ stewards: [] }) });
  assert.equal((await facts.find()).address, "merak.aweb.ai/steward");
  recorded(facts, facts.paths[0]);
  assert.equal((await facts.find({ recordedFirst: true })).address, "merak.aweb.ai/steward", "the launcher's fast path");
  const old = world(t, { a: row(STATUS), b: status({ stewards: [] }), features: ALL_FEATURES.filter((f) => f !== "desktop-facts") });
  assert.equal((await old.find()).address, null);
  recorded(old, old.paths[0]);
  assert.equal((await old.find({ recordedFirst: true })).address, null, "the launcher's fast path");
});
