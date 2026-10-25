// `omarchy-launch-oats` (bin/launch.mjs): opens this machine's steward the
// way Omarchy's `omarchy-agent` opens its default harness, in one window
// through `omarchy-launch-tui`, or focuses that window when it is open. The
// window's app-id is its own (APP_ID), so `hyprctl clients -j` tells it from
// every other agent window, and it is still one of Omarchy's org.omarchy.*
// terminal windows for its window rules and themes.
//
// The outer process focuses the steward's open window (and sends a prompt
// itself, reported in a notification), or opens the window. The window runs
// the flow (`--in-terminal`), so every failure is shown where the person is
// looking: find the steward (lib/steward.mjs), start it, send the prompt as
// the person's own turn (deliverPrompt), then attach. A failure in the window
// prints one line naming the step and waits for Enter before the window
// closes; a failure before it (setup not applied, no launcher, a window
// that did not start) goes to stderr and an Omarchy notification.
//
// The kernel is always setup's shim (discover.paths().shim), never `oats`
// from PATH, and every call to it but the attach runs bounded in a process
// group of its own (waiting.mjs statusRead). A prompt never travels in argv
// or through a shell: a 0600 file in the private handoff carries it to the
// window, which deletes it once read, and the kernel reads it on stdin.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { connect, createServer } from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as discover from "./discover.mjs";
import { findSteward, kernelMessage } from "./steward.mjs";
import { isExecutableFile, run, which } from "./system.mjs";
import { attachPrefix, hasDetachFeature, statusRead } from "./waiting.mjs";

export const APP_ID = "org.omarchy.agent.oats-steward";
export const LAUNCH_TUI = "omarchy-launch-tui";
export const HYPRCTL = "hyprctl";
export const OMARCHY_AGENT = "omarchy-agent";
export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LAUNCH_SCRIPT = join(PLUGIN_DIR, "bin", "launch.mjs");
const NAME = "omarchy-launch-oats";
// The features a prompt needs: `session inspect`'s `running` and its
// `waitingOnYou`. Without them the prompt is not sent.
export const PROMPT_FEATURES = ["session-inspect-running", "waiting-on-you"];
// `oats session attach` exits with this when the detach key leaves it.
export const DETACHED = 20;

// How long the launch waits for its window to claim the handoff.
export const WINDOW_START = 30_000;

// Bounds, in ms, for each kernel call; `timeouts` overrides them in tests.
export const TIMEOUTS = {
  version: 15_000,
  read: 30_000, // `deployments --json` and each `status --json`
  start: 120_000,
  inspect: 10_000,
  input: 60_000,
  ready: 20_000, // a just-started steward's `running: true`
  poll: 1_000, // between two inspects, at least
  hyprctl: 10_000, // each hyprctl call (hyprctl's own socket read gives up at 5 s)
};

export const USAGE = `usage: omarchy-launch-oats [--prompt <text>] [--inline]

  Opens this machine's OATS steward (oats.machine/steward) in an agent
  window, as omarchy-agent opens the default harness: starts it when it is
  stopped, then attaches to its session. When the steward's window is
  already open, it focuses that window instead. Ctrl+\\ leaves the viewer,
  and the steward keeps running. It needs setup applied (./setup --apply)
  and a steward in the machine's deployment.

  --prompt <text>  your own turn in the steward's session, as if you typed
                   it: sent once it is running, never twice, and not while
                   it waits on you (an Enter could answer its question);
                   with the window already open, the result is a
                   notification
  --inline         Omarchy's own default agent in this terminal instead
                   (omarchy-agent --inline, with --prompt passed on), no OATS
`;

