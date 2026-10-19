// `bin/spawn.mjs`, the picker's "start an agent from this soul", against the
// sandbox's fakes (test/helpers/sandbox.mjs): Omarchy's input, its floating
// terminal and the kernel's `oats spawn --json` and `session attach`. The
// task is untrusted text: it goes to the kernel through a 0600 file, never
// through a shell, and the file goes on every path, a kill included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CLAIMED_FILE, parseArgs, spawnAnswer, spawnSoul, TASK_FILE, TASK_PREFIX, taskDir, terminalLine } from "../lib/spawn.mjs";
import { BIN, sandbox, writeExecutable } from "./helpers/sandbox.mjs";

const HOSTILE = `'; rm -rf "$HOME" #\n$(touch pwned) \`touch pwned\` "quoted" \\ back`;

const shimPath = (s) => join(s.home, ".local/share/oats-omarchy/oats");
const writeShim = (s) => writeExecutable(shimPath(s), `#!/bin/sh\nexec '${process.execPath}' '${s.cli}' "$@"\n`);
const jsonLines = (s, file) => { try { return readFileSync(join(s.root, file), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const calls = (s, log) => {
  let text;
  try { text = readFileSync(join(s.root, log), "utf8"); } catch { return []; }
  return text.split("--\n").filter(Boolean).map((c) => c.replace(/\n$/, "").split("\n"));
};
// The sessions opened: the kernel stand-in logs `session attach` to kernel.log.
const attaches = (s) => jsonLines(s, "kernel.log").filter((argv) => argv[0] === "session" && argv[1] === "attach");
const taskDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith(TASK_PREFIX));

function box(t, options) {
  const s = sandbox(t, options);
  writeShim(s);
  return s;
}

// The ask step in this process, as the picker runs it.
async function ask(s, args, extra = {}, { handoffMs } = {}) {
  let stderr = "";
  const status = await spawnSoul(args, { ...s.env, ...extra }, { write: (x) => { stderr += x; } }, { out: { write() {} }, handoffMs });
  return { status, stderr };
}

// The run step as the floating terminal runs it, in a process of its own.
function runStep(s, { deployment = s.deployment, soul = "writer", task = "a task\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), TASK_PREFIX));
  const file = join(dir, TASK_FILE);
  writeFileSync(file, task, { mode: 0o600 });
  const r = spawnSync(process.execPath, [BIN.spawn, "--run", "--dir", deployment, "--task-file", file, soul], { env: s.env, encoding: "utf8", timeout: 30_000 });
  return { ...r, dir, file };
}

// The floating terminal is started on its own: wait for what it leaves.
function waitFor(check, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

test("a cancelled or empty task runs nothing: no file, no terminal, no kernel", async (t) => {
  const s = box(t);
  const before = taskDirs();
  for (const input of [undefined, "", "  \n\t"]) {
    const extra = input === undefined ? {} : { FAKE_INPUT: input };
    const r = await ask(s, ["--dir", s.deployment, "writer"], extra);
    assert.deepEqual(r, { status: 0, stderr: "" }, JSON.stringify(input));
  }
  assert.deepEqual(calls(s, "input.log"), [["Task for writer"], ["Task for writer"], ["Task for writer"]]);
  assert.equal(existsSync(join(s.root, "floating.log")), false);
  assert.deepEqual(jsonLines(s, "spawn.log"), []);
  assert.deepEqual(calls(s, "notify.log"), []);
  assert.deepEqual(taskDirs(), before);
});

test("the task reaches the kernel as text, by a 0600 file: --dir is the soul's deployment, no other flag, then the session of the instance it returned", async (t) => {
  const s = box(t);
  const r = await ask(s, ["--dir", s.deployment, "pkg/writer"], { FAKE_INPUT: HOSTILE, FAKE_FLOATING_RUN: "1" });
  assert.deepEqual(r, { status: 0, stderr: "" });
  const [spawned] = waitFor(() => jsonLines(s, "spawn.log").length && jsonLines(s, "spawn.log")) || [];
  assert.ok(spawned, "the kernel's spawn ran");
  const claimed = spawned.argv[5];
  assert.deepEqual(spawned.argv, ["spawn", "pkg/writer", "--dir", s.deployment, "--task-file", claimed, "--json"]);
  assert.equal(spawned.cwd, s.deployment);
  assert.equal(spawned.task, HOSTILE, "as typed, byte for byte");
  assert.equal(spawned.mode, 0o600);
  assert.equal(basename(claimed), CLAIMED_FILE, "the file the terminal claimed");
  const file = join(dirname(claimed), TASK_FILE);
  assert.notEqual(taskDir(file), null);

  const [attached] = waitFor(() => attaches(s).length && attaches(s)) || [];
  assert.deepEqual(attached, ["session", "attach", "--detach-key", "M-o", "--home", join(s.deployment, "agents", "pkg/writer", "instances", "pkg/writer-1")]);
  assert.ok(waitFor(() => !existsSync(taskDir(file))), "the task file is removed");

  // The terminal's line names the file, never the task.
  const [line] = readFileSync(join(s.root, "floating.log"), "utf8").trim().split("\n");
  assert.equal(line, terminalLine({ node: process.execPath, script: BIN.spawn, deployment: s.deployment, file, soul: "pkg/writer" }));
  assert.ok(!line.includes("rm -rf \"$HOME\""));
  assert.ok(existsSync(s.home) && !existsSync(join(s.root, "pwned")) && !existsSync(join(s.deployment, "pwned")), "the task ran nothing");
  assert.deepEqual(calls(s, "notify.log"), []);
});

test("the file is 0600 in a 0700 directory of its own, kept until the terminal claims it; the terminal's line removes the directory after the run, whatever happened", async (t) => {
  const s = box(t);
  // The stand-in terminal only logs its line: this test runs it.
  const pending = ask(s, ["--dir", s.deployment, "writer"], { FAKE_INPUT: "do it" }, { handoffMs: 30_000 });
  const line = waitFor(() => { try { return readFileSync(join(s.root, "floating.log"), "utf8").trim(); } catch { return null; } });
  const file = /'--task-file' '([^']+)'/.exec(line)[1];
  assert.equal(readFileSync(file, "utf8"), "do it");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(taskDir(file)).mode & 0o777, 0o700);
  // The kernel refuses; the line still removes the directory.
  writeFileSync(join(s.root, "spawn.json"), JSON.stringify({ ok: false, error: { code: "E_SOUL_UNKNOWN", message: "no soul writer" } }));
  writeFileSync(join(s.root, "spawn.status"), "1");
  const ran = spawnSync("bash", ["-c", line], { env: s.env, encoding: "utf8" });
  assert.match(ran.stdout, /oats spawn failed: E_SOUL_UNKNOWN: no soul writer/);
  assert.equal(jsonLines(s, "spawn.log")[0].argv[5], join(taskDir(file), CLAIMED_FILE), "the kernel reads the claimed file");
  assert.equal(existsSync(taskDir(file)), false);
  assert.deepEqual(await pending, { status: 0, stderr: "" }, "the picker's step ends once the terminal has the task");
  assert.deepEqual(calls(s, "notify.log"), []);
});

test("a terminal launcher that fails, or starts no terminal in time: the task is withdrawn and removed, nothing runs, and a notification says why", async (t) => {
  const s = box(t);
  const launcher = join(s.fakebin, "omarchy-launch-floating-terminal-with-presentation");
  const before = taskDirs();
  writeExecutable(launcher, "#!/bin/sh\nexit 1\n");
  assert.equal((await ask(s, ["--dir", s.deployment, "writer"], { FAKE_INPUT: "secret task" }, { handoffMs: 10_000 })).status, 1);
  // Exits at once, as setsid and uwsm-app do, and never runs the line.
  writeExecutable(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" > '${join(s.root, "line")}'\nexit 0\n`);
  assert.equal((await ask(s, ["--dir", s.deployment, "writer"], { FAKE_INPUT: "secret task" }, { handoffMs: 800 })).status, 1);
  assert.deepEqual(calls(s, "notify.log"), [
    ["OATS: no agent started", "omarchy-launch-floating-terminal-with-presentation failed (exit 1)"],
    ["OATS: no agent started", "omarchy-launch-floating-terminal-with-presentation started no terminal within 1 s"],
  ]);
  assert.deepEqual(taskDirs(), before, "no task file is left");
  assert.deepEqual(jsonLines(s, "spawn.log"), []);

  // A terminal that starts after that runs nothing: the task was withdrawn.
  const late = spawnSync("bash", ["-c", readFileSync(join(s.root, "line"), "utf8").trim()], { env: s.env, encoding: "utf8" });
  assert.match(late.stdout, /the task was withdrawn: .* nothing was run/);
  assert.deepEqual(jsonLines(s, "spawn.log"), []);
});

test("a refusal shows the kernel's code and message, runs no attach and is not retried; the file is gone", (t) => {
  const s = box(t);
  writeFileSync(join(s.root, "spawn.json"), JSON.stringify({ ok: false, error: { code: "E_LAUNCH_FAILED", message: "the harness did not start", details: { unconfirmed: true } } }));
  writeFileSync(join(s.root, "spawn.status"), "1");
  const r = runStep(s);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `oats spawn writer --dir ${s.deployment}\n\n\noats spawn failed: E_LAUNCH_FAILED: the harness did not start (details.unconfirmed: true)\n`);
  assert.match(r.stderr, /spawning writer/, "the kernel's progress shows as it runs");
  assert.equal(jsonLines(s, "spawn.log").length, 1, "once");
  assert.deepEqual(attaches(s), []);
  assert.equal(existsSync(r.dir), false);

  // No JSON at all, and an instance that was not launched.
  writeFileSync(join(s.root, "spawn.json"), "Error: boom");
  assert.match(runStep(s).stdout, /oats spawn failed: oats spawn exited 1: Error: boom\n$/);
  writeFileSync(join(s.root, "spawn.json"), JSON.stringify({ ok: true, result: { instance: "writer-7", home: "/d/agents/writer/instances/writer-7", launched: false } }));
  writeFileSync(join(s.root, "spawn.status"), "0");
  const scaffold = runStep(s);
  assert.equal(scaffold.status, 0);
  assert.match(scaffold.stdout, /writer-7 started\.\nIt was not launched: oats session start --home \/d\/agents\/writer\/instances\/writer-7\n$/);
  assert.deepEqual(attaches(s), []);
});

test("a spawn stopped in the terminal (SIGTERM) is stopped with it and leaves no file; killed outright (SIGKILL), the terminal's line removes it", async (t) => {
  const s = box(t);
  writeFileSync(join(s.root, "spawn.mode"), "hang");
  const pidsOf = () => { try { return readFileSync(join(s.root, "spawn.pids"), "utf8").trim().split("\n").filter(Boolean).map(Number); } catch { return []; } };
  const gone = (pid) => { try { return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; } };

  // SIGTERM to the run step: passed on to the kernel; the file goes.
  const dir = mkdtempSync(join(tmpdir(), TASK_PREFIX));
  const file = join(dir, TASK_FILE);
  writeFileSync(file, "t", { mode: 0o600 });
  const child = spawn(process.execPath, [BIN.spawn, "--run", "--dir", s.deployment, "--task-file", file, "writer"], { env: s.env, stdio: "ignore" });
  const exited = new Promise((done) => child.on("close", (code, signal) => done({ code, signal })));
  assert.ok(waitFor(() => pidsOf().length === 1), "the kernel started");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: 143, signal: null });
  assert.equal(existsSync(dir), false);
  assert.ok(waitFor(() => gone(pidsOf()[0]), 5000), "the kernel was stopped");
  assert.deepEqual(attaches(s), []);

  // SIGKILL to the run step, inside the terminal's line.
  const dir2 = mkdtempSync(join(tmpdir(), TASK_PREFIX));
  const file2 = join(dir2, TASK_FILE);
  writeFileSync(file2, "t", { mode: 0o600 });
  const line = terminalLine({ node: process.execPath, script: BIN.spawn, deployment: s.deployment, file: file2, soul: "writer" });
  const shell = spawn("bash", ["-c", line], { env: s.env, stdio: "ignore" });
  const shellDone = new Promise((done) => shell.on("close", done));
  assert.ok(waitFor(() => pidsOf().length === 2), "the kernel started again");
  const kernel = pidsOf()[1];
  const runner = Number(readFileSync(`/proc/${kernel}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
  process.kill(runner, "SIGKILL");
  process.kill(kernel, "SIGKILL");
  await shellDone;
  assert.equal(existsSync(dir2), false, "the line's rm ran after the kill");
});

test("refusals: no deployment, a deployment that is not one, a soul that is not a name, a task file this plugin did not write", async (t) => {
  const s = box(t);
  for (const [argv, why] of [
    [["writer"], /--dir <deployment> is required/],
    [["--dir", s.deployment], /which soul\? none given/],
    [["--dir", s.deployment, "-x"], /not a soul name: "-x"/],
    [["--dir", s.deployment, "a", "b"], /one soul only/],
    [["--dir", s.deployment, "--task-file", "/x", "writer"], /--task-file goes with --run/],
    [["--run", "--dir", s.deployment, "writer"], /--run needs --task-file/],
  ]) {
    const r = await ask(s, argv);
    assert.equal(r.status, 2, argv.join(" "));
    assert.match(r.stderr, why);
  }
  assert.deepEqual(parseArgs(["--dir", "/d", "pkg/soul.v2"]), { run: false, dir: "/d", taskFile: null, soul: "pkg/soul.v2" });

  // Not a deployment: said in a notification; nothing is asked.
  const r = await ask(s, ["--dir", join(s.root, "nowhere"), "writer"], { FAKE_INPUT: "x" });
  assert.equal(r.status, 1);
  const [note] = calls(s, "notify.log");
  assert.equal(note[0], "OATS: no agent started");
  assert.deepEqual(calls(s, "input.log"), []);

  // A task file that is not one this plugin wrote is neither run nor removed.
  const other = join(s.root, "task");
  writeFileSync(other, "x");
  const run = spawnSync(process.execPath, [BIN.spawn, "--run", "--dir", s.deployment, "--task-file", other, "writer"], { env: s.env, encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /is not a task file this plugin wrote; nothing was run/);
  assert.ok(existsSync(other));
  assert.deepEqual(jsonLines(s, "spawn.log"), []);
  assert.equal(taskDir("/tmp/oats-omarchy-task-x/task"), "/tmp/oats-omarchy-task-x");
  assert.equal(taskDir("/tmp/elsewhere/task"), null);
  assert.equal(taskDir("relative/oats-omarchy-task-x/task"), null);
});

test("without Omarchy's input or its floating terminal, nothing is asked and a notification says what is missing", async (t) => {
  const s = box(t, { launchers: ["omarchy-notification-send", "omarchy-launch-floating-terminal-with-presentation"] });
  const r = await ask(s, ["--dir", s.deployment, "writer"], { FAKE_INPUT: "x" });
  assert.equal(r.status, 1);
  assert.deepEqual(calls(s, "notify.log"), [["OATS: no agent started", "not on PATH: omarchy-menu-input"]]);
});

test("spawnAnswer: the instance and home it returned, or the kernel's words", () => {
  assert.deepEqual(spawnAnswer(JSON.stringify({ ok: true, result: { instance: "w-1", home: "/h/w-1" } }), 0), { ok: true, instance: "w-1", home: "/h/w-1", launched: true });
  assert.deepEqual(spawnAnswer(JSON.stringify({ ok: true, result: { instance: "w-1", home: "relative" } }), 0), { ok: false, text: "oats spawn --json answered without an instance and home" });
  assert.deepEqual(spawnAnswer(JSON.stringify({ ok: false, error: { code: "E_X", message: "m" } }), 1), { ok: false, text: "E_X: m" });
  assert.deepEqual(spawnAnswer("", 1), { ok: false, text: "oats spawn exited 1 and printed no JSON" });
});
