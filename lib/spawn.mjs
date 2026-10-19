// `bin/spawn.mjs`: the OATS picker's "start an agent from this soul". Two
// steps, so the task never passes through a shell:
//
// 1. `spawn --dir <deployment> <soul>` (the picker runs it as argv, with no
//    shell): asks for the task in Omarchy's own input (`omarchy-menu-input`,
//    "Task for <soul>"). An empty answer, or a cancel, runs nothing. The
//    text, untrusted as typed, goes into a file of mode 0600 in a directory
//    of mode 0700 of its own, and Omarchy's floating terminal runs step 2.
// 2. `spawn --run --dir <deployment> --task-file <file> <soul>` (in that
//    terminal): the kernel's `oats spawn <soul> --dir <deployment>
//    --task-file <file> --json`, as argv, in that deployment: no other flag,
//    so the relation is top-level and the deployment's own resolution picks
//    the harness. Its progress shows as it runs; it is not retried. Once it
//    answers, the task file is removed, and the session of the instance it
//    answered with is opened (`oats session attach --home <its home>`). A
//    refusal shows the kernel's code and message, and the terminal stays open
//    on it (Omarchy's own "press any key").
//
// The task file goes on every path: when the spawn answers, fails or is
// stopped (this process removes it on exit, and on SIGTERM, SIGINT and SIGHUP
// once the kernel has ended), and, if this process is killed outright, by the
// terminal's own command line, which removes the directory after it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as discover from "./discover.mjs";
import { assertSafePath, shellQuote } from "./quote.mjs";
import { shimOf } from "./read.mjs";
import { failureText, run, which } from "./system.mjs";
import { attachPrefix, hasDetachKey } from "./waiting.mjs";

export const USAGE = `usage: spawn --dir <deployment> <soul>
       spawn --run --dir <deployment> --task-file <file> <soul>

  Starts an agent from <soul> in <deployment> (the OATS picker runs it): asks
  for its task in Omarchy's input, then, in a floating terminal, runs
  \`oats spawn <soul> --dir <deployment> --task-file <file> --json\` and opens
  the new agent's session. An empty task runs nothing.
`;

export const INPUT = "omarchy-menu-input";
export const TERMINAL = "omarchy-launch-floating-terminal-with-presentation";
// The task's directory, under the system's temporary directory, and its file.
export const TASK_PREFIX = "oats-omarchy-task-";
export const TASK_FILE = "task";
const INPUT_TIMEOUT = 30 * 60_000;
// A soul as `oats souls` names it: a member soul's name, or a package's
// `<package>/<soul>`. Never a flag.
const SOUL = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SELF = fileURLToPath(new URL("../bin/spawn.mjs", import.meta.url));

export function parseArgs(argv) {
  const out = { run: false, dir: null, taskFile: null, soul: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") out.run = true;
    else if (a === "--dir" || a === "--task-file") {
      const value = argv[++i];
      if (!value) return { error: `${a} needs a value` };
      out[a === "--dir" ? "dir" : "taskFile"] = value;
    } else if (a.startsWith("--")) return { error: `unknown argument: ${a}` };
    else if (out.soul === null) out.soul = a;
    else return { error: `one soul only (got ${out.soul} and ${a})` };
  }
  if (out.dir === null) return { error: "--dir <deployment> is required: the deployment the soul was listed from" };
  if (out.soul === null || !SOUL.test(out.soul)) return { error: out.soul === null ? "which soul? none given" : `not a soul name: ${JSON.stringify(out.soul)}` };
  if (out.run !== (out.taskFile !== null)) return { error: out.run ? "--run needs --task-file" : "--task-file goes with --run" };
  return out;
}

// The task file the first step wrote, and nothing else: → its directory,
// which goes with it, or null.
export function taskDir(file) {
  if (!isAbsolute(file) || basename(file) !== TASK_FILE) return null;
  const dir = dirname(file);
  return basename(dir).startsWith(TASK_PREFIX) ? dir : null;
}

// What the second step runs, as the floating terminal's `bash -c` line:
// this node and this script, then the directory removed, whatever happened.
export function terminalLine({ node, script, deployment, file, soul }) {
  const words = [node, script, "--run", "--dir", deployment, "--task-file", file, soul].map(shellQuote).join(" ");
  return `${words}; rm -rf -- ${shellQuote(dirname(file))}`;
}

// `oats spawn --json`'s stdout → { ok: true, instance, home, launched } or
// { ok: false, text } (the kernel's code and message, as given).
export function spawnAnswer(stdout, status) {
  let doc;
  try { doc = JSON.parse(stdout); } catch { return { ok: false, text: `oats spawn exited ${status}${stdout.trim() ? `: ${stdout.trim()}` : " and printed no JSON"}` }; }
  if (doc?.ok === true && typeof doc.result?.instance === "string" && typeof doc.result?.home === "string" && isAbsolute(doc.result.home)) {
    return { ok: true, instance: doc.result.instance, home: doc.result.home, launched: doc.result.launched !== false };
  }
  if (doc?.ok === false && doc.error) {
    const unconfirmed = doc.error.details?.unconfirmed === true ? " (details.unconfirmed: true)" : "";
    return { ok: false, text: `${doc.error.code || "error"}: ${doc.error.message || "oats spawn failed"}${unconfirmed}` };
  }
  return { ok: false, text: "oats spawn --json answered without an instance and home" };
}

