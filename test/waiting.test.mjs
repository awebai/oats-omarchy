// `oats omarchy waiting` against fakes of `oats status --json`, Omarchy's
// selector, its notifier and its floating terminal (test/helpers/sandbox.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachCommand, DETACH_KEY, waiting, waitingRows } from "../oats-package/capabilities/oats-omarchy/lib/waiting.mjs";
import { sandbox, writeExecutable } from "./helpers/sandbox.mjs";

const row = (instance, home, waitingOnYou = null) => ({ agent: "a", instance, home, running: true, waitingOnYou });
const W = { since: "2026-10-16T11:57:35.651Z", producer: "agent", reason: "attention", message: "needs a decision" };

function withStatus(s, agents) {
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ root: s.deployment, agents, features: [], workspace: {} }));
}

// waiting() in this process, with stderr captured.
function call(s, args = [], extra = {}, opts = {}) {
  let stderr = "";
  const status = waiting(args, { ...s.env, ...extra }, { write: (x) => { stderr += x; } }, opts);
  return { status, stderr };
}

// Each logged call is its arguments, one per line, then "--".
const calls = (s, log) => {
  let text;
  try { text = readFileSync(join(s.root, log), "utf8"); } catch { return []; }
  return text.split("--\n").filter(Boolean).map((c) => c.replace(/\n$/, "").split("\n"));
};

// The floating terminal is started detached: wait for what it leaves.
function waitFor(path, ok = (text) => text.length > 0, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const text = readFileSync(path, "utf8"); if (ok(text)) return text; } catch { /* not yet */ }
    if (Date.now() > end) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function homes(s) {
  const a = join(s.deployment, "agents", "x", "instances", "alpha");
  const b = join(s.deployment, "agents", "y", "instances", "with space");
  for (const d of [a, b]) mkdirSync(d, { recursive: true });
  return { a, b };
}

test("only the rows waiting on you, in the order listed, by instance name", () => {
  const status = { root: "/d", agents: [
    { name: "x", instances: [row("one", "/h/1", W), row("two", "/h/2"), row("three", "/h/3", W)] },
    { name: "y", instances: [] },
    { name: "z" },
    { name: "w", instances: [row("four", "/h/4", { ...W, producer: "oats.core" })] },
  ] };
  assert.deepEqual(waitingRows(JSON.stringify(status)), [
    { instance: "one", home: "/h/1" }, { instance: "three", home: "/h/3" }, { instance: "four", home: "/h/4" },
  ]);
  assert.throws(() => waitingRows(JSON.stringify({ ok: false, error: { message: "boom" } })), /boom/);
  assert.throws(() => waitingRows("{}"), /no agents list/);
  assert.throws(() => waitingRows("not json"));
});

test("the selector shows the count and the names only; a cancel opens nothing and exits 0", (t) => {
  const s = sandbox(t);
  const { a, b } = homes(s);
  withStatus(s, [{ name: "x", instances: [row("alpha", a, W), row("idle", "/h/idle")] }, { name: "y", instances: [row("with space", b, W)] }]);
  const r = call(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s, "select.log"), [["Waiting on you (2)", "alpha", "with space"]]);
  assert.deepEqual(calls(s, "notify.log"), []);
  assert.equal(waitFor(join(s.root, "floating.log"), undefined, 300), null, "nothing opened");
});

test("a choice opens its session in the floating terminal, with the detach key when the kernel has it", (t) => {
  const s = sandbox(t);
  const { b } = homes(s);
  withStatus(s, [{ name: "y", instances: [row("with space", b, W)] }]);
  const r = call(s, ["--soul", "github.com/acme/agents/builder"], { FAKE_SELECT: "first" });
  assert.equal(r.status, 0, r.stderr);
  const line = waitFor(join(s.root, "floating.log"));
  // No shim yet (setup not applied): the kernel by its paths.
  assert.equal(line, `'${process.execPath}' '${s.cli}' session attach --home '${b}' --detach-key 'C-\\'\n`);
});

