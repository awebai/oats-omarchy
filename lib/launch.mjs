// `omarchy-launch-oats` (bin/launch.mjs): opens this machine's steward the
// way Omarchy's `omarchy-agent` opens its default harness, in one window
// through `omarchy-launch-tui --app-id=org.omarchy.agent`, so every agent
// window shares one class for Omarchy's window rules and themes.
//
// The outer process only opens the window; the window runs the flow
// (`--in-terminal`), so every failure is shown where the person is looking:
// find the steward (lib/steward.mjs), start it, send the prompt as the
// person's own turn (deliverPrompt), then attach. A failure in the window
// prints one line naming the step and waits for Enter before the window
// closes; a failure before it (setup not applied, no launcher, a launcher
// that fails at once) goes to stderr and an Omarchy notification.
//
// The kernel is always setup's shim (discover.paths().shim), never `oats`
// from PATH, and every call to it but the attach runs bounded in a process
// group of its own (waiting.mjs statusRead). A prompt never travels in argv
// or through a shell: a 0600 file carries it to the window, which deletes
// it once read, and the kernel reads it on stdin.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as discover from "./discover.mjs";
import { findSteward, kernelMessage } from "./steward.mjs";
import { isExecutableFile, run, which } from "./system.mjs";
import { attachPrefix, hasDetachFeature, statusRead } from "./waiting.mjs";

export const APP_ID = "org.omarchy.agent";
export const LAUNCH_TUI = "omarchy-launch-tui";
export const OMARCHY_AGENT = "omarchy-agent";
export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LAUNCH_SCRIPT = join(PLUGIN_DIR, "bin", "launch.mjs");
const NAME = "omarchy-launch-oats";
// The features a prompt needs: `session inspect`'s `running` and its
// `waitingOnYou`. Without them the prompt is not sent.
export const PROMPT_FEATURES = ["session-inspect-running", "waiting-on-you"];
// `oats session attach` exits with this when the detach key leaves it.
export const DETACHED = 20;

// How long the outer process watches Omarchy's launcher for a failure
// before it leaves the window to it.
export const WINDOW_GRACE = 3_000;

// Bounds, in ms, for each kernel call; `timeouts` overrides them in tests.
export const TIMEOUTS = {
  version: 15_000,
  read: 30_000, // `deployments --json` and each `status --json`
  start: 120_000,
  inspect: 10_000,
  input: 60_000,
  ready: 20_000, // a just-started steward's `running: true`
  poll: 1_000, // between two inspects, at least
};

export const USAGE = `usage: omarchy-launch-oats [--prompt <text>] [--inline]

  Opens this machine's OATS steward (oats.machine/steward) in an agent
  window, as omarchy-agent opens the default harness: starts it when it is
  stopped, then attaches to its session. Ctrl+\\ leaves the viewer, and the
  steward keeps running. It needs setup applied (./setup --apply) and a
  steward in the machine's deployment.

  --prompt <text>  your own turn in the steward's session, as if you typed
                   it: sent once it is running, never twice, and not while
                   it waits on you (an Enter could answer its question)
  --inline         Omarchy's own default agent in this terminal instead
                   (omarchy-agent --inline, with --prompt passed on), no OATS
`;