// → { inline, inTerminal, prompt, promptFile, claimFile } | { error }.
// `--in-terminal`, `--prompt-file` and `--claim-file` are the window's
// own, which the outer launch passes.
export function parseArgs(argv) {
  const a = { inline: false, inTerminal: false, prompt: null, promptFile: null, claimFile: null };
  const value = (name, i) => {
    if (argv[i].startsWith(`${name}=`)) return { v: argv[i].slice(name.length + 1), i };
    if (i + 1 >= argv.length) return { error: `${name} needs a value` };
    return { v: argv[i + 1], i: i + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--inline") { a.inline = true; continue; }
    if (arg === "--in-terminal") { a.inTerminal = true; continue; }
    const name = ["--prompt", "--prompt-file", "--claim-file"].find((n) => arg === n || arg.startsWith(`${n}=`));
    if (!name) return { error: `unknown argument: ${arg}` };
    const got = value(name, i);
    if (got.error) return { error: got.error };
    const key = { "--prompt": "prompt", "--prompt-file": "promptFile", "--claim-file": "claimFile" }[name];
    if (a[key] !== null) return { error: `${name} is given twice` };
    a[key] = got.v;
    i = got.i;
  }
  if (a.prompt !== null && !a.prompt.trim()) return { error: "--prompt needs some text" };
  if (a.inline && a.inTerminal) return { error: "--inline runs Omarchy's own agent: it takes no --in-terminal" };
  if (a.inTerminal && a.prompt !== null) return { error: "--prompt is for the launch, not the window (which reads --prompt-file)" };
  for (const [key, name] of [["promptFile", "--prompt-file"], ["claimFile", "--claim-file"]]) {
    if (a[key] !== null && !a.inTerminal) return { error: `${name} is the window's own${key === "promptFile" ? ": use --prompt" : ""}` };
    if (a[key] !== null && !isAbsolute(a[key])) return { error: `${name} needs an absolute path` };
  }
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
// not a failure. `waitingNext` ends the line for a steward waiting on the
// person: what happens next. → { delivered, line }, the line for the window.
export async function deliverPrompt({ shim, home, text, env = process.env, cwd, features = [], timeouts = TIMEOUTS, waitingNext = "attaching" }) {
  const t = { ...TIMEOUTS, ...timeouts };
  const call = (args, ms, input) => statusRead(shim, env, cwd, ms, undefined, args, { input });
  const notSent = (why) => ({ delivered: false, line: `sending your prompt: ${why}: your prompt was not sent` });
  const missing = PROMPT_FEATURES.filter((f) => !features.includes(f));
  if (missing.length) return notSent(`this OATS CLI cannot say whether the steward is ready for it (it lacks ${missing.join(" and ")}; update it)`);

  // Every inspect is bounded by what is left of `t.ready` too: a read the
  // deadline ends, and an answer after it, are the steward not running in
  // time, never a late yes. A failed inspect (an error envelope, a non-zero
  // exit, a read that timed out) may be transient, as a session settles: it
  // is tried again after the poll interval, until the deadline, which then
  // names the last failure. Only the inspect is retried; the input never is.
  const start = Date.now();
  const within = `within ${Math.round(t.ready / 1000)} s`;
  let failure = null;
  const late = () => notSent(failure ? `the steward's session could not be inspected ${within}: ${failure}` : `the steward was not running ${within}`);
  let session = null;
  for (;;) {
    const left = t.ready - (Date.now() - start);
    if (left <= 0) return late();
    const ms = Math.min(t.inspect, left);
    const r = await call(["session", "inspect", "--home", home, "--json"], ms);
    if (Date.now() - start >= t.ready) return late();
    const out = envelope(r);
    if (r.ok && out?.ok === true) {
      failure = null;
      session = out.result;
      if (session?.running === true) break;
    } else failure = kernelMessage(r);
    if (Date.now() - start + t.poll >= t.ready) return late();
    await sleep(t.poll);
  }
  const waiting = session.waitingOnYou;
  if (waiting && typeof waiting === "object") {
    const about = [waiting.message, waiting.reason].find((v) => typeof v === "string" && v.trim()) || "it did not say why";
    return { delivered: false, line: `the steward is waiting on you (${about}): your prompt was not sent; ${waitingNext}` };
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

  // The handoff first. The window claims it (`claim`), unless the launch
  // has already given up on this window and claimed it itself: then the
  // prompt is not the window's to send. Once claimed, the window reads the
  // prompt and removes the handoff, whatever happens next.
  let text = null;
  let promptLine = null;
  let claimed = true;
  if (args.claimFile !== null) {
    try { claimed = claim(args.claimFile, "window"); } catch (e) { claimed = false; say(`claiming the handoff: ${e.message}`); }
  }
  if (args.promptFile !== null) {
    if (!claimed) promptLine = "reading your prompt: the launch gave up waiting for this window: your prompt was not sent";
    else {
      try { text = readFileSync(args.promptFile, "utf8"); } catch (e) { promptLine = `reading your prompt: ${e.message}: your prompt was not sent`; }
      try { rmSync(args.promptFile, { force: true }); } catch (e) { say(`removing ${args.promptFile}: ${e.message}`); }
      if (text !== null && !text.trim()) { text = null; promptLine = "reading your prompt: it is empty: nothing was sent"; }
    }
    if (promptLine) say(promptLine);
  }
  if (claimed && args.claimFile !== null) removeHandoff(dirname(args.claimFile));

  let shim;
  try { shim = discover.paths(env).shim; } catch (e) { return stop(`finding the steward: ${e.message}`); }
  if (!isExecutableFile(shim)) return stop(`finding the steward: setup's shim ${shim} is missing: run setup --apply`);
  const found = await lookUpSteward(shim, env, t);
  if (!found.ok) return stop(found.line);
  const { features, steward } = found;
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

// The kernel's features and the steward, through setup's shim. → { ok:
// true, features, steward } (findSteward's answer), or { ok: false, line }
// naming the step.
async function lookUpSteward(shim, env, t) {
  const v = await statusRead(shim, env, env.HOME, t.version, undefined, ["version", "--json"]);
  let features;
  try {
    if (!v.ok) throw new Error(kernelMessage(v));
    features = JSON.parse(v.stdout).features;
    if (!Array.isArray(features)) throw new Error("it lists no features");
  } catch (e) { return { ok: false, line: `finding the steward: oats version --json failed: ${e.message}` }; }
  const steward = await findSteward(env, { shim, features, timeoutMs: t.read, recordedFirst: true });
  if (!steward.ok) return { ok: false, line: `finding the steward: ${steward.reason}` };
  return { ok: true, features, steward };
}

// The steward's window in `hyprctl clients -j`'s output (an array of
// Hyprland's window objects): the first whose class is APP_ID, matched
// exactly. Its title is never used: it is what the terminal and tmux make
// it (Omarchy's tmux.conf sets `#h:#W`), and it is not there until the
// viewer attaches. An address that is not Hyprland's hex is never taken,
// since it goes into a dispatch. → its address, or null.
const ADDRESS = /^0x[0-9a-f]+$/;
export function findWindow(stdout) {
  let clients;
  try { clients = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(clients)) return null;
  const window = clients.find((c) => c && typeof c === "object" && c.class === APP_ID && typeof c.address === "string" && ADDRESS.test(c.address));
  return window ? window.address : null;
}

// Focuses the window at `address` as Omarchy's own launch-or-focus does:
// the Lua dispatcher first, then hyprlang's focuswindow. hyprctl exits 0
// for most refusals ("Invalid dispatcher", a Lua error), so only the reply
// "ok" is a focus. → null once focused, else why not: the reply of the form
// the config understood (the hyprlang one when the Lua form was an unknown
// dispatcher), its first line.
function focusWindow(hyprctl, env, address, timeoutMs) {
  const forms = [["dispatch", `hl.dsp.focus({ window = "address:${address}" })`], ["dispatch", "focuswindow", `address:${address}`]];
  const replies = [];
  for (const args of forms) {
    const r = run(hyprctl, args, { env, timeoutMs });
    if (r.ok && r.stdout.trim() === "ok") return null;
    replies.push(r.error ? r.error : (r.stdout.trim() || r.stderr.trim()).split("\n")[0].replace(/^error: /, "") || `exit ${r.status}`);
  }
  return replies[0] === "Invalid dispatcher" ? replies[1] : replies[0];
}

// The prompt for a steward whose window is open: sent from here, by
// deliverPrompt's rules, with no session start and no attach (the window
// has the viewer), and its result in a notification, since there is no new
// window to show it in. → a promise of the exit status.
async function sendToOpenWindow(shim, text, env, err, t) {
  const found = await lookUpSteward(shim, env, t);
  const sent = found.ok
    ? await deliverPrompt({ shim, home: found.steward.home, text, env, cwd: found.steward.deployment.path, features: found.features, timeouts: t, waitingNext: "type it in the steward's window" })
    : { delivered: false, line: `${found.line}: your prompt was not sent` };
  err.write(`${NAME}: ${sent.line}\n`);
  notify(env, sent.delivered ? "OATS steward" : "Could not send your prompt to the OATS steward", sent.line);
  return sent.delivered ? 0 : 1;
}

// The handoff between the launch and its window: a private directory (0700)
// under $XDG_RUNTIME_DIR (else the temporary directory), holding the prompt
// (0600, when there is one). Exactly one side claims it, by creating CLAIM
// (O_EXCL): the window when it starts, or the launch when it gives up on
// the window. The window's claim is the launch's evidence that it started,
// and makes the prompt the window's; the launch's makes sure no window
// will send it. The side that claims removes the handoff. → its path.
export const CLAIM = "claim";

// Removes a handoff the window claimed, and only what is one: a directory
// named as makeHandoff names them, holding nothing but the claim and the
// prompt. Anything else (an internal flag passed by hand) is left alone.
const HANDOFF_PREFIX = "oats-omarchy-launch-";
function removeHandoff(dir) {
  try {
    if (!basename(dir).startsWith(HANDOFF_PREFIX)) return;
    if (readdirSync(dir).some((name) => name !== CLAIM && name !== "prompt")) return;
    rmSync(dir, { recursive: true, force: true });
  } catch { /* already gone */ }
}

// → true when `who` claimed the handoff; false when the other side had
// (the file is there), or had claimed and removed it (no directory).
export function claim(path, who) {
  try { writeFileSync(path, `${who}\n`, { flag: "wx", mode: 0o600 }); return true; } catch (e) {
    if (e.code === "EEXIST" || e.code === "ENOENT") return false;
    throw e;
  }
}
// $XDG_RUNTIME_DIR when it is a directory, else null.
function runtimeDir(env) {
  const runtime = env.XDG_RUNTIME_DIR;
  try { if (runtime && isAbsolute(runtime) && statSync(runtime).isDirectory()) return runtime; } catch { /* not there */ }
  return null;
}

export function makeHandoff(text, env) {
  const dir = mkdtempSync(join(runtimeDir(env) || tmpdir(), HANDOFF_PREFIX));
  if (text === null) return dir;
  try {
    const fd = openSync(join(dir, "prompt"), "wx", 0o600);
    try {
      const bytes = Buffer.from(text, "utf8");
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
    } finally { closeSync(fd); }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

// The window: `omarchy-launch-tui --app-id=org.omarchy.agent.oats-steward <node>
// <plugin>/bin/launch.mjs --in-terminal --claim-file <handoff>/claim
// [--prompt-file <handoff>/prompt]`.
export const windowArgv = ({ node = process.execPath, handoff, prompt = false }) =>
  [`--app-id=${APP_ID}`, node, LAUNCH_SCRIPT, "--in-terminal", "--claim-file", join(handoff, CLAIM), ...(prompt ? ["--prompt-file", join(handoff, "prompt")] : [])];

// The launch lock: one launch at a time looks for the steward's window and
// opens it, so two presses before the first window maps open one window. It
// is held from the window lookup until the launched window claims its
// handoff (it is up by then), or the launch gives up; a press that waits for
// it looks again and focuses that window. The lock is a Unix socket the
// holder listens on: binding its address fails while a process holds it,
// and on Linux the address is in the abstract namespace, which the kernel
// frees when the holder ends however it ends, so a launch that died leaves
// nothing to take over and nothing is ever removed on a reading. Elsewhere
// (macOS, where the tests also run) it is a socket file in the runtime
// directory, and one nobody answers on is removed: a development stand-in
// that can race. A press that cannot get the lock within its wait goes on
// without it; every wait is bounded and yields.
export const LAUNCH_LOCK = "oats-omarchy-launch";
export function launchLockAddress(env) {
  const name = `${LAUNCH_LOCK}.${process.getuid?.() ?? "user"}`;
  return process.platform === "linux" ? `\0${name}` : join(runtimeDir(env) || tmpdir(), `${name}.sock`);
}
const listenOn = (address) => new Promise((done) => {
  const server = createServer();
  server.once("error", (error) => done({ error }));
  server.listen(address, () => { server.unref(); done({ server }); });
});
// Whether a socket file at `address` has nobody listening: left by a launch
// that died (never on Linux, whose address is abstract).
const abandoned = (address) => new Promise((done) => {
  const c = connect(address);
  c.once("connect", () => { c.destroy(); done(false); });
  c.once("error", (e) => done(e.code === "ECONNREFUSED"));
});
// → the listening server once this process holds the lock, or null when it
// could not get it within `waitMs`.
async function takeLaunchLock(address, waitMs, pollMs) {
  const end = Date.now() + waitMs;
  for (;;) {
    const r = await listenOn(address);
    if (r.server) return r.server;
    if (r.error.code !== "EADDRINUSE") return null;
    if (!address.startsWith("\0") && await abandoned(address)) { try { unlinkSync(address); } catch { /* removed meanwhile */ } }
    if (Date.now() >= end) return null;
    await sleep(pollMs);
  }
}
function releaseLaunchLock(server, address) {
  server.close();
  if (!address.startsWith("\0")) { try { unlinkSync(address); } catch { /* already gone */ } }
}

// An Omarchy notification, when its notifier is there (its failure ignored).
function notify(env, headline, line) {
  const notifier = which(discover.NOTIFY, env.PATH);
  if (notifier) run(notifier, [headline, line], { env, timeoutMs: 10_000 });
}

// Before the window: one line on stderr and a notification. → 1.
function refuse(env, err, line) {
  err.write(`${NAME}: ${line}\n`);
  notify(env, "Could not open the OATS steward", line);
  return 1;
}

// The command. → a promise of the exit status, or of a signal to raise
// again (bin/launch.mjs). `windowStartMs` and `pollMs` are for tests.
export async function launch(argv, env = process.env, { err = process.stderr, out = process.stdout, pause, timeouts, windowStartMs = WINDOW_START, pollMs = 50 } = {}) {
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

  // Launch or focus, under the launch lock. Hyprland is asked for the
  // steward's window first; with no hyprctl, or no Hyprland answering, there
  // is no window to find. A window that will not focus is reported, never
  // answered with a second. A prompt for an open window is sent once the lock
  // is released, so it never holds up another press.
  const t = { ...TIMEOUTS, ...timeouts };
  const address = launchLockAddress(env);
  const lock = await takeLaunchLock(address, windowStartMs + 2 * t.hyprctl, pollMs);
  let opened;
  try { opened = await launchOrFocus(args, env, { err, shim, t, windowStartMs, pollMs }); } finally { if (lock) releaseLaunchLock(lock, address); }
  if (opened.focused && args.prompt !== null) return sendToOpenWindow(shim, args.prompt, env, err, t);
  return opened.code;
}

// The steward's window focused when it is open, else opened. → { code,
// focused }: focused when an open window took the focus.
async function launchOrFocus(args, env, { err, shim, t, windowStartMs, pollMs }) {
  const hyprctl = which(HYPRCTL, env.PATH);
  const listed = hyprctl ? run(hyprctl, ["clients", "-j"], { env, timeoutMs: t.hyprctl }) : null;
  const address = listed?.ok ? findWindow(listed.stdout) : null;
  if (address) {
    const why = focusWindow(hyprctl, env, address, t.hyprctl);
    if (why !== null) return { code: refuse(env, err, `the steward's window is open, but Hyprland did not focus it: ${why}`) };
    return { code: 0, focused: true };
  }

  const launcher = which(LAUNCH_TUI, env.PATH);
  if (!launcher) return { code: refuse(env, err, `${LAUNCH_TUI} is not on PATH: it opens the agent window`) };

  let handoff;
  try { handoff = makeHandoff(args.prompt, env); } catch (e) { return { code: refuse(env, err, `preparing the window: ${e.message}`) }; }
  // The window outlives this command: it is started on its own, with this
  // command's output, as omarchy-agent's exec gives it. Omarchy's launcher
  // runs the terminal in the foreground (uwsm-app's scope), and may hand it
  // to a service and end, so neither its running nor its exit says that the
  // window opened: only the window's claim on the handoff does. A launcher
  // that fails, or no claim within `windowStartMs`, makes the launch claim
  // it instead, unless the window's claim came first.
  const claimPath = join(handoff, CLAIM);
  const windowClaimed = () => existsSync(claimPath) || !existsSync(handoff);
  const child = spawn(launcher, windowArgv({ handoff, prompt: args.prompt !== null }), { env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; clearInterval(poll); clearTimeout(timer); resolve(r); };
    const giveUp = (why) => {
      if (settled) return;
      let mine;
      try { mine = claim(claimPath, "launch"); } catch (e) { mine = true; why = `${why} (${e.message})`; }
      done(mine ? { why } : { started: true });
    };
    const poll = setInterval(() => { if (windowClaimed()) done({ started: true }); }, pollMs);
    const timer = setTimeout(() => giveUp(`the window did not start within ${Math.round(windowStartMs / 1000)} s`), windowStartMs);
    child.once("error", (e) => giveUp(e.message));
    child.once("exit", (status, signal) => {
      if (signal) giveUp(`ended by ${signal} before the window started`);
      else if (status !== 0) giveUp(`exited with status ${status} before the window started`);
      // 0: handed to a service; the claim, or the deadline, decides.
    });
  });
  if (result.started) { child.unref(); return { code: 0 }; }
  rmSync(handoff, { recursive: true, force: true });
  return { code: refuse(env, err, `${LAUNCH_TUI}: ${result.why}${args.prompt !== null ? ": your prompt was not sent" : ""}`) };
}

// bin/launch.mjs's end: exit with `code`, or raise a child's signal again.
export function exit(code) {
  if (typeof code === "number") process.exit(code);
  process.kill(process.pid, code);
  // A signal whose default does not end a process: its exit status.
  process.exit(128 + (osConstants.signals[code] || 0));
}
