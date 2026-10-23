// `omarchy-launch-oats` (bin/omarchy-launch-oats, lib/launch.mjs): the window
// it opens, through a stand-in `omarchy-launch-tui` that logs its argv, and
// the window's flow (--in-terminal) against the fake kernel behind setup's
// shim (test/helpers/fake-kernel.mjs). Nothing is launched: no terminal, no
// TUI, no harness, no real `oats session start` or `attach`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ID, deliverPrompt, launch, LAUNCH_SCRIPT, parseArgs } from "../lib/launch.mjs";
import { DETACH_KEY } from "../lib/waiting.mjs";
import { ALL_FEATURES, fakeKernel, gone } from "./helpers/fake-kernel.mjs";
import { fixture, repo, sandbox, writeExecutable } from "./helpers/sandbox.mjs";

const LAUNCHER = join(repo, "bin", "omarchy-launch-oats");
const STATUS = JSON.parse(readFileSync(fixture("steward", "status-0.67.1.json"), "utf8"));
// Every character a shell or an option parser would take for its own.
const TRICKY = "-n 'single' \"double\" $(touch pwned) `touch ticked`; rm -rf ~\nand a second line\n";

// A sandbox with setup's shim (the fake kernel), one listed deployment
// holding a steward at `home`, a runtime directory, and the stand-ins.
function world(t, { features = ALL_FEATURES, kernel = true } = {}) {
  const s = sandbox(t, { node: true });
  const k = kernel ? fakeKernel(s) : null;
  const home = join(s.root, "agents", "oats-machine--steward", "instances", "steward");
  const status = structuredClone(STATUS);
  const agent = status.agents.find((a) => a.name === "oats-machine--steward");
  agent.instances = [{ ...agent.instances[0], home }];
  writeFileSync(join(s.deployment, "status.json"), JSON.stringify(status));
  if (k) {
    writeFileSync(join(k.k, "deployments.json"), JSON.stringify({ deploymentsApi: 1, file: join(s.home, ".oats", "config", "deployments.json"), deployments: [{ path: s.deployment, name: "machine", state: "ok" }], imports: {} }));
    writeFileSync(join(k.k, "version.json"), JSON.stringify({ schemaVersion: 1, name: "@awebai/oats", version: "0.67.1", features }));
  }
  const run = join(s.root, "run");
  mkdirSync(run, { mode: 0o700 });
  const env = { ...s.env, XDG_RUNTIME_DIR: run };
  // Omarchy's launcher: logs its argv; with FAKE_TUI_RUN=1 it runs the
  // command, as the real one does in the terminal (here with no input).
  writeExecutable(join(s.fakebin, "omarchy-launch-tui"), `#!/bin/sh
for a; do printf '%s\\n' "$a"; done >> "${join(s.root, "tui.log")}"
if [ -n "\${FAKE_TUI_RUN:-}" ]; then shift; "$@" < /dev/null > "${join(s.root, "window.out")}" 2>&1; echo "exit $?" >> "${join(s.root, "window.out")}"; fi
exit 0
`);
  const tuiArgs = () => (existsSync(join(s.root, "tui.log")) ? readFileSync(join(s.root, "tui.log"), "utf8").split("\n").slice(0, -1) : null);
  const notified = () => (existsSync(join(s.root, "notify.log")) ? readFileSync(join(s.root, "notify.log"), "utf8") : "");
  return { s, k, home, env, run, tuiArgs, notified };
}

// The command as Omarchy runs it: the sh launcher, with node on PATH.
const outer = (w, args, extra = {}) => spawnSync("/bin/sh", [LAUNCHER, ...args], { env: { ...w.env, ...extra }, cwd: w.s.home, encoding: "utf8", timeout: 30_000 });

// The window's flow, in this process. → { code, err, out, pauses }.
async function inner(w, args = [], { timeouts } = {}) {
  const err = [];
  const out = [];
  let pauses = 0;
  const code = await launch(["--in-terminal", ...args], w.env, { err: { write: (x) => err.push(x) }, out: { write: (x) => out.push(x) }, pause: () => { pauses++; }, timeouts });
  return { code, err: err.join(""), out: out.join(""), pauses };
}