// A program in this terminal, in this process group: a signal the terminal
// sends reaches it as well, and a SIGTERM sent to this process alone is
// passed on. With `capture` its stdout is collected and it reads no input
// (the spawn); without, it has the terminal (the attach). → a promise of { status, signal, stdout }.
function child(file, args, { env, cwd, capture = false }) {
  return new Promise((resolve) => {
    const c = spawn(file, args, { env, cwd, stdio: [capture ? "ignore" : "inherit", capture ? "pipe" : "inherit", "inherit"] });
    const out = [];
    if (capture) c.stdout.on("data", (b) => out.push(b));
    const forward = () => { try { c.kill("SIGTERM"); } catch { /* gone */ } };
    process.on("SIGTERM", forward);
    c.on("error", (e) => { process.off("SIGTERM", forward); resolve({ status: null, signal: null, stdout: "", error: e.message }); });
    c.on("close", (status, signal) => { process.off("SIGTERM", forward); resolve({ status, signal, stdout: Buffer.concat(out).toString("utf8") }); });
  });
}

// Step 2, in the floating terminal. → a promise of the exit code.
async function runStep(args, env, out) {
  const dir = taskDir(args.taskFile);
  if (!dir) { out.write(`oats-omarchy: ${args.taskFile} is not a task file this plugin wrote; nothing was run\n`); return 2; }
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* removed */ } };
  // On every way out, the kernel's answer or not.
  process.on("exit", cleanup);
  const stopped = [];
  const note = (signal) => () => { stopped.push(signal); };
  for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) process.on(signal, note(signal));
  try {
    const dep = discover.deployment({ dir: args.dir });
    if (!dep.ok) { out.write(`oats-omarchy: ${dep.reason}\n`); return 1; }
    const prep = shimOf(env);
    if (!prep.ok) { out.write(`oats-omarchy: ${prep.reason}\n`); return 1; }
    out.write(`oats spawn ${args.soul} --dir ${dep.path}\n\n`);
    const r = await child(prep.shim, ["spawn", args.soul, "--dir", dep.path, "--task-file", args.taskFile, "--json"], { env, cwd: dep.path, capture: true });
    cleanup();
    if (stopped.length) return 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[stopped[0]];
    if (r.error) { out.write(`oats-omarchy: oats spawn could not run: ${r.error}\n`); return 1; }
    const answer = spawnAnswer(r.stdout, r.signal || r.status);
    if (!answer.ok) { out.write(`\noats spawn failed: ${answer.text}\n`); return 1; }
    out.write(`\n${answer.instance} started.\n`);
    if (!answer.launched) { out.write(`It was not launched: oats session start --home ${answer.home}\n`); return 0; }
    const attach = await child(prep.shim, [...attachPrefix({ shim: prep.shim, detachKey: hasDetachKey(prep.shim, env, dep.path) }).slice(1), answer.home], { env, cwd: dep.path });
    return attach.status ?? 1;
  } finally {
    cleanup();
  }
}

// Step 1, from the picker. → a promise of the exit code.
async function askStep(args, env, err) {
  const say = (text) => err.write(`oats-omarchy: ${text}\n`);
  const notify = (headline, description) => {
    const bin = which(discover.NOTIFY, env.PATH);
    if (!bin) { say(`${headline}: ${description}`); return; }
    const r = run(bin, [headline, description], { env, timeoutMs: 10_000 });
    if (!r.ok) say(`${discover.NOTIFY}: ${failureText(r)}`);
  };
  const fail = (text) => { notify("OATS: no agent started", text); return 1; };
  const dep = discover.deployment({ dir: args.dir });
  if (!dep.ok) return fail(dep.reason);
  const input = which(INPUT, env.PATH);
  const terminal = which(TERMINAL, env.PATH);
  if (!input || !terminal) return fail(`not on PATH: ${[!input && INPUT, !terminal && TERMINAL].filter(Boolean).join(", ")}`);
  let line;
  try {
    for (const [what, path] of [["the node path", process.execPath], ["the plugin directory", SELF], ["the deployment path", dep.path]]) assertSafePath(what, path);
  } catch (e) { return fail(e.message); }

  const answer = run(input, [`Task for ${args.soul}`], { env, timeoutMs: INPUT_TIMEOUT });
  if (!answer.ok || !answer.stdout.trim()) return 0; // cancelled or empty: nothing runs

  const dir = mkdtempSync(join(tmpdir(), TASK_PREFIX));
  const file = join(dir, TASK_FILE);
  try {
    assertSafePath("the task file", file);
    writeFileSync(file, answer.stdout, { mode: 0o600, flag: "wx" });
    line = terminalLine({ node: process.execPath, script: SELF, deployment: dep.path, file, soul: args.soul });
  } catch (e) { rmSync(dir, { recursive: true, force: true }); return fail(e.message); }
  // The terminal outlives this command: it is started on its own.
  return new Promise((resolve) => {
    const t = spawn(terminal, [line], { env, cwd: dep.path, detached: true, stdio: "ignore" });
    t.on("error", (e) => { rmSync(dir, { recursive: true, force: true }); resolve(fail(`${TERMINAL}: ${e.message}`)); });
    t.on("spawn", () => { t.unref(); resolve(0); });
  });
}

// → a promise of the exit code.
export async function spawnSoul(argv, env = process.env, err = process.stderr, { out = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err.write(`spawn: ${args.error}\n${USAGE}`); return 2; }
  return args.run ? runStep(args, env, out) : askStep(args, env, err);
}