// → { inline, inTerminal, prompt, promptFile } | { error }. `--in-terminal`
// and `--prompt-file` are the window's own, which the outer launch passes.
export function parseArgs(argv) {
  const a = { inline: false, inTerminal: false, prompt: null, promptFile: null };
  const value = (name, i) => {
    if (argv[i].startsWith(`${name}=`)) return { v: argv[i].slice(name.length + 1), i };
    if (i + 1 >= argv.length) return { error: `${name} needs a value` };
    return { v: argv[i + 1], i: i + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--inline") { a.inline = true; continue; }
    if (arg === "--in-terminal") { a.inTerminal = true; continue; }
    const name = ["--prompt", "--prompt-file"].find((n) => arg === n || arg.startsWith(`${n}=`));
    if (!name) return { error: `unknown argument: ${arg}` };
    const got = value(name, i);
    if (got.error) return { error: got.error };
    const key = name === "--prompt" ? "prompt" : "promptFile";
    if (a[key] !== null) return { error: `${name} is given twice` };
    a[key] = got.v;
    i = got.i;
  }
  if (a.prompt !== null && !a.prompt.trim()) return { error: "--prompt needs some text" };
  if (a.inline && a.inTerminal) return { error: "--inline runs Omarchy's own agent: it takes no --in-terminal" };
  if (a.inTerminal && a.prompt !== null) return { error: "--prompt is for the launch, not the window (which reads --prompt-file)" };
  if (a.promptFile !== null && !a.inTerminal) return { error: "--prompt-file is the window's own: use --prompt" };
  if (a.promptFile !== null && !isAbsolute(a.promptFile)) return { error: "--prompt-file needs an absolute path" };
  return a;
}

// A child that owns the terminal (the attach, Omarchy's agent): stdio
// inherited, the terminal's own signals (SIGINT, SIGQUIT) left to it, and
// SIGTERM and SIGHUP passed on to it. → a promise of { status, signal } or
// { error }.
export function runChild(file, args, { env, cwd } = {}) {
  return new Promise((done) => {
    let child = null;
    const ignore = () => {};
    const forward = (signal) => { try { child?.kill(signal); } catch { /* already gone */ } };
    const handlers = [["SIGINT", ignore], ["SIGQUIT", ignore], ["SIGTERM", forward], ["SIGHUP", forward]];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const finish = (result) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      done(result);
    };
    try { child = spawn(file, args, { env, cwd, stdio: "inherit" }); } catch (e) { finish({ error: e.message }); return; }
    child.once("error", (e) => finish({ error: e.message }));
    child.once("exit", (status, signal) => finish({ status, signal }));
  });
}

// What a finished child leaves this process to do: its exit status, or
// its signal to raise again (bin/launch.mjs `exit`).
const outcome = (r) => (r.signal ? r.signal : r.status ?? 1);