test("without the kernel feature the detach key is left out; with the shim the shim runs", (t) => {
  const s = sandbox(t);
  const { a } = homes(s);
  withStatus(s, [{ name: "x", instances: [row("alpha", a, W)] }]);
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.50.0", features: ["session-start"] }));
  const shim = join(s.home, ".local/share/oats-omarchy/oats");
  writeExecutable(shim, `#!/bin/sh\nexec '${process.execPath}' '${s.cli}' "$@"\n`);
  assert.equal(call(s, [], { FAKE_SELECT: "alpha" }).status, 0);
  assert.equal(waitFor(join(s.root, "floating.log")), `'${shim}' session attach --home '${a}'\n`);
});

test("the attach command reaches the kernel as argv through the terminal's bash -c, backslash and space intact", (t) => {
  const s = sandbox(t);
  const { b } = homes(s);
  withStatus(s, [{ name: "y", instances: [row("with space", b, W)] }]);
  assert.equal(call(s, [], { FAKE_SELECT: "with space", FAKE_FLOATING_RUN: "1" }).status, 0);
  const log = waitFor(join(s.root, "kernel.log"));
  assert.deepEqual(JSON.parse(log.trim()), ["session", "attach", "--home", b, "--detach-key", "C-\\"]);
  assert.equal(DETACH_KEY, "C-\\");
  assert.equal(attachCommand({ shim: "/s/o ats", home: "/h/it's", detachKey: true }), `'/s/o ats' session attach --home '/h/it'\\''s' --detach-key 'C-\\'`);
});

test("nobody waiting: no selector, Omarchy's notification with the count only, exit 0", (t) => {
  const s = sandbox(t);
  withStatus(s, [{ name: "x", instances: [row("idle", "/h/idle")] }]);
  const r = call(s, [], { FAKE_SELECT: "first" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(s, "notify.log"), [["Waiting on you (0)"]]);
  assert.deepEqual(calls(s, "select.log"), []);
});

for (const [mode, message] of [
  ["envelope", "oats-lock.json is unreadable: Unexpected end of JSON input"],
  ["stderr", "oats: no oats-local.yaml at or above"],
  ["hang", "timed out after 500 ms"],
]) {
  test(`oats status fails (${mode}): no selector, a "(?)" notification with the kernel's first line, the error on stderr, exit 1`, (t) => {
    const s = sandbox(t);
    writeFileSync(join(s.root, "status.mode"), mode);
    const r = call(s, [], { FAKE_SELECT: "first" }, { statusTimeoutMs: 500 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`oats status failed: .*${message.replace(/[.*?]/g, "\\$&")}`));
    const [notified] = calls(s, "notify.log");
    assert.equal(notified[0], "Waiting on you (?)");
    assert.ok(notified[1].includes(message), notified[1]);
    assert.deepEqual(calls(s, "select.log"), []);
  });
}

test("a long kernel error is cut to one bounded line in the notification, and stays whole on stderr", (t) => {
  const s = sandbox(t);
  const long = `${"x".repeat(500)}\nsecond line`;
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ ok: false, error: { message: long } }));
  const r = call(s);
  assert.equal(r.status, 1);
  const [[, description]] = calls(s, "notify.log");
  assert.equal(description.length, 200);
  assert.match(r.stderr, /second line/);
});

test("without omarchy-notification-send: stderr only, same exit codes", (t) => {
  const s = sandbox(t, { launchers: ["omarchy-menu-select", "omarchy-launch-floating-terminal-with-presentation"] });
  withStatus(s, []);
  const zero = call(s);
  assert.equal(zero.status, 0);
  assert.equal(zero.stderr, "oats-omarchy: Waiting on you (0)\n");
  writeFileSync(join(s.root, "status.mode"), "stderr");
  const failed = call(s);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Waiting on you \(\?\): oats: no oats-local\.yaml/);
});

test("arguments: --soul is accepted, anything else exits 2; --help prints the usage", (t) => {
  const s = sandbox(t);
  withStatus(s, []);
  assert.equal(call(s, ["--soul=x/y"]).status, 0);
  assert.equal(call(s, ["--bogus"]).status, 2);
  assert.equal(call(s, ["--soul"]).status, 2);
  const help = s.run(["waiting", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: oats omarchy waiting/);
});
