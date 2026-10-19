// What the OATS picker (OatsPicker.qml) decides, in picker.mjs: the
// sections it builds from `agents --json`, the filter, the section it opens
// on and its words. The QML only lays these out (test/widget-qml.test.mjs
// loads it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../picker.mjs";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const W = { since: "2026-10-19T11:58:00Z", producer: "agent", reason: "attention", message: "needs a decision" };
const inst = (instance, extra = {}) => ({ agent: "writer", instance, home: `/h/${instance}`, running: true, waitingOnYou: null, ...extra });
const soul = (key, extra = {}) => ({ key, name: key, description: `${key} does things`, spawnable: true, problem: null, instances: 0, ...extra });
const answer = (deployments, features = { waitingOnYou: true, soulCounts: true }) => JSON.stringify({ ok: true, features, deployments });
const dep = (path, name, workspace, agents, souls = []) => ({ path, name, workspace, ok: true, agents, souls });

test("one deployment: the three sections, ungrouped; a waiting agent is a card and an agent row; a soul counts its instances", () => {
  const view = P.parseAgents(answer([dep("/d", "d", "w", [inst("a", { waitingOnYou: W }), inst("b", { running: false }), inst("c", { running: null })], [soul("writer", { instances: 1 }), soul("reviewer", { instances: 3 })])]), NOW);
  assert.equal(view.known, true);
  assert.deepEqual(view.waiting.map(({ search: _, ...r }) => r), [{ kind: "waiting", group: "", label: "a", subtitle: "writer", home: "/h/a", deployment: "/d", key: "", where: "d", running: "running", waiting: true, message: "needs a decision", meta: "attention · agent · 2 min", since: W.since, act: true }]);
  assert.deepEqual(view.agents.map((r) => [r.label, r.running, r.waiting, r.message]), [["a", "running", true, "needs a decision"], ["b", "stopped", false, ""], ["c", "unknown", false, ""]]);
  assert.deepEqual(view.souls.map((r) => [r.label, r.subtitle, r.meta, r.act, r.deployment]), [["writer", "writer does things", "1 instance", true, "/d"], ["reviewer", "reviewer does things", "3 instances", true, "/d"]]);
  assert.equal(P.defaultSection(view), "waiting");
  assert.equal(P.sectionTitle(view, "waiting"), "Waiting on you (1)");
  assert.equal(P.sectionTitle(view, "agents"), "Agents");
});

test("several deployments: grouped by workspace; a name two deployments share says its deployment; a failed one is a note and the rest are listed", () => {
  const view = P.parseAgents(answer([
    dep("/p/one", "one", "github.com/acme/agents", [inst("x")], [soul("writer")]),
    dep("/p/two", "two", "github.com/acme/agents", [inst("x"), inst("y")], null),
    { path: "/p/bad", name: "bad", workspace: null, ok: false, reason: "oats-lock.json is unreadable" },
    dep("/p/other", "other", null, [inst("z")]),
  ]), NOW);
  assert.deepEqual(view.agents.map((r) => [r.group, r.label, r.deployment]), [
    ["github.com/acme/agents", "x (one)", "/p/one"], ["github.com/acme/agents", "x (two)", "/p/two"], ["github.com/acme/agents", "y", "/p/two"], ["other", "z", "/p/other"],
  ]);
  assert.deepEqual(view.notes, ["bad: oats-lock.json is unreadable"]);
  assert.deepEqual(P.notes(view, "agents"), ["bad: oats-lock.json is unreadable"]);
  assert.deepEqual(P.notes(view, "souls"), ["bad: oats-lock.json is unreadable", "two: its souls could not be read"]);
  assert.deepEqual(view.souls.map((r) => [r.group, r.label, r.deployment]), [["github.com/acme/agents", "writer", "/p/one"]]);
  assert.equal(P.defaultSection(view), "agents", "nobody said they wait: the agents");
});

test("two deployments of one workspace offering the same soul: each row says where it spawns, by name, or by path when the names match too", () => {
  const writer = () => [soul("writer", { description: "Writes." })];
  const view = P.parseAgents(answer([
    dep("/deploy/dev", "dev", "acme/team", [inst("w-1")], writer()),
    dep("/deploy/prod", "prod", "acme/team", [inst("w-1")], writer().concat([soul("only-prod")])),
  ]), NOW);
  assert.deepEqual(view.souls.map((r) => [r.group, r.label, r.key, r.deployment]), [
    ["acme/team", "writer (dev)", "writer", "/deploy/dev"],
    ["acme/team", "writer (prod)", "writer", "/deploy/prod"],
    ["acme/team", "only-prod", "only-prod", "/deploy/prod"],
  ]);
  assert.deepEqual(view.agents.map((r) => r.label), ["w-1 (dev)", "w-1 (prod)"]);
  assert.deepEqual(P.filterRows(view, "souls", "writer prod").map((r) => r.deployment), ["/deploy/prod"], "the deployment's name is searched");

  const twins = P.parseAgents(answer([
    dep("/a/oats", "oats", "acme/team", [inst("x")], writer()),
    dep("/b/oats", "oats", "acme/team", [inst("x")], writer()),
  ]), NOW);
  assert.deepEqual(twins.souls.map((r) => [r.label, r.deployment]), [["writer (/a/oats)", "/a/oats"], ["writer (/b/oats)", "/b/oats"]]);
  assert.deepEqual(twins.agents.map((r) => r.label), ["x (/a/oats)", "x (/b/oats)"]);

  // In different workspaces the group already tells them apart.
  const apart = P.parseAgents(answer([dep("/1", "one", "w1", [], writer()), dep("/2", "two", "w2", [], writer())]), NOW);
  assert.deepEqual(apart.souls.map((r) => [r.group, r.label]), [["w1", "writer"], ["w2", "writer"]]);
});