// Waits for Enter (or the end of input: a closed window) on fd 0, read
// directly so the terminal is left as it was for the attach after it.
export function waitForEnter() {
  const buf = Buffer.alloc(256);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try { n = readSync(0, buf, 0, buf.length, null); } catch (e) {
      if (e.code === "EAGAIN") { Atomics.wait(nap, 0, 0, 50); continue; }
      return;
    }
    if (n === 0 || buf.subarray(0, n).includes(10)) return;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The kernel's envelope from a call's stdout, or null.
function envelope(r) {
  try { const out = JSON.parse(r.stdout); return out && typeof out === "object" ? out : null; } catch { return null; }
}

// The person's prompt, as their own turn in the steward's session: `oats
// session input --home <home> --json` with the text on stdin (the kernel
// reads stdin without --text-file; `--text-file -` would be a file named
// "-"). First `session inspect` until the steward runs (at most
// `timeouts.ready`, an inspect at most every `timeouts.poll`), and that last
// inspect is the fresh read of `waitingOnYou`: a steward waiting on the
// person gets nothing, since a pasted Enter could answer its question. The
// kernel's answer is reported as given, and an input is never sent twice:
// `submitted` means the paste and Enter went in, and `verified: false` is
// not a failure. → { delivered, line }, the line for the window.
export async function deliverPrompt({ shim, home, text, env = process.env, cwd, features = [], timeouts = TIMEOUTS }) {
  const t = { ...TIMEOUTS, ...timeouts };
  const call = (args, ms, input) => statusRead(shim, env, cwd, ms, undefined, args, { input });
  const notSent = (why) => ({ delivered: false, line: `sending your prompt: ${why}: your prompt was not sent` });
  const missing = PROMPT_FEATURES.filter((f) => !features.includes(f));
  if (missing.length) return notSent(`this OATS CLI cannot say whether the steward is ready for it (it lacks ${missing.join(" and ")}; update it)`);

  const start = Date.now();
  let session = null;
  for (;;) {
    const left = t.ready - (Date.now() - start);
    const r = await call(["session", "inspect", "--home", home, "--json"], Math.max(1, Math.min(t.inspect, left)));
    const out = envelope(r);
    if (!r.ok || out?.ok !== true) return notSent(`the steward's session could not be inspected: ${kernelMessage(r)}`);
    session = out.result;
    if (session?.running === true) break;
    if (Date.now() - start + t.poll >= t.ready) return notSent(`the steward was not running within ${Math.round(t.ready / 1000)} s`);
    await sleep(t.poll);
  }
  const waiting = session.waitingOnYou;
  if (waiting && typeof waiting === "object") {
    const about = [waiting.message, waiting.reason].find((v) => typeof v === "string" && v.trim()) || "it did not say why";
    return { delivered: false, line: `the steward is waiting on you (${about}): your prompt was not sent; attaching` };
  }

  const r = await call(["session", "input", "--home", home, "--json"], t.input, text);
  const out = envelope(r);
  if (r.error && !out) return { delivered: false, line: `sending your prompt: ${r.error}: it may or may not have gone in, and it is not sent again` };
  if (!r.ok || out?.ok !== true) return { delivered: false, line: `sending your prompt: ${kernelMessage(r)}: your prompt was not delivered; type it yourself` };
  const result = out.result || {};
  if (result.submitted !== true) return { delivered: false, line: "sending your prompt: the kernel did not submit it: your prompt was not delivered; type it yourself" };
  return { delivered: true, line: result.verified === true ? "your prompt was sent to the steward" : "your prompt was sent to the steward (the kernel could not see it arrive; it is not sent again)" };
}

// The window's flow. `pause` waits for Enter; `timeouts` are for tests.
// → a promise of the exit status, or of the attach's signal to raise again.
export async function inTerminal(args, env, { err = process.stderr, out = process.stdout, pause = waitForEnter, timeouts = {} } = {}) {
  const t = { ...TIMEOUTS, ...timeouts };
  const say = (line) => err.write(`${NAME}: ${line}\n`);
  const stop = (line) => { say(line); out.write("Press Enter to close this window."); pause(); return 1; };
  const holdOn = () => { out.write("Press Enter to attach to the steward."); pause(); };

  // The prompt first: its file is deleted whatever happens next.
  let text = null;
  let promptLine = null;
  if (args.promptFile !== null) {
    try { text = readFileSync(args.promptFile, "utf8"); } catch (e) { promptLine = `reading your prompt: ${e.message}: your prompt was not sent`; }
    try { rmSync(args.promptFile, { force: true }); } catch (e) { say(`removing ${args.promptFile}: ${e.message}`); }
    if (text !== null && !text.trim()) { text = null; promptLine = "reading your prompt: it is empty: nothing was sent"; }
    if (promptLine) say(promptLine);
  }

  let shim;
  try { shim = discover.paths(env).shim; } catch (e) { return stop(`finding the steward: ${e.message}`); }
  if (!isExecutableFile(shim)) return stop(`finding the steward: setup's shim ${shim} is missing: run setup --apply`);
  const v = await statusRead(shim, env, env.HOME, t.version, undefined, ["version", "--json"]);
  let features;
  try {
    if (!v.ok) throw new Error(kernelMessage(v));
    features = JSON.parse(v.stdout).features;
    if (!Array.isArray(features)) throw new Error("it lists no features");
  } catch (e) { return stop(`finding the steward: oats version --json failed: ${e.message}`); }
  const steward = await findSteward(env, { shim, features, timeoutMs: t.read });
  if (!steward.ok) return stop(`finding the steward: ${steward.reason}`);
  // Left on the screen under the viewer: it is there again after a detach.
  for (const d of steward.unread) say(`finding the steward: not read: ${d}`);
  const { home } = steward;
  const cwd = steward.deployment.path;

  const s = await statusRead(shim, env, cwd, t.start, undefined, ["session", "start", "--home", home, "--json"]);
  if (!s.ok && envelope(s)?.error?.code !== "E_SESSION_RUNNING") return stop(`starting the steward (${home}): ${kernelMessage(s)}`);

  if (promptLine) holdOn();
  if (text !== null) {
    const sent = await deliverPrompt({ shim, home, text, env, cwd, features, timeouts: t });
    say(sent.line);
    if (!sent.delivered) holdOn();
  }

  const [attach, ...attachArgs] = [...attachPrefix({ shim, detachKey: hasDetachFeature(features) }), home];
  const r = await runChild(attach, attachArgs, { env, cwd });
  if (r.error) return stop(`attaching: ${r.error}`);
  if (r.signal || r.status === 0 || r.status === DETACHED) return outcome(r);
  stop(`attaching: oats session attach exited with status ${r.status}`);
  return r.status;
}

// The file that carries a prompt to the window: 0600, created new, under
// $XDG_RUNTIME_DIR (else the temporary directory). → its path.
export function writePromptFile(text, env) {
  const runtime = env.XDG_RUNTIME_DIR;
  let dir = tmpdir();
  try { if (runtime && isAbsolute(runtime) && statSync(runtime).isDirectory()) dir = runtime; } catch { /* not there: the temporary directory */ }
  const path = join(dir, `oats-omarchy-prompt-${randomBytes(12).toString("hex")}`);
  const fd = openSync(path, "wx", 0o600);
  try {
    const bytes = Buffer.from(text, "utf8");
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
  } catch (e) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw e;
  }
  closeSync(fd);
  return path;
}