const promptFile = (w, text) => {
  const path = join(w.run, "oats-omarchy-prompt-test");
  writeFileSync(path, text, { mode: 0o600 });
  return path;
};
const argvs = (w) => w.k.calls().map((c) => c.argv);
const set = (w, name, text) => writeFileSync(join(w.k.k, name), text);
async function waitFor(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return check();
}

// ---------------------------------------------------------------------------
// The window.

test("no arguments: one window, omarchy-launch-tui --app-id=org.omarchy.agent <node> <plugin>/bin/launch.mjs --in-terminal", async (t) => {
  const w = world(t);
  const r = outer(w, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const argv = await waitFor(() => w.tuiArgs());
  assert.deepEqual(argv, [`--app-id=${APP_ID}`, process.execPath, join(repo, "bin", "launch.mjs"), "--in-terminal"]);
  assert.equal(LAUNCH_SCRIPT, join(repo, "bin", "launch.mjs"));
  assert.deepEqual(w.k.calls(), [], "the outer process runs no kernel command: the window does");
});

test("--prompt: the text reaches the window in a new 0600 file under XDG_RUNTIME_DIR, never in argv", async (t) => {
  const w = world(t);
  const r = outer(w, ["--prompt", TRICKY]);
  assert.equal(r.status, 0, r.stderr);
  const argv = await waitFor(() => w.tuiArgs());
  assert.deepEqual(argv.slice(0, 4), [`--app-id=${APP_ID}`, process.execPath, LAUNCH_SCRIPT, "--in-terminal"]);
  assert.equal(argv[4], "--prompt-file");
  assert.equal(argv.length, 6);
  const file = argv[5];
  assert.equal(join(w.run, file.slice(w.run.length + 1)), file, "under XDG_RUNTIME_DIR");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), TRICKY);
  assert.ok(!argv.some((a) => a.includes("pwned")), "no part of the prompt in argv");
});

test("--prompt without XDG_RUNTIME_DIR: the file goes in the temporary directory", async (t) => {
  const w = world(t);
  const tmp = join(w.s.root, "tmp");
  mkdirSync(tmp);
  const r = outer(w, ["--prompt", "hello"], { XDG_RUNTIME_DIR: "", TMPDIR: tmp });
  assert.equal(r.status, 0, r.stderr);
  const argv = await waitFor(() => w.tuiArgs());
  assert.equal(argv[5], join(tmp, readdirSync(tmp)[0]));
  assert.equal(readFileSync(argv[5], "utf8"), "hello");
});

test("an empty or blank --prompt, or a bad argument, is refused before any window opens", (t) => {
  const w = world(t);
  for (const args of [["--prompt", ""], ["--prompt", " \n\t"], ["--prompt"], ["--bogus"], ["--prompt-file", "/x"], ["--prompt", "a", "--prompt", "b"]]) {
    const r = outer(w, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /^omarchy-launch-oats: .*\nusage: omarchy-launch-oats /);
  }
  assert.equal(w.tuiArgs(), null);
  assert.equal(readdirSync(w.run).length, 0, "no prompt file left behind");
});

test("parseArgs: a prompt that starts with a dash is the prompt; --prompt=<text> works too", () => {
  assert.deepEqual(parseArgs(["--prompt", "--inline"]), { inline: false, inTerminal: false, prompt: "--inline", promptFile: null });
  assert.equal(parseArgs(["--prompt=-x y"]).prompt, "-x y");
  assert.deepEqual(parseArgs(["--inline", "--in-terminal"]), { error: "--inline runs Omarchy's own agent: it takes no --in-terminal" });
  assert.match(parseArgs(["--in-terminal", "--prompt", "x"]).error, /--prompt is for the launch/);
  assert.match(parseArgs(["--in-terminal", "--prompt-file", "rel"]).error, /absolute/);
});