test("never \"nobody is waiting\": the empty Waiting section says no agent has said so, or that the CLI does not report it", () => {
  const quiet = P.parseAgents(answer([dep("/d", "d", "w", [inst("a")])]), NOW);
  assert.equal(P.emptyText(quiet, "waiting", ""), "No agent has said it is waiting on you");
  const old = P.parseAgents(answer([dep("/d", "d", "w", [inst("a", { waitingOnYou: W })])], { waitingOnYou: false, soulCounts: false }), NOW);
  assert.deepEqual(old.waiting, [], "a claim the CLI does not vouch for is not shown");
  assert.equal(P.emptyText(old, "waiting", ""), "This OATS CLI does not report who is waiting on you (it lacks the feature waiting-on-you)");
  assert.equal(P.sectionTitle(old, "waiting"), "Waiting on you");
  for (const section of P.SECTIONS) for (const view of [quiet, old, { known: false, reason: "x" }]) assert.doesNotMatch(P.emptyText(view, section, ""), /nobody|no one/i);
  assert.equal(P.emptyText(quiet, "agents", "zz"), "No matches for “zz”");
  assert.equal(P.emptyText(quiet, "souls", ""), "No souls");
});

test("an unspawnable soul shows the kernel's problem and does not act; no counts without the feature", () => {
  const view = P.parseAgents(answer([dep("/d", "d", "w", [], [soul("r", { spawnable: false, problem: { code: "E_TEAM_UNKNOWN", message: "team is not declared" }, instances: null })])], { waitingOnYou: true, soulCounts: false }), NOW);
  assert.deepEqual(view.souls.map((r) => [r.message, r.meta, r.act]), [["team is not declared", "", false]]);
});

test("the read failed, or printed nothing: unknown, with the reason; nothing to list", () => {
  assert.deepEqual(P.parseAgents(JSON.stringify({ ok: false, reason: "no deployment could be read: a: x" }), NOW), { known: false, reason: "no deployment could be read: a: x" });
  assert.deepEqual(P.parseAgents("", NOW), { known: false, reason: "agents --json printed no result" });
  assert.deepEqual(P.parseAgents('{"ok":tr', NOW).known, false);
  const unknown = P.parseAgents("", NOW);
  assert.deepEqual([P.filterRows(unknown, "agents", ""), P.notes(unknown, "agents"), P.defaultSection(unknown)], [[], [], "agents"]);
  const note = P.parseAgents(JSON.stringify({ ok: true, features: {}, deployments: [], note: "This computer's list holds no deployment to read: …" }), NOW);
  assert.deepEqual(note.notes, ["This computer's list holds no deployment to read: …"]);
});

test("the filter: every word typed, in any case, over the name, the agent, the group, the message and the soul", () => {
  const view = P.parseAgents(answer([dep("/d", "d", "w", [inst("Alpha", { waitingOnYou: W }), inst("beta", { agent: "reviewer" })], [soul("oats.okf/knowledge-maintainer")])]), NOW);
  assert.deepEqual(P.filterRows(view, "agents", "").map((r) => r.label), ["Alpha", "beta"]);
  assert.deepEqual(P.filterRows(view, "agents", "ALPHA").map((r) => r.label), ["Alpha"]);
  assert.deepEqual(P.filterRows(view, "agents", "review").map((r) => r.label), ["beta"]);
  assert.deepEqual(P.filterRows(view, "agents", "alpha decision").map((r) => r.label), ["Alpha"]);
  assert.deepEqual(P.filterRows(view, "agents", "alpha beta"), []);
  assert.deepEqual(P.filterRows(view, "souls", "okf  knowledge").map((r) => r.key), ["oats.okf/knowledge-maintainer"]);
  assert.deepEqual(P.filterRows(view, "waiting", "attention").map((r) => r.label), ["Alpha"]);
});

test("the payload picks the section; Tab and Shift+Tab go round; the read is the plugin's agents command with --json", () => {
  assert.equal(P.requestedSection('{"section":"souls"}'), "souls");
  assert.equal(P.requestedSection('{"section":"waiting"}'), "waiting");
  for (const p of ["{}", "", '{"section":"bogus"}', "not json", "null", '"souls"']) assert.equal(P.requestedSection(p), "", p);
  assert.equal(P.nextSection("waiting", 1), "agents");
  assert.equal(P.nextSection("souls", 1), "waiting");
  assert.equal(P.nextSection("waiting", -1), "souls");
  assert.equal(P.nextSection("bogus", 1), "agents");
  assert.deepEqual(P.readArgv({ agents: ["n", "a.mjs", "--list"] }), ["n", "a.mjs", "--list", "--json"]);
  assert.equal(P.readArgv({ agents: null }), null, "a setup from before the picker: setup only");
  assert.equal(P.readArgv(null), null);
  assert.ok(P.READ_TIMEOUT_MS > 110_000, "after the reader's own budget");
});

test("picker.mjs and widget.mjs stay QML JavaScript modules: no Node import, no optional chaining, no arrow functions", () => {
  for (const file of ["picker.mjs", "widget.mjs"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const imports = [...text.matchAll(/^import .* from "(.*)"/gm)].map((m) => m[1]);
    assert.ok(imports.every((i) => i.startsWith("./")), `${file}: ${imports}`);
    assert.doesNotMatch(text.replace(/\/\/.*$/gm, ""), /\?\.|=>/, file);
  }
});
