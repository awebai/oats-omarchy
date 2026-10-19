// `bin/waiting.mjs` against fakes of `oats status --json` (through the shim
// setup writes), Omarchy's selector, its notifier and its floating terminal
// (test/helpers/sandbox.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachCommand, attachPrefix, DETACH_KEY, waiting, waitingRows } from "../lib/waiting.mjs";
import { sandbox, writeExecutable } from "./helpers/sandbox.mjs";
import { badge, parseWaiting } from "../widget.mjs";

const row = (instance, home, waitingOnYou = null) => ({ agent: "a", instance, home, running: true, waitingOnYou });
const W = { since: "2026-10-16T11:57:35.651Z", producer: "agent", reason: "attention", message: "needs a decision" };

function withStatus(s, agents) {
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ root: s.deployment, agents, features: [], workspace: {} }));
}

// The shim setup writes: the kernel by the recorded node and CLI.
const shimPath = (s) => join(s.home, ".local/share/oats-omarchy/oats");
const writeShim = (s) => writeExecutable(shimPath(s), `#!/bin/sh\nexec '${process.execPath}' '${s.cli}' "$@"\n`);

// waiting() in this process, for the sandbox's deployment (as the menu runs
// it), with the shim in place and stderr captured.
function call(s, args = [], extra = {}, opts = {}) {
  if (!existsSync(shimPath(s))) writeShim(s);
  let stderr = "";
  const argv = args.some((a) => a.startsWith("--dir")) ? args : ["--dir", s.deployment, ...args];
  const status = waiting(argv, { ...s.env, ...extra }, { write: (x) => { stderr += x; } }, opts);
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

test("a choice opens its session in the floating terminal through the shim, with the detach key when the kernel has it", (t) => {
  const s = sandbox(t);
  const { b } = homes(s);
  withStatus(s, [{ name: "y", instances: [row("with space", b, W)] }]);
  const r = call(s, [], { FAKE_SELECT: "first" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(waitFor(join(s.root, "floating.log")), `'${shimPath(s)}' 'session' 'attach' '--detach-key' 'M-o' '--home' '${b}'\n`);
});

test("without the kernel feature the detach key is left out", (t) => {
  const s = sandbox(t);
  const { a } = homes(s);
  withStatus(s, [{ name: "x", instances: [row("alpha", a, W)] }]);
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.50.0", features: ["session-start"] }));
  assert.equal(call(s, [], { FAKE_SELECT: "alpha" }).status, 0);
  assert.equal(waitFor(join(s.root, "floating.log")), `'${shimPath(s)}' 'session' 'attach' '--home' '${a}'\n`);
});

test("without setup's shim, or without the deployment: no selector, a \"(?)\" notification that says why, exit 1", (t) => {
  const s = sandbox(t);
  withStatus(s, []);
  writeShim(s);
  rmSync(shimPath(s));
  let stderr = "";
  assert.equal(waiting(["--dir", s.deployment], s.env, { write: (x) => { stderr += x; } }), 1);
  assert.equal(stderr, `oats-omarchy: setup's shim ${shimPath(s)} is missing: run setup --apply\n`);
  assert.deepEqual(calls(s, "notify.log"), [["Waiting on you (?)", `setup's shim ${shimPath(s)} is missing: run setup --apply`]]);

  const r = call(s, ["--dir", join(s.root, "gone")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--dir .*gone does not exist/);
  assert.deepEqual(calls(s, "select.log"), []);
});

test("the attach command reaches the kernel as argv through the terminal's bash -c, backslash and space intact", (t) => {
  const s = sandbox(t);
  const { b } = homes(s);
  withStatus(s, [{ name: "y", instances: [row("with space", b, W)] }]);
  assert.equal(call(s, [], { FAKE_SELECT: "with space", FAKE_FLOATING_RUN: "1" }).status, 0);
  const log = waitFor(join(s.root, "kernel.log"));
  assert.deepEqual(JSON.parse(log.trim()), ["session", "attach", "--detach-key", "M-o", "--home", b]);
  assert.equal(DETACH_KEY, "M-o");
  assert.equal(attachCommand({ shim: "/s/o ats", home: "/h/it's", detachKey: true }), `'/s/o ats' 'session' 'attach' '--detach-key' 'M-o' '--home' '/h/it'\\''s'`);
  assert.equal(attachCommand({ shim: "/s/oats", home: "/h", detachKey: false }), "'/s/oats' 'session' 'attach' '--home' '/h'");
  // The prefix the bar widget gets: the home goes last.
  assert.deepEqual(attachPrefix({ shim: "/s/oats", detachKey: true }), ["/s/oats", "session", "attach", "--detach-key", "M-o", "--home"]);
  assert.deepEqual(attachPrefix({ shim: "/s/oats", detachKey: false }), ["/s/oats", "session", "attach", "--home"]);
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

// waiting --json in this process: what it prints, and its exit code.
function json(s, args = [], opts = {}) {
  let stdout = "";
  const r = call(s, ["--json", ...args], {}, { ...opts, out: { write: (x) => { stdout += x; } } });
  return { ...r, stdout, result: stdout ? JSON.parse(stdout) : null };
}

test("--json: the count and the rows waiting on you, nothing opened, nothing notified", (t) => {
  const s = sandbox(t);
  const { a, b } = homes(s);
  withStatus(s, [{ name: "x", instances: [row("alpha", a, W), row("idle", "/h/idle")] }, { name: "y", instances: [row("with space", b, W)] }]);
  const r = json(s);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.result, { ok: true, count: 2, rows: [{ instance: "alpha", home: a }, { instance: "with space", home: b }] });
  assert.equal(r.stdout.split("\n").length, 2, "one line");
  assert.equal(badge(parseWaiting(r.stdout)), "2", "what the bar widget shows");
  assert.equal(r.stderr, "");
  assert.deepEqual([calls(s, "select.log"), calls(s, "notify.log")], [[], []]);

  // No row claims to wait: a count of 0, which the widget shows as no badge.
  withStatus(s, [{ name: "x", instances: [row("idle", "/h/idle")] }]);
  assert.deepEqual(json(s).result, { ok: true, count: 0, rows: [] });
  assert.equal(badge(parseWaiting(json(s).stdout)), "", "no badge, no claim");
});

test("--json: a failed read is {ok: false, reason} with the kernel's first line, bounded; exit 1; nothing notified", (t) => {
  const s = sandbox(t);
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ ok: false, error: { message: `${"x".repeat(500)}\nsecond line` } }));
  const r = json(s);
  assert.equal(r.status, 1);
  assert.deepEqual(Object.keys(r.result), ["ok", "reason"]);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.reason.length, 200);
  assert.ok(!r.result.reason.includes("second line"));
  assert.equal(badge(parseWaiting(r.stdout)), "?");
  assert.deepEqual(calls(s, "notify.log"), []);

  writeFileSync(join(s.root, "status.mode"), "hang");
  assert.match(json(s, [], { statusTimeoutMs: 500 }).result.reason, /timed out after 500 ms/);
  assert.match(json(s, ["--dir", join(s.root, "gone")]).result.reason, /--dir .*gone does not exist/);
  rmSync(shimPath(s));
  let stdout = "";
  assert.equal(waiting(["--json", "--dir", s.deployment], s.env, { write: () => {} }, { out: { write: (x) => { stdout += x; } } }), 1);
  assert.deepEqual(JSON.parse(stdout), { ok: false, reason: `setup's shim ${shimPath(s)} is missing: run setup --apply` });
});

test("arguments: --dir, else the working directory; anything else exits 2; --help prints the usage", (t) => {
  const s = sandbox(t);
  withStatus(s, []);
  assert.equal(call(s, [`--dir=${s.deployment}`]).status, 0);
  assert.equal(call(s, ["--bogus"]).status, 2);
  assert.equal(call(s, ["--dir"]).status, 2);
  const fromCwd = s.run(["waiting"]);
  assert.equal(fromCwd.status, 0, fromCwd.stderr);
  const help = s.run(["waiting", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: waiting \[--dir <deployment>\] \[--json\]/);
});
