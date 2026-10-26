// `omarchy-launch-oats` (bin/omarchy-launch-oats, lib/launch.mjs): the window
// it opens, through a stand-in `omarchy-launch-tui` that logs its argv, and
// the window's flow (--in-terminal) against the fake kernel behind setup's
// shim (test/helpers/fake-kernel.mjs). Nothing is launched: no terminal, no
// TUI, no harness, no real `oats session start` or `attach`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ID, deliverPrompt, findWindow, launch, LAUNCH_LOCK, LAUNCH_SCRIPT, LOCK_BUSY, parseArgs } from "../lib/launch.mjs";
import { paths as discoverPaths } from "../lib/discover.mjs";
import { STATE_SCHEMA } from "../lib/state.mjs";
import { DETACH_KEY } from "../lib/waiting.mjs";
import { ALL_FEATURES, fakeKernel, gone } from "./helpers/fake-kernel.mjs";
import { fixture, repo, sandbox, writeExecutable } from "./helpers/sandbox.mjs";

const LAUNCHER = join(repo, "bin", "omarchy-launch-oats");
// The launch lock is flock(1), util-linux's: Linux, where the plugin runs.
const REAL_FLOCK = ["/usr/bin/flock", "/bin/flock"].find((f) => existsSync(f)) || null;
const lockSkip = REAL_FLOCK ? false : "flock(1) is util-linux's and this host has none: CI on Linux runs the lock itself";
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
  // Without the host's flock (macOS), a stand-in that runs the command and
  // excludes nothing, so the rest of the launcher is tested; the lock's own
  // behaviour is tested only with the real one (lockSkip).
  if (!REAL_FLOCK) writeExecutable(join(s.fakebin, "flock"), `#!/bin/sh
while [ $# -gt 0 ]; do case $1 in -w) shift 2 ;; -o | -n) shift ;; *) break ;; esac; done
shift; exec "$@"
`);
  const env = { ...s.env, XDG_RUNTIME_DIR: run };
  // Omarchy's launcher: logs its argv and, as the window does when it
  // starts, claims the handoff, keeps what the prompt file held
  // (prompt.seen, and its mode and its directory's in prompt.ls) and
  // removes the handoff. With FAKE_TUI_RUN=1 it runs the command instead,
  // as the real one does in the terminal (here with no input), and ends
  // with its status.
  writeExecutable(join(s.fakebin, "omarchy-launch-tui"), `#!/bin/sh
for a; do printf '%s\\n' "$a"; done >> "${join(s.root, "tui.log")}"
claim=; prompt=; prev=
for a; do
  [ "$prev" = --claim-file ] && claim=$a
  [ "$prev" = --prompt-file ] && prompt=$a
  prev=$a
done
if [ -n "\${FAKE_TUI_RUN:-}" ]; then
  shift; "$@" < /dev/null > "${join(s.root, "window.out")}" 2>&1; status=$?
  echo "exit $status" >> "${join(s.root, "window.out")}"; exit $status
fi
if [ -n "$claim" ]; then (set -C; echo window > "$claim") 2>/dev/null || exit 0; fi
if [ -n "$prompt" ]; then cp "$prompt" "${join(s.root, "prompt.seen")}"; ls -ln "$prompt" > "${join(s.root, "prompt.ls")}"; ls -lnd "$(dirname "$prompt")" >> "${join(s.root, "prompt.ls")}"; fi
[ -n "$claim" ] && rm -rf "$(dirname "$claim")"
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
// What is in the runtime directory but the launch lock's file, which flock
// keeps there by design (the lock is the flock on it, never the file).
const runtimeEntries = (w) => readdirSync(w.run).filter((f) => f !== LAUNCH_LOCK);
const set = (w, name, text) => writeFileSync(join(w.k.k, name), text);
async function waitFor(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return check();
}

// ---------------------------------------------------------------------------
// The window.

test("no arguments: one window, omarchy-launch-tui --app-id=org.omarchy.agent <node> <plugin>/bin/launch.mjs --in-terminal, and the handoff it marks", async (t) => {
  const w = world(t);
  const r = outer(w, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const argv = w.tuiArgs();
  assert.deepEqual(argv.slice(0, 5), [`--app-id=${APP_ID}`, process.execPath, join(repo, "bin", "launch.mjs"), "--in-terminal", "--claim-file"]);
  assert.equal(argv.length, 6);
  assert.match(argv[5], new RegExp(`^${w.run}/oats-omarchy-launch-[^/]+/claim$`), "under XDG_RUNTIME_DIR");
  assert.equal(LAUNCH_SCRIPT, join(repo, "bin", "launch.mjs"));
  assert.deepEqual(w.k.calls(), [], "the outer process runs no kernel command: the window does");
  assert.deepEqual(runtimeEntries(w), [], "the window removed the handoff it claimed");
});

test("--prompt: the text reaches the window in a new 0600 file in a private directory under XDG_RUNTIME_DIR, never in argv", (t) => {
  const w = world(t);
  const r = outer(w, ["--prompt", TRICKY]);
  assert.equal(r.status, 0, r.stderr);
  const argv = w.tuiArgs();
  assert.deepEqual(argv.slice(0, 5), [`--app-id=${APP_ID}`, process.execPath, LAUNCH_SCRIPT, "--in-terminal", "--claim-file"]);
  assert.equal(argv[6], "--prompt-file");
  assert.equal(argv.length, 8);
  assert.equal(argv[7], join(argv[5], "..", "prompt"));
  assert.match(argv[7], new RegExp(`^${w.run}/oats-omarchy-launch-[^/]+/prompt$`));
  assert.equal(readFileSync(join(w.s.root, "prompt.seen"), "utf8"), TRICKY);
  const [file, dir] = readFileSync(join(w.s.root, "prompt.ls"), "utf8").split("\n");
  assert.match(file, /^-rw------- /);
  assert.match(dir, /^drwx------ /);
  assert.ok(!argv.some((a) => a.includes("pwned")), "no part of the prompt in argv");
  assert.deepEqual(runtimeEntries(w), []);
});

test("without a usable XDG_RUNTIME_DIR, or without flock, nothing opens and the notification says what is missing", (t) => {
  const w = world(t);
  for (const runtime of ["", "relative", join(w.s.root, "gone")]) {
    const r = outer(w, ["--prompt", "hello"], { XDG_RUNTIME_DIR: runtime });
    assert.equal(r.status, 1, JSON.stringify(runtime));
    const line = "$XDG_RUNTIME_DIR is not a directory: the launch lock lives there, so nothing was opened";
    assert.equal(r.stderr, `omarchy-launch-oats: ${line}: your prompt was not sent\n`);
    assert.ok(w.notified().endsWith(`Could not open the OATS steward\n${line}: your prompt was not sent\n--\n`));
  }
  const noFlock = join(w.s.root, "no-flock");
  mkdirSync(noFlock);
  for (const dir of [w.s.fakebin, join(w.s.root, "hostbin")]) for (const f of readdirSync(dir)) if (f !== "flock") symlinkSync(join(dir, f), join(noFlock, f));
  const r = outer(w, [], { PATH: noFlock });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "omarchy-launch-oats: flock is not on PATH (util-linux): the launch lock needs it, so nothing was opened\n");
  assert.equal(w.tuiArgs(), null, "no window, ever, without the lock");
});

test("an empty or blank --prompt, or a bad argument, is refused before any window opens", (t) => {
  const w = world(t);
  for (const args of [["--prompt", ""], ["--prompt", " \n\t"], ["--prompt"], ["--bogus"], ["--prompt-file", "/x"], ["--prompt", "a", "--prompt", "b"]]) {
    const r = outer(w, args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /^omarchy-launch-oats: .*\nusage: omarchy-launch-oats /);
  }
  assert.equal(w.tuiArgs(), null);
  assert.equal(runtimeEntries(w).length, 0, "no prompt file left behind");
});

test("parseArgs: a prompt that starts with a dash is the prompt; --prompt=<text> works too", () => {
  assert.deepEqual(parseArgs(["--prompt", "--inline"]), { inline: false, inTerminal: false, prompt: "--inline", promptFile: null, claimFile: null });
  assert.match(parseArgs(["--claim-file", "/x"]).error, /--claim-file is the window's own/);
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

// A stand-in launcher, a node script, that does `body` (with `claim` and
// `prompt`, the paths it was given, and `log(line)`).
function launcherDoing(w, body) {
  writeExecutable(join(w.s.fakebin, "omarchy-launch-tui"), `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const claim = after("--claim-file");
const prompt = after("--prompt-file");
const log = (line) => appendFileSync(${JSON.stringify(join(w.s.root, "launcher.log"))}, line + "\\n");
${body}
`);
}
const launcherLog = (w) => (existsSync(join(w.s.root, "launcher.log")) ? readFileSync(join(w.s.root, "launcher.log"), "utf8") : "");

test("before the window: a launcher that fails at once says so after its own message, notifies, and removes the handoff", (t) => {
  const w = world(t);
  writeExecutable(join(w.s.fakebin, "omarchy-launch-tui"), "#!/bin/sh\necho 'xdg-terminal-exec: configured terminal could not start' >&2\nexit 1\n");
  const r = outer(w, ["--prompt", "hello"]);
  assert.equal(r.status, 1);
  const line = "omarchy-launch-tui: exited with status 1 before the window started: your prompt was not sent";
  assert.equal(r.stderr, `xdg-terminal-exec: configured terminal could not start\nomarchy-launch-oats: ${line}\n`);
  assert.equal(w.notified(), `Could not open the OATS steward\n${line}\n--\n`);
  assert.deepEqual(runtimeEntries(w), [], "the handoff and the prompt are gone");
});

test("before the window: a launcher that fails later, but before the window claims the handoff, is a failure too", (t) => {
  const w = world(t);
  launcherDoing(w, "setTimeout(() => { console.error('terminal: could not connect to the display'); process.exit(1); }, 3300);");
  const r = outer(w, []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /omarchy-launch-oats: omarchy-launch-tui: exited with status 1 before the window started\n$/);
  assert.match(w.notified(), /^Could not open the OATS steward\n/);
  assert.deepEqual(runtimeEntries(w), []);
});

test("a window that started and ended at once (detached with Ctrl+\\, status 20) is a launch that worked", (t) => {
  const w = world(t);
  set(w, "attach.status", "20");
  const r = outer(w, [], { FAKE_TUI_RUN: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(w.notified(), "");
  assert.equal(readFileSync(join(w.s.root, "window.out"), "utf8"), "exit 20\n");
});

test("a launcher that hands the window to a service and ends with 0: the window's claim decides", (t) => {
  const w = world(t);
  launcherDoing(w, `const { spawn } = require("node:child_process");
// The service: reads the prompt, then marks the handoff, after this ends.
const later = "setTimeout(() => { const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'window', { flag: 'wx' }); fs.rmSync(require('node:path').dirname(process.argv[1]), { recursive: true }); }, 500)";
spawn(process.execPath, ["-e", later, claim], { detached: true, stdio: "ignore" }).unref();
process.exit(0);`);
  const r = outer(w, ["--prompt", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.notified(), "");
  assert.deepEqual(runtimeEntries(w), []);
});

test("a launcher still running with no claim from the window by the deadline: the window did not start; the prompt is withdrawn", async (t) => {
  const w = world(t);
  launcherDoing(w, "log(String(process.pid)); setTimeout(() => {}, 60_000);");
  const err = [];
  const code = await launch(["--prompt", "hello"], w.env, { err: { write: (x) => err.push(x) }, windowStartMs: 600 });
  assert.equal(code, 1);
  assert.equal(err.join(""), "omarchy-launch-oats: omarchy-launch-tui: the window did not start within 1 s: your prompt was not sent\n");
  assert.match(w.notified(), /did not start within 1 s/);
  assert.deepEqual(runtimeEntries(w), [], "the prompt is withdrawn");
  process.kill(Number(launcherLog(w).trim()), "SIGKILL");
});

test("a launcher still running once the window claimed the handoff is the open window, left to run", async (t) => {
  const w = world(t);
  launcherDoing(w, "log(String(process.pid)); setTimeout(() => { writeFileSync(claim, 'window', { flag: 'wx' }); log(readFileSync(prompt, 'utf8')); require('node:fs').rmSync(require('node:path').dirname(claim), { recursive: true }); }, 200); setTimeout(() => {}, 60_000);");
  const code = await launch(["--prompt", "hello"], w.env, { err: { write: () => {} }, windowStartMs: 10_000 });
  assert.equal(code, 0);
  const [pid, seen] = launcherLog(w).trim().split("\n");
  assert.equal(seen, "hello");
  process.kill(Number(pid), 0);
  process.kill(Number(pid), "SIGKILL");
  assert.deepEqual(runtimeEntries(w), []);
});

test("a window claim that only the deadline sees (after the last poll) is a window that started; the handoff is the window's", async (t) => {
  const w = world(t);
  launcherDoing(w, "writeFileSync(claim, 'window\\n', { flag: 'wx' }); log(String(process.pid)); setTimeout(() => {}, 60_000);");
  const code = await launch(["--prompt", "hello"], w.env, { err: { write: () => {} }, windowStartMs: 3000, pollMs: 60_000 });
  assert.equal(code, 0);
  const [handoff] = runtimeEntries(w);
  assert.equal(readFileSync(join(w.run, handoff, "claim"), "utf8"), "window\n", "the launch did not take it back");
  assert.equal(readFileSync(join(w.run, handoff, "prompt"), "utf8"), "hello", "nor remove the window's prompt");
  process.kill(Number(launcherLog(w).trim()), "SIGKILL");
});

test("a window that starts after the launch gave up sends nothing: the launch's claim comes first", async (t) => {
  const w = world(t);
  const err = [];
  const code = await launch(["--prompt", TRICKY], { ...w.env, FAKE_TUI_RUN: "1" }, { err: { write: (x) => err.push(x) }, windowStartMs: 1 });
  assert.equal(code, 1);
  assert.equal(err.join(""), "omarchy-launch-oats: omarchy-launch-tui: the window did not start within 0 s: your prompt was not sent\n");
  const out = await waitFor(() => existsSync(join(w.s.root, "window.out")) && readFileSync(join(w.s.root, "window.out"), "utf8").includes("exit ") && readFileSync(join(w.s.root, "window.out"), "utf8"));
  assert.equal(out, "omarchy-launch-oats: reading your prompt: the launch gave up waiting for this window: your prompt was not sent\nPress Enter to attach to the steward.exit 0\n");
  assert.ok(!argvs(w).some((a) => a[1] === "input"), "never sent");
  assert.equal(argvs(w).at(-1)[1], "attach", "the steward is still opened");
});

test("in the window: a handoff the launch already claimed is left alone, and its prompt is not sent", async (t) => {
  const w = world(t);
  const handoff = join(w.run, "oats-omarchy-launch-test");
  mkdirSync(handoff, { mode: 0o700 });
  writeFileSync(join(handoff, "prompt"), "hello", { mode: 0o600 });
  writeFileSync(join(handoff, "claim"), "launch\n");
  const r = await inner(w, ["--claim-file", join(handoff, "claim"), "--prompt-file", join(handoff, "prompt")]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "omarchy-launch-oats: reading your prompt: the launch gave up waiting for this window: your prompt was not sent\n");
  assert.ok(!argvs(w).some((a) => a[1] === "input"));
  assert.equal(readFileSync(join(handoff, "claim"), "utf8"), "launch\n");
});

test("in the window: a --claim-file passed by hand in a directory that is not a handoff leaves that directory alone", async (t) => {
  const w = world(t);
  const mine = join(w.s.root, "documents");
  mkdirSync(mine);
  writeFileSync(join(mine, "keep.txt"), "mine");
  writeFileSync(join(mine, "prompt"), "hello");
  const r = await inner(w, ["--claim-file", join(mine, "claim"), "--prompt-file", join(mine, "prompt")]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readdirSync(mine).sort(), ["claim", "keep.txt"], "only the prompt it read is removed");
  const lookalike = join(w.run, "oats-omarchy-launch-x");
  mkdirSync(lookalike);
  writeFileSync(join(lookalike, "keep.txt"), "mine");
  await inner(w, ["--claim-file", join(lookalike, "claim")]);
  assert.deepEqual(readdirSync(lookalike).sort(), ["claim", "keep.txt"]);
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

test("in the window: the deployment setup's state records is read first, and with its one steward the list is not read", async (t) => {
  const w = world(t);
  const stateDir = discoverPaths(w.env).stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ schemaVersion: STATE_SCHEMA, files: [], deployment: w.s.deployment }));
  const r = await inner(w);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(argvs(w), [
    ["version", "--json"], ["status", "--json"],
    ["session", "start", "--home", w.home, "--json"],
    ["session", "attach", "--detach-key", "C-\\", "--home", w.home],
  ]);
  assert.equal(w.k.calls()[1].cwd, w.s.deployment);
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
  assert.deepEqual(runtimeEntries(w), [], "the prompt and the handoff are gone");
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

test("--prompt: the wait for a running steward is bounded in all, slow inspects included; a late yes is not taken", async (t) => {
  const w = world(t);
  set(w, "inspect.json", JSON.stringify([{ running: false }, { running: false }, { running: true }]));
  set(w, "inspect.delay", "400");
  const start = Date.now();
  const sent = await deliverPrompt({ shim: w.k.shim, home: w.home, text: "hello", env: w.env, cwd: w.s.deployment, features: ALL_FEATURES, timeouts: { ready: 1000, inspect: 800, poll: 50 } });
  const took = Date.now() - start;
  assert.deepEqual(sent, { delivered: false, line: "sending your prompt: the steward was not running within 1 s: your prompt was not sent" });
  assert.ok(took < 1600, `the third inspect is ended at the deadline (${took} ms)`);
  assert.ok(!argvs(w).some((a) => a[1] === "input"));

  const slowYes = world(t);
  set(slowYes, "inspect.delay", "300");
  const ok = await inner(slowYes, ["--prompt-file", promptFile(slowYes, "hello")], { timeouts: { ready: 1000, inspect: 800, poll: 50 } });
  assert.equal(ok.err, "omarchy-launch-oats: your prompt was sent to the steward\n");
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

// A failed inspect may be transient: tried again after the poll interval,
// within the 20 s budget; the input is never tried again.
for (const [name, first] of [["an error envelope", "envelope:E_SESSION_BUSY"], ["a non-zero exit with no envelope", "stderr"]]) {
  test(`deliverPrompt: an inspect that fails once (${name}), then answers running, is tried again, and the prompt is sent`, async (t) => {
    const w = world(t);
    set(w, "inspect.modes", JSON.stringify([first, ""]));
    const sent = await deliverPrompt({ shim: w.k.shim, home: w.home, text: "hello", env: w.env, cwd: w.s.deployment, features: ALL_FEATURES, timeouts: { poll: 50 } });
    assert.deepEqual(sent, { delivered: true, line: "your prompt was sent to the steward" });
    assert.deepEqual(argvs(w).map((a) => a[1]), ["inspect", "inspect", "input"]);
  });
}

test("deliverPrompt: an inspect that keeps failing is tried until the deadline, which names the failure; nothing is sent", async (t) => {
  const w = world(t);
  set(w, "inspect.mode", "envelope:E_SESSION_BUSY");
  const start = Date.now();
  const sent = await deliverPrompt({ shim: w.k.shim, home: w.home, text: "hello", env: w.env, cwd: w.s.deployment, features: ALL_FEATURES, timeouts: { poll: 100, ready: 1500 } });
  assert.deepEqual(sent, { delivered: false, line: "sending your prompt: the steward's session could not be inspected within 2 s: the kernel refused inspect (E_SESSION_BUSY): your prompt was not sent" });
  assert.ok(Date.now() - start < 5000);
  const kinds = argvs(w).map((a) => a[1]);
  assert.ok(kinds.length >= 2 && kinds.every((k) => k === "inspect"), kinds.join(" "));
});

test("deliverPrompt: a failed input is never sent again", async (t) => {
  const w = world(t);
  set(w, "input.mode", "envelope:E_SESSION_BUSY");
  const sent = await deliverPrompt({ shim: w.k.shim, home: w.home, text: "hello", env: w.env, cwd: w.s.deployment, features: ALL_FEATURES, timeouts: { poll: 50 } });
  assert.equal(sent.delivered, false);
  assert.deepEqual(argvs(w).map((a) => a[1]), ["inspect", "input"]);
});

// Every kernel call the window adds, hanging with a child: ended at its
// bound, the kernel and its child gone, the step named. The bound leaves a
// node child room to start, and write its pids, on a loaded host.
const HANG_MS = 2000;
for (const [cmd, line] of [
  ["version", new RegExp(`^omarchy-launch-oats: finding the steward: oats version --json failed: timed out after ${HANG_MS} ms\n`)],
  ["start", new RegExp(`^omarchy-launch-oats: starting the steward \\(.*\\): timed out after ${HANG_MS} ms\n`)],
  // Retried until the readiness deadline: each hanging read ended at its bound.
  ["inspect", new RegExp(`^omarchy-launch-oats: sending your prompt: the steward's session could not be inspected within 5 s: timed out after ${HANG_MS} ms: your prompt was not sent\n`)],
  ["input", new RegExp(`^omarchy-launch-oats: sending your prompt: timed out after ${HANG_MS} ms: it may or may not have gone in, and it is not sent again\n`)],
]) test(`a hanging session ${cmd} is ended at its bound with its child, and the window says so`, async (t) => {
  const w = world(t);
  set(w, `${cmd}.mode`, "hang");
  const start = Date.now();
  // Only the hanging call has the tight bound: the others, which answer, have
  // room to on a loaded host.
  const r = await inner(w, ["--prompt-file", promptFile(w, "hello")], { timeouts: { version: 5000, start: 5000, inspect: 5000, input: 5000, [cmd]: HANG_MS, ready: 5000 } });
  assert.ok(Date.now() - start < 15_000);
  assert.match(r.err, line);
  assert.equal(r.pauses, 1);
  const pids = readFileSync(join(w.k.k, `${cmd}.pids`), "utf8").trim().split(/\s+/).map(Number);
  // A kernel and its child per read: the inspect is read again until the deadline.
  if (cmd === "inspect") assert.ok(pids.length >= 4 && pids.length % 2 === 0, String(pids.length));
  else assert.equal(pids.length, 2);
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
  assert.deepEqual(runtimeEntries(w), [], "no prompt file");
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

// ---------------------------------------------------------------------------
// Launch or focus: the key finds the steward's window by its own app-id in
// `hyprctl clients -j` and focuses it; only without one does it open a window.

// A stand-in `hyprctl` that answers as Hyprland v0.56.2's does (its
// src/debug/HyprCtl.cpp and hyprctl/src/main.cpp): `clients -j` prints the
// clients from test/fixtures/hyprctl, and `dispatch` replies "ok" or the
// dispatcher's error, exiting 0 either way (hyprctl exits non-zero only for
// a reply that starts with "error:", or when it reaches no Hyprland). Under
// a Lua config `dispatch <x>` is `hl.dispatch(<x>)`, so the hyprlang form is
// a Lua error with Hyprland's note; under hyprlang the Lua form is an
// unknown dispatcher. It logs each call's argv, one per line, then "--".
const LUA_NOTE = "\n\n → Note: dispatch in lua is a shorthand for hl.dispatch(...), your syntax might need to be updated.";
function hyprland(w, { clients = "clients-steward.json", config = "lua", running = true, lua, legacy } = {}) {
  const h = join(w.s.root, "hypr");
  mkdirSync(h, { recursive: true });
  if (clients) writeFileSync(join(h, "clients.json"), readFileSync(fixture("hyprctl", clients)));
  const replies = config === "lua"
    ? { lua: "ok", legacy: `[string "return hl.dispatch(focuswindow address:0x55d0c2c19a40)"]:1: ')' expected near 'address'${LUA_NOTE}` }
    : { lua: "Invalid dispatcher", legacy: "ok" };
  writeFileSync(join(h, "lua.reply"), lua ?? replies.lua);
  writeFileSync(join(h, "legacy.reply"), legacy ?? replies.legacy);
  writeExecutable(join(w.s.fakebin, "hyprctl"), `#!/bin/sh
for a; do printf '%s\\n' "$a"; done >> "${join(h, "calls.log")}"; echo -- >> "${join(h, "calls.log")}"
${running ? "" : "echo 'HYPRLAND_INSTANCE_SIGNATURE was not set! (Is Hyprland running?) (3)'; exit 3"}
case "$1 $2" in
  "clients -j") cat "${join(h, "clients.json")}" ;;
  "dispatch hl.dsp.focus("*) cat "${join(h, "lua.reply")}"; echo ;;
  "dispatch focuswindow") cat "${join(h, "legacy.reply")}"; echo ;;
  *) echo "unexpected: $*"; exit 1 ;;
esac
exit 0
`);
  return { calls: () => (existsSync(join(h, "calls.log")) ? readFileSync(join(h, "calls.log"), "utf8").split("--\n").slice(0, -1).map((c) => c.split("\n").slice(0, -1)) : []) };
}
const STEWARD_WINDOW = "0x55d0c2c19a40";
const LUA_FOCUS = ["dispatch", `hl.dsp.focus({ window = "address:${STEWARD_WINDOW}" })`];

test("the steward's window has an app-id of its own, inside Omarchy's org.omarchy.* terminal windows", () => {
  assert.equal(APP_ID, "org.omarchy.agent.oats-steward");
});

test("findWindow: the steward's window from real hyprctl clients -j output, by its class alone", () => {
  const read = (name) => readFileSync(fixture("hyprctl", name), "utf8");
  assert.equal(findWindow(read("clients-steward.json")), STEWARD_WINDOW, "beside another org.omarchy.agent window");
  assert.equal(findWindow(read("clients-no-steward.json")), null, "an Omarchy agent window is not the steward's");
  assert.equal(findWindow(read("clients-none.json")), null);
  const steward = JSON.parse(read("clients-steward.json")).find((c) => c.class === APP_ID);
  assert.equal(findWindow(JSON.stringify([{ ...steward, title: "merak:steward", class: "org.omarchy.agent" }])), null, "never by its title");
  assert.equal(findWindow(JSON.stringify([{ ...steward, address: '0x1" }) os.execute("touch pwned") --' }])), null, "an address that is not Hyprland's hex is never dispatched");
  for (const junk of ["", "not json", "{}", "null", "[null, 3]"]) assert.equal(findWindow(junk), null, JSON.stringify(junk));
});

test("a second press: the steward's window is focused with Hyprland's Lua dispatcher, and no window or session opens", (t) => {
  const w = world(t);
  const h = hyprland(w);
  const r = outer(w, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(h.calls(), [["clients", "-j"], LUA_FOCUS]);
  assert.equal(w.tuiArgs(), null, "no second window");
  assert.deepEqual(w.k.calls(), [], "no kernel call: no new viewer session");
  assert.equal(w.notified(), "");
  assert.deepEqual(runtimeEntries(w), [], "no handoff");
});

test("a second press under a hyprlang config: the Lua form is an unknown dispatcher, so focuswindow focuses it", (t) => {
  const w = world(t);
  const h = hyprland(w, { config: "hyprlang" });
  const r = outer(w, []);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.calls(), [["clients", "-j"], LUA_FOCUS, ["dispatch", "focuswindow", `address:${STEWARD_WINDOW}`]]);
  assert.equal(w.tuiArgs(), null);
});

test("a steward's window that Hyprland will not focus is reported, and no second window opens", (t) => {
  const w = world(t);
  hyprland(w, { lua: "error: no such window", legacy: `no such window${LUA_NOTE}` });
  const r = outer(w, []);
  assert.equal(r.status, 1);
  const line = "the steward's window is open, but Hyprland did not focus it: no such window";
  assert.equal(r.stderr, `omarchy-launch-oats: ${line}\n`);
  assert.equal(w.notified(), `Could not open the OATS steward\n${line}\n--\n`);
  assert.equal(w.tuiArgs(), null);
  assert.deepEqual(w.k.calls(), []);
});

test("with only another org.omarchy.agent window, or none, or no Hyprland to ask, the key opens the steward's window", (t) => {
  for (const [name, opts] of [["another agent", { clients: "clients-no-steward.json" }], ["no windows", { clients: "clients-none.json" }], ["no Hyprland", { running: false }]]) {
    const w = world(t);
    const h = hyprland(w, opts);
    const r = outer(w, []);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stderr, "", name);
    assert.deepEqual(h.calls(), [["clients", "-j"]], name);
    assert.equal(w.tuiArgs()[0], `--app-id=${APP_ID}`, name);
  }
  const w = world(t);
  const r = outer(w, []);
  assert.equal(r.status, 0, "no hyprctl on PATH: " + r.stderr);
  assert.equal(w.tuiArgs()[0], `--app-id=${APP_ID}`);
});

test("--prompt with the steward's window open: focused, then the prompt is sent from the launch, once, and the result notified", (t) => {
  const w = world(t);
  const h = hyprland(w);
  const r = outer(w, ["--prompt", TRICKY]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.calls(), [["clients", "-j"], LUA_FOCUS]);
  assert.equal(w.tuiArgs(), null, "no second window");
  const calls = w.k.calls();
  assert.deepEqual(calls.map((c) => c.argv.slice(0, 2).join(" ")), ["version --json", "deployments --json", "status --json", "session inspect", "session input"], "no start and no attach: the window has the viewer");
  const input = calls.find((c) => c.argv[1] === "input");
  assert.deepEqual(input.argv, ["session", "input", "--home", w.home, "--json"]);
  assert.equal(Buffer.from(input.stdin, "base64").toString("utf8"), TRICKY);
  assert.equal(r.stderr, "omarchy-launch-oats: your prompt was sent to the steward\n");
  assert.equal(w.notified(), "OATS steward\nyour prompt was sent to the steward\n--\n");
  assert.deepEqual(runtimeEntries(w), [], "no handoff: the prompt never touched a file");
  assert.ok(!existsSync(join(w.s.home, "pwned")) && !existsSync(join(w.s.home, "ticked")));
});

test("--prompt with the steward's window open and the steward waiting on you: focused, nothing sent, and the notification says so", (t) => {
  const w = world(t);
  hyprland(w);
  set(w, "inspect.json", JSON.stringify([{ running: true, waitingOnYou: { since: "2026-10-23T10:00:00Z", producer: "oats.core", reason: "permission", message: "Allow Bash?" } }]));
  const r = outer(w, ["--prompt", "hello"]);
  assert.equal(r.status, 1);
  const line = "the steward is waiting on you (Allow Bash?): your prompt was not sent; type it in the steward's window";
  assert.equal(r.stderr, `omarchy-launch-oats: ${line}\n`);
  assert.equal(w.notified(), `Could not send your prompt to the OATS steward\n${line}\n--\n`);
  assert.ok(!argvs(w).some((a) => a[1] === "input"));
  assert.equal(w.tuiArgs(), null);
});

test("--prompt with the steward's window open and no steward to find: the step is named in the notification, nothing sent", (t) => {
  const w = world(t);
  hyprland(w);
  writeFileSync(join(w.s.deployment, "status.json"), JSON.stringify({ ...STATUS, agents: [] }));
  const r = outer(w, ["--prompt", "hello"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^omarchy-launch-oats: finding the steward: no steward on this machine: .*: your prompt was not sent\n$/);
  assert.match(w.notified(), /^Could not send your prompt to the OATS steward\nfinding the steward: no steward on this machine/);
  assert.ok(!argvs(w).some((a) => a[1] === "input"));
});

// Two presses before the first window maps: the second must not open a
// second window. The launcher stand-in maps the steward's window (it
// appears in `hyprctl clients -j`) only after 300 ms, then claims the
// handoff as the window does when it starts.
function slowWindow(w) {
  const clients = join(w.s.root, "hypr", "clients.json");
  launcherDoing(w, `log("launched " + (prompt ? readFileSync(prompt, "utf8") : "-"));
setTimeout(() => {
  writeFileSync(${JSON.stringify(clients)}, readFileSync(${JSON.stringify(fixture("hyprctl", "clients-steward.json"))}));
  writeFileSync(claim, "window", { flag: "wx" });
  require("node:fs").rmSync(require("node:path").dirname(claim), { recursive: true });
}, 300);`);
}
const outerAsync = (w, args) => new Promise((done) => {
  const child = spawn("/bin/sh", [LAUNCHER, ...args], { env: w.env, cwd: w.s.home });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  child.once("exit", (status) => done({ status, stderr: err }));
});

test("two presses while the first window is still starting: one window; the second waits for it and focuses it", { skip: lockSkip }, async (t) => {
  const w = world(t);
  const h = hyprland(w, { clients: "clients-none.json" });
  slowWindow(w);
  const [a, b] = await Promise.all([outerAsync(w, []), outerAsync(w, [])]);
  assert.deepEqual([a.status, b.status], [0, 0], a.stderr + b.stderr);
  assert.deepEqual(launcherLog(w).trim().split("\n"), ["launched -"], "exactly one window");
  assert.ok(h.calls().some((c) => c[0] === "dispatch"), "the second press focused it");
  assert.deepEqual(runtimeEntries(w), [], "no handoff left");
});

test("two presses with prompts while the first window starts: the first prompt reaches the window, the second is sent to the steward", { skip: lockSkip }, async (t) => {
  const w = world(t);
  hyprland(w, { clients: "clients-none.json" });
  slowWindow(w);
  const first = outerAsync(w, ["--prompt", "first"]);
  await waitFor(() => launcherLog(w).includes("launched"));
  const second = await outerAsync(w, ["--prompt", "second"]);
  assert.equal((await first).status, 0);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(launcherLog(w).trim().split("\n"), ["launched first"]);
  const input = w.k.calls().find((c) => c.argv[1] === "input");
  assert.equal(Buffer.from(input.stdin, "base64").toString("utf8"), "second");
});

// A process holding the launch lock: flock(1) on it, running sleep, with
// the lock's descriptor closed in sleep (-o), so killing flock frees it.
async function lockHolder(w) {
  const lock = join(w.run, LAUNCH_LOCK);
  const child = spawn(REAL_FLOCK, ["-o", lock, "sleep", "60"], { stdio: "ignore" });
  const held = () => spawnSync(REAL_FLOCK, ["-n", "-o", lock, "true"]).status !== 0;
  assert.ok(await waitFor(held), "the holder has the lock");
  return { child, lock, held };
}

test("a press while another holds the lock past the bound opens nothing, and says to try again", { skip: lockSkip }, async (t) => {
  const w = world(t);
  hyprland(w, { clients: "clients-none.json" });
  const h = await lockHolder(w);
  t.after(() => h.child.kill("SIGKILL"));
  const err = [];
  const started = Date.now();
  const code = await launch(["--prompt", "hello"], w.env, { err: { write: (x) => err.push(x) }, windowStartMs: 300, timeouts: { hyprctl: 100 } });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);
  const line = "another press is still opening the steward; try again in a moment";
  assert.equal(err.join(""), `omarchy-launch-oats: ${line}: your prompt was not sent\n`);
  assert.equal(w.notified(), `Could not open the OATS steward\n${line}: your prompt was not sent\n--\n`);
  assert.equal(line, LOCK_BUSY);
  assert.equal(w.tuiArgs(), null);
  assert.deepEqual(w.k.calls(), [], "nothing sent");
});

test("a holder of the lock that died frees it: the next press opens the window at once", { skip: lockSkip }, async (t) => {
  const w = world(t);
  hyprland(w, { clients: "clients-none.json" });
  const h = await lockHolder(w);
  h.child.kill("SIGKILL");
  assert.ok(await waitFor(() => !h.held()), "the kernel freed it");
  const started = Date.now();
  const r = outer(w, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.tuiArgs()[0], `--app-id=${APP_ID}`);
  assert.ok(Date.now() - started < 5_000);
});

test("the window never holds the lock: once its press is done, the lock is free while the window runs", { skip: lockSkip }, async (t) => {
  const w = world(t);
  hyprland(w, { clients: "clients-none.json" });
  launcherDoing(w, "log(String(process.pid)); writeFileSync(claim, 'window', { flag: 'wx' }); require('node:fs').rmSync(require('node:path').dirname(claim), { recursive: true }); setTimeout(() => {}, 60_000);");
  const r = outer(w, []);
  assert.equal(r.status, 0, r.stderr);
  const pid = Number(launcherLog(w).trim());
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  process.kill(pid, 0);
  assert.equal(spawnSync(REAL_FLOCK, ["-n", "-o", join(w.run, LAUNCH_LOCK), "true"]).status, 0, "free while the window is alive");
});