// The window: `omarchy-launch-tui --app-id=org.omarchy.agent <node>
// <plugin>/bin/launch.mjs --in-terminal [--prompt-file <path>]`.
export const windowArgv = ({ node = process.execPath, promptFile = null } = {}) =>
  [`--app-id=${APP_ID}`, node, LAUNCH_SCRIPT, "--in-terminal", ...(promptFile ? ["--prompt-file", promptFile] : [])];

// Before the window: one line on stderr and, when Omarchy's notifier is
// there, a notification (its failure ignored). → 1.
function refuse(env, err, line) {
  err.write(`${NAME}: ${line}\n`);
  const notify = which(discover.NOTIFY, env.PATH);
  if (notify) run(notify, ["Could not open the OATS steward", line], { env, timeoutMs: 10_000 });
  return 1;
}

// The command. → a promise of the exit status, or of a signal to raise
// again (bin/launch.mjs).
export async function launch(argv, env = process.env, { err = process.stderr, out = process.stdout, pause, timeouts, windowGraceMs = WINDOW_GRACE } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err.write(`${NAME}: ${args.error}\n${USAGE}`); return 2; }
  if (args.inTerminal) return inTerminal(args, env, { err, out, pause, timeouts });

  if (args.inline) {
    const agent = which(OMARCHY_AGENT, env.PATH);
    if (!agent) { err.write(`${NAME}: ${OMARCHY_AGENT} is not on PATH: --inline runs Omarchy's own agent\n`); return 1; }
    const r = await runChild(agent, ["--inline", ...(args.prompt !== null ? ["--prompt", args.prompt] : [])], { env });
    if (r.error) { err.write(`${NAME}: ${OMARCHY_AGENT}: ${r.error}\n`); return 1; }
    return outcome(r);
  }

  let shim;
  try { shim = discover.paths(env).shim; } catch (e) { return refuse(env, err, e.message); }
  if (!isExecutableFile(shim)) return refuse(env, err, `OATS is not set up here (setup's shim ${shim} is missing): run setup --apply`);
  const launcher = which(LAUNCH_TUI, env.PATH);
  if (!launcher) return refuse(env, err, `${LAUNCH_TUI} is not on PATH: it opens the agent window`);

  let promptFile = null;
  if (args.prompt !== null) {
    try { promptFile = writePromptFile(args.prompt, env); } catch (e) { return refuse(env, err, `keeping your prompt for the window: ${e.message}`); }
  }
  // The window outlives this command: it is started on its own, with this
  // command's output, as omarchy-agent's exec gives it. Omarchy's launcher
  // runs the terminal in the foreground (uwsm-app's scope), so it is still
  // running while the window is open: only a launcher that ends with a
  // failure within `windowGraceMs` is known to have opened nothing.
  const child = spawn(launcher, windowArgv({ promptFile }), { env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
  const early = await new Promise((r) => {
    const timer = setTimeout(() => r({ running: true }), windowGraceMs);
    child.once("error", (e) => { clearTimeout(timer); r({ error: e.message }); });
    child.once("exit", (status, signal) => { clearTimeout(timer); r({ status, signal }); });
  });
  if (early.running || early.status === 0) { child.unref(); return 0; }
  if (promptFile) rmSync(promptFile, { force: true });
  return refuse(env, err, `${LAUNCH_TUI}: ${early.error || (early.signal ? `ended by ${early.signal}` : `exited with status ${early.status}`)}: no window opened`);
}

// bin/launch.mjs's end: exit with `code`, or raise a child's signal again.
export function exit(code) {
  if (typeof code === "number") process.exit(code);
  process.kill(process.pid, code);
  // A signal whose default does not end a process: its exit status.
  process.exit(128 + (osConstants.signals[code] || 0));
}