test("before the window: setup not applied (no shim) says so on stderr and in a notification, exit 1", (t) => {
  const w = world(t, { kernel: false });
  const r = outer(w, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^omarchy-launch-oats: OATS is not set up here \(setup's shim .*oats-omarchy\/oats is missing\): run setup --apply\n$/);
  assert.match(w.notified(), /^Could not open the OATS steward\nOATS is not set up here/);
  assert.equal(w.tuiArgs(), null);
});

test("before the window: no omarchy-launch-tui on PATH, exit 1, notified; a notifier that fails is ignored", (t) => {
  const w = world(t);
  rmSync(join(w.s.fakebin, "omarchy-launch-tui"));
  const line = "omarchy-launch-oats: omarchy-launch-tui is not on PATH: it opens the agent window\n";
  const r = outer(w, []);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, line);
  assert.equal(w.notified(), "Could not open the OATS steward\nomarchy-launch-tui is not on PATH: it opens the agent window\n--\n");
  writeExecutable(join(w.s.fakebin, "omarchy-notification-send"), "#!/bin/sh\necho 'no notification daemon' >&2\nexit 3\n");
  const failing = outer(w, []);
  assert.equal(failing.status, 1);
  assert.equal(failing.stderr, line);
});

test("before the window: a launcher that fails says so, with its own message, notifies, and removes the prompt file", (t) => {
  const w = world(t);
  writeExecutable(join(w.s.fakebin, "omarchy-launch-tui"), "#!/bin/sh\necho 'xdg-terminal-exec: configured terminal could not start' >&2\nexit 1\n");
  const r = outer(w, ["--prompt", "hello"]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "xdg-terminal-exec: configured terminal could not start\nomarchy-launch-oats: omarchy-launch-tui: exited with status 1: no window opened\n");
  assert.equal(w.notified(), "Could not open the OATS steward\nomarchy-launch-tui: exited with status 1: no window opened\n--\n");
  assert.deepEqual(readdirSync(w.run), [], "the prompt file is gone");
});

test("before the window: a launcher still running after the grace period is the open window, left to run", async (t) => {
  const w = world(t);
  const pidFile = join(w.s.root, "tui.pid");
  writeExecutable(join(w.s.fakebin, "omarchy-launch-tui"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 60_000);\n`);
  const err = [];
  const start = Date.now();
  const code = await launch(["--prompt", "hello"], w.env, { err: { write: (x) => err.push(x) }, windowGraceMs: 300 });
  assert.equal(code, 0, err.join(""));
  assert.ok(Date.now() - start < 5_000);
  assert.equal(readdirSync(w.run).length, 1, "the prompt file is the window's to read");
  const pid = Number(readFileSync(pidFile, "utf8"));
  process.kill(pid, 0);
  process.kill(pid, "SIGKILL");
});

test("the sh launcher: node from PATH, else the node setup recorded; with neither, stderr and a notification, exit 1", (t) => {
  const w = world(t);
  const bin = join(w.s.root, "bin-no-node");
  mkdirSync(bin);
  symlinkSync(join(w.s.root, "hostbin", "dirname"), join(bin, "dirname"));
  const env = { ...w.env, PATH: `${w.s.fakebin}:${bin}` };
  const r = spawnSync("/bin/sh", [LAUNCHER, "--help"], { env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "omarchy-launch-oats: Node.js is needed: install it so that node is on your PATH, or run the plugin's setup --apply\n");
  assert.match(w.notified(), /^Could not open the OATS steward\nNode.js is needed/);
  mkdirSync(join(w.env.XDG_STATE_HOME, "oats-omarchy"), { recursive: true });
  writeFileSync(join(w.env.XDG_STATE_HOME, "oats-omarchy", "node"), `${process.execPath}\n`);
  const recorded = spawnSync("/bin/sh", [LAUNCHER, "--help"], { env, encoding: "utf8" });
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /^usage: omarchy-launch-oats /);
  const onPath = outer(w, ["--help"]);
  assert.equal(onPath.status, 0);
  assert.match(onPath.stdout, /^usage: omarchy-launch-oats /);
});

// ---------------------------------------------------------------------------
// In the window.

test("in the window: the steward is found, started, and attached with the detach key, in its deployment", async (t) => {
  const w = world(t);
  const r = await inner(w);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, "");
  assert.equal(r.pauses, 0);
  assert.deepEqual(argvs(w), [
    ["version", "--json"], ["deployments", "--json"], ["status", "--json"],
    ["session", "start", "--home", w.home, "--json"],
    ["session", "attach", "--detach-key", "C-\\", "--home", w.home],
  ]);
  assert.equal(DETACH_KEY, "C-\\");
  assert.deepEqual(w.k.calls().slice(2).map((c) => c.cwd), [w.s.deployment, w.s.deployment, w.s.deployment]);
});

test("in the window: a steward already running (E_SESSION_RUNNING) is attached; without the feature there is no detach key", async (t) => {
  const w = world(t, { features: ["deployments-list"] });
  set(w, "start.mode", "running");
  const r = await inner(w);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(argvs(w).at(-1), ["session", "attach", "--home", w.home]);
});

test("in the window: a start the kernel refuses with another code names the step and its message, waits for Enter, attaches nothing", async (t) => {
  const w = world(t);
  set(w, "start.mode", "envelope:E_LAUNCH_COMMAND_UNSUPPORTED");
  const r = await inner(w);
  assert.equal(r.code, 1);
  assert.equal(r.err, `omarchy-launch-oats: starting the steward (${w.home}): the kernel refused start (E_LAUNCH_COMMAND_UNSUPPORTED)\n`);
  assert.equal(r.out, "Press Enter to close this window.");
  assert.equal(r.pauses, 1);
  assert.ok(!argvs(w).some((a) => a[1] === "attach"));
});

test("in the window: no steward, several, a shim gone and a CLI gone each name the step, and wait for Enter", async (t) => {
  const none = world(t);
  writeFileSync(join(none.s.deployment, "status.json"), JSON.stringify({ ...STATUS, agents: STATUS.agents.filter((a) => a.name !== "oats-machine--steward") }));
  let r = await inner(none);
  assert.equal(r.code, 1);
  assert.equal(r.err, "omarchy-launch-oats: finding the steward: no steward on this machine: spawn one with `oats spawn oats.machine/steward --name steward` in the machine's deployment\n");
  assert.equal(r.pauses, 1);

  const two = world(t);
  const status = JSON.parse(readFileSync(join(two.s.deployment, "status.json"), "utf8"));
  const agent = status.agents.find((a) => a.name === "oats-machine--steward");
  agent.instances.push({ ...agent.instances[0], instance: "steward-2", home: "/h/2" });
  writeFileSync(join(two.s.deployment, "status.json"), JSON.stringify(status));
  r = await inner(two);
  assert.equal(r.err, "omarchy-launch-oats: finding the steward: several stewards on this machine, and none is chosen: steward @ machine, steward-2 @ machine\n");
  assert.ok(!argvs(two).some((a) => a[0] === "session"), "nothing started");

  const noShim = world(t, { kernel: false });
  r = await inner(noShim);
  assert.match(r.err, /^omarchy-launch-oats: finding the steward: setup's shim .* is missing: run setup --apply\n$/);
  assert.equal(r.pauses, 1);

  const cliGone = world(t);
  set(cliGone, "version.mode", "stderr");
  r = await inner(cliGone);
  assert.match(r.err, /^omarchy-launch-oats: finding the steward: oats version --json failed: node:internal.*Cannot find module/);
  assert.equal(r.pauses, 1);
});

test("in the window: a deployment that could not be read is named, and the steward found in another is opened", async (t) => {
  const w = world(t);
  const broken = join(w.s.root, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, "status.mode"), "envelope:E_LOCK");
  writeFileSync(join(w.k.k, "deployments.json"), JSON.stringify({ deploymentsApi: 1, file: "/h/.oats/config/deployments.json", deployments: [{ path: broken, name: "broken", state: "ok" }, { path: w.s.deployment, name: "machine", state: "ok" }], imports: {} }));
  const r = await inner(w);
  assert.equal(r.code, 0);
  assert.equal(r.err, `omarchy-launch-oats: finding the steward: not read: broken (${broken}): the kernel refused status (E_LOCK)\n`);
  assert.equal(r.pauses, 0);
  assert.deepEqual(argvs(w).at(-1), ["session", "attach", "--detach-key", "C-\\", "--home", w.home]);
});

test("in the window: the attach's own exit status passes on (20 is the detach key), a failure says so and waits", async (t) => {
  const w = world(t);
  set(w, "attach.status", "20");
  let r = await inner(w);
  assert.equal(r.code, 20);
  assert.equal(r.pauses, 0);
  set(w, "attach.status", "3");
  r = await inner(w);
  assert.equal(r.code, 3);
  assert.equal(r.err, "omarchy-launch-oats: attaching: oats session attach exited with status 3\n");
  assert.equal(r.pauses, 1);
});

// ---------------------------------------------------------------------------
// The prompt.

test("--prompt end to end: the window reads the file, deletes it, and the kernel gets the exact bytes on stdin, once, then the attach", async (t) => {
  const w = world(t);
  const r = outer(w, ["--prompt", TRICKY], { FAKE_TUI_RUN: "1" });
  assert.equal(r.status, 0, r.stderr);
  const out = await waitFor(() => existsSync(join(w.s.root, "window.out")) && readFileSync(join(w.s.root, "window.out"), "utf8").includes("exit "));
  assert.ok(out, "the window ran");
  const calls = w.k.calls();
  assert.deepEqual(calls.map((c) => c.argv.slice(0, 2).join(" ")), ["version --json", "deployments --json", "status --json", "session start", "session inspect", "session input", "session attach"]);
  const input = calls.find((c) => c.argv[1] === "input");
  assert.deepEqual(input.argv, ["session", "input", "--home", w.home, "--json"], "stdin, never --text-file");
  assert.equal(Buffer.from(input.stdin, "base64").toString("utf8"), TRICKY);
  assert.deepEqual(readdirSync(w.run), [], "the prompt file is gone");
  assert.equal(readFileSync(join(w.s.root, "window.out"), "utf8"), "omarchy-launch-oats: your prompt was sent to the steward\nexit 0\n");
  assert.ok(!existsSync(join(w.s.home, "pwned")) && !existsSync(join(w.s.deployment, "pwned")) && !existsSync(join(w.s.home, "ticked")));
});

test("--prompt: a steward waiting on you gets nothing; the window says so, waits for Enter, then attaches", async (t) => {
  const w = world(t);
  set(w, "inspect.json", JSON.stringify([{ running: true, waitingOnYou: { since: "2026-10-23T10:00:00Z", producer: "oats.core", reason: "permission", message: "Allow Bash?" } }]));
  const r = await inner(w, ["--prompt-file", promptFile(w, "hello")]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "omarchy-launch-oats: the steward is waiting on you (Allow Bash?): your prompt was not sent; attaching\n");
  assert.equal(r.out, "Press Enter to attach to the steward.");
  assert.equal(r.pauses, 1);
  assert.ok(!argvs(w).some((a) => a[1] === "input"));
  assert.equal(argvs(w).at(-1)[1], "attach");
});

test("--prompt: a just-started steward is inspected until it runs, then gets the input; one that never runs gets none", async (t) => {
  const w = world(t);
  set(w, "inspect.json", JSON.stringify([{ running: false, state: "not-launched" }, { running: false }, { running: true }]));
  let r = await inner(w, ["--prompt-file", promptFile(w, "hello")], { timeouts: { poll: 50 } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(argvs(w).map((a) => a[1]).filter((x) => x === "inspect" || x === "input"), ["inspect", "inspect", "inspect", "input"]);

  const never = world(t);
  set(never, "inspect.json", JSON.stringify([{ running: false }]));
  r = await inner(never, ["--prompt-file", promptFile(never, "hello")], { timeouts: { ready: 600, poll: 100 } });
  assert.equal(r.err, "omarchy-launch-oats: sending your prompt: the steward was not running within 1 s: your prompt was not sent\n");
  assert.equal(r.pauses, 1);
  assert.ok(!argvs(never).some((a) => a[1] === "input"));
  assert.equal(argvs(never).at(-1)[1], "attach");
});

test("--prompt: the kernel's answer as it is: verified false is reported, never retried", async (t) => {
  const w = world(t);
  set(w, "input.json", JSON.stringify({ submitted: true, verified: false }));
  const r = await inner(w, ["--prompt-file", promptFile(w, "hello")]);
  assert.equal(r.err, "omarchy-launch-oats: your prompt was sent to the steward (the kernel could not see it arrive; it is not sent again)\n");
  assert.equal(r.pauses, 0);
  assert.equal(argvs(w).filter((a) => a[1] === "input").length, 1);
});

test("--prompt: an input the kernel refuses is reported, not retried; the window waits, then attaches", async (t) => {
  const w = world(t);
  set(w, "input.mode", "envelope:E_SESSION_INPUT_FAILED");
  const r = await inner(w, ["--prompt-file", promptFile(w, "hello")]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "omarchy-launch-oats: sending your prompt: the kernel refused input (E_SESSION_INPUT_FAILED): your prompt was not delivered; type it yourself\n");
  assert.equal(r.pauses, 1);
  assert.equal(argvs(w).filter((a) => a[1] === "input").length, 1);
  assert.equal(argvs(w).at(-1)[1], "attach");
});

test("--prompt: a kernel that cannot say whether the steward is ready gets no input", async (t) => {
  const w = world(t, { features: ["deployments-list", "session-attach-detach-key", "waiting-on-you"] });
  const r = await inner(w, ["--prompt-file", promptFile(w, "hello")]);
  assert.equal(r.err, "omarchy-launch-oats: sending your prompt: this OATS CLI cannot say whether the steward is ready for it (it lacks session-inspect-running; update it): your prompt was not sent\n");
  assert.ok(!argvs(w).some((a) => a[1] === "inspect" || a[1] === "input"));
  assert.equal(argvs(w).at(-1)[1], "attach");
});

test("--prompt: a prompt file that cannot be read is reported first, nothing is sent, and the steward is still opened", async (t) => {
  const w = world(t);
  const r = await inner(w, ["--prompt-file", join(w.run, "missing")]);
  assert.equal(r.code, 0);
  assert.match(r.err, /^omarchy-launch-oats: reading your prompt: ENOENT: no such file or directory, open '.*missing': your prompt was not sent\n$/);
  assert.equal(r.pauses, 1);
  assert.ok(!argvs(w).some((a) => a[1] === "input"));
  assert.equal(argvs(w).at(-1)[1], "attach");
});

test("deliverPrompt alone: the inspect then the input, with the text on stdin", async (t) => {
  const w = world(t);
  const sent = await deliverPrompt({ shim: w.k.shim, home: w.home, text: TRICKY, env: w.env, cwd: w.s.deployment, features: ALL_FEATURES });
  assert.deepEqual(sent, { delivered: true, line: "your prompt was sent to the steward" });
  const calls = w.k.calls();
  assert.deepEqual(calls.map((c) => c.argv), [["session", "inspect", "--home", w.home, "--json"], ["session", "input", "--home", w.home, "--json"]]);
  assert.equal(Buffer.from(calls[1].stdin, "base64").toString("utf8"), TRICKY);
});

// Every kernel call the window adds, hanging with a child: ended at its
// bound, the kernel and its child gone, the step named.
for (const [cmd, line] of [
  ["version", /^omarchy-launch-oats: finding the steward: oats version --json failed: timed out after 400 ms\n/],
  ["start", /^omarchy-launch-oats: starting the steward \(.*\): timed out after 400 ms\n/],
  ["inspect", /^omarchy-launch-oats: sending your prompt: the steward's session could not be inspected: timed out after 400 ms: your prompt was not sent\n/],
  ["input", /^omarchy-launch-oats: sending your prompt: timed out after 400 ms: it may or may not have gone in, and it is not sent again\n/],
]) test(`a hanging session ${cmd} is ended at its bound with its child, and the window says so`, async (t) => {
  const w = world(t);
  set(w, `${cmd}.mode`, "hang");
  const start = Date.now();
  const r = await inner(w, ["--prompt-file", promptFile(w, "hello")], { timeouts: { version: 400, start: 400, inspect: 400, input: 400, ready: 5000 } });
  assert.ok(Date.now() - start < 15_000);
  assert.match(r.err, line);
  assert.equal(r.pauses, 1);
  const pids = readFileSync(join(w.k.k, `${cmd}.pids`), "utf8").trim().split(/\s+/).map(Number);
  assert.equal(pids.length, 2);
  assert.ok(await gone(pids), "the kernel and its child are gone");
  if (cmd === "input") assert.equal(argvs(w).filter((a) => a[1] === "input").length, 1, "never sent twice");
});

// ---------------------------------------------------------------------------
// --inline: Omarchy's own agent, here, with the terminal's signals left to it.

function withAgent(w, body) {
  writeExecutable(join(w.s.fakebin, "omarchy-agent"), `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(join(w.s.root, "agent.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
writeFileSync(${JSON.stringify(join(w.s.root, "agent.pid"))}, String(process.pid));
${body}
`);
}

test("--inline runs omarchy-agent --inline, the prompt one argv element, and passes on its exit status", (t) => {
  const w = world(t);
  withAgent(w, "process.exit(7);");
  const r = outer(w, ["--inline", "--prompt", TRICKY]);
  assert.equal(r.status, 7, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(w.s.root, "agent.log"), "utf8")), ["--inline", "--prompt", TRICKY]);
  assert.equal(w.tuiArgs(), null, "no window");
  assert.deepEqual(readdirSync(w.run), [], "no prompt file");
  const plain = outer(w, ["--prompt", "x", "--inline"]);
  assert.equal(plain.status, 7);
  assert.deepEqual(JSON.parse(readFileSync(join(w.s.root, "agent.log"), "utf8").trim().split("\n")[1]), ["--inline", "--prompt", "x"]);
});

test("--inline: an agent killed by a signal ends this command by the same signal", (t) => {
  const w = world(t);
  withAgent(w, "process.kill(process.pid, 'SIGTERM');");
  const r = outer(w, ["--inline"]);
  assert.equal(r.signal, "SIGTERM");
});

test("--inline: SIGINT and SIGQUIT are left to the agent; SIGTERM and SIGHUP are passed on to it", async (t) => {
  const w = world(t);
  withAgent(w, `for (const s of ["SIGINT", "SIGQUIT"]) process.on(s, () => appendFileSync(${JSON.stringify(join(w.s.root, "agent.log"))}, s + "\\n"));
process.on("SIGHUP", () => { appendFileSync(${JSON.stringify(join(w.s.root, "agent.log"))}, "SIGHUP\\n"); process.exit(5); });
setInterval(() => {}, 1000);`);
  for (const [signal, expect] of [["SIGTERM", { code: null, signal: "SIGTERM" }], ["SIGHUP", { code: 5, signal: null }]]) {
    const child = spawn("/bin/sh", [LAUNCHER, "--inline"], { env: w.env, stdio: "ignore" });
    const ended = new Promise((r) => child.once("exit", (code, sig) => r({ code, signal: sig })));
    assert.ok(await waitFor(() => existsSync(join(w.s.root, "agent.pid"))), "the agent started");
    child.kill("SIGINT");
    child.kill("SIGQUIT");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(child.exitCode, null, "SIGINT and SIGQUIT do not end this command");
    child.kill(signal);
    assert.deepEqual(await ended, expect, signal);
    rmSync(join(w.s.root, "agent.pid"));
  }
  const log = readFileSync(join(w.s.root, "agent.log"), "utf8");
  assert.ok(!/SIGINT|SIGQUIT/.test(log), "this command does not pass the terminal's signals on: the terminal sends them to the agent itself");
  assert.match(log, /SIGHUP/, "SIGHUP reached the agent");
});

test("--inline without omarchy-agent on PATH says so, exit 1", (t) => {
  const w = world(t);
  const r = outer(w, ["--inline"]);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "omarchy-launch-oats: omarchy-agent is not on PATH: --inline runs Omarchy's own agent\n");
});
