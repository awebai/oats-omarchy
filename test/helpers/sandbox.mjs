// A temporary HOME, XDG directories, deployment and PATH of fakes, for
// running the plugin's setup and waiting without touching the machine. Each fake models
// the real tool's output and its refusals, not only its success.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BIN = { setup: join(repo, "bin", "setup.mjs"), waiting: join(repo, "bin", "waiting.mjs") };
export const fixture = (...parts) => join(repo, "test", "fixtures", ...parts);

const LAUNCHERS = [
  "omarchy-launch-or-focus-tui", "omarchy-launch-or-focus", "uwsm-app", "omarchy-hook",
  "omarchy-menu-select", "omarchy-launch-floating-terminal-with-presentation", "omarchy-notification-send",
];

// A small stand-in for Omarchy's menu definition: setup only needs it to be
// there; the container test reads the real one.
const MENU_DEFAULTS = `{
  // Omarchy menu definition (a test stand-in).
  "apps": {"icon":"a","label":"Apps","provider":"apps"},
  "system": {"icon":"s","label":"System"},
  "system.lock": {"icon":"l","label":"Lock","action":"omarchy-system-lock"},
}
`;
// The only host programs on the sandbox's PATH: a shell and the few tools the
// fakes and the hook use, linked into a private directory. /usr/bin itself is
// not on the PATH, because on Omarchy it holds the real launchers.
const HOST_TOOLS = ["sh", "bash", "cat", "echo", "printf", "mkdir", "head", "env", "rm", "ls", "dirname", "cp", "grep"];

// The kernel stand-in's `status --json` (run without --dir, as findSteward
// runs it in each deployment) lists these instances of oats.machine's
// steward agent (lib/steward.mjs STEWARD_AGENT): setup moves the agent key
// to OATS only when it finds exactly one.
export function withStewards(s, names = ["steward"]) {
  const home = (name) => join(s.deployment, "agents", "oats-machine--steward", "instances", name);
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ root: join(s.deployment, "agents"), agents: [{ name: "oats-machine--steward", instances: names.map((instance) => ({ instance, home: home(instance) })) }] }));
}

// Removes `path`, a file or link the test made, only when it is inside the
// sandbox `root`: its directory, resolved, is under it. A path setup recorded
// can be the host's own (the node, which the stable-node rule may record as
// Homebrew's /opt/homebrew/opt/node/bin/node, a link into the real keg), and
// a test must never delete that, so anything else throws.
export function removeInSandbox(root, path) {
  const dir = realpathSync(dirname(path));
  if (dir !== root && !dir.startsWith(`${root}/`)) throw new Error(`refusing to remove ${path}: it is outside the sandbox ${root} (in ${dir})`);
  unlinkSync(path);
}

export function writeExecutable(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// options:
//   launchers: true | false | [names]   the Omarchy commands on PATH
//   print: "fixture" | "no-hyprland" | "fail" | <text>   omarchy menu keybindings --print
//   session: false | <PATH string>      systemctl --user show-environment
//   fuse: true | false                  ldconfig -p lists libfuse.so.2
//   tmux: true | false
//   kernel: "ok" | "fail" | "none" | "home-shim" | "mise" | "mise-fail"
//                                       `oats` on PATH: the fake CLI linked
//                                       there; one that fails; none; the CLI
//                                       inside an instance home's .oats/bin;
//                                       a mise shim that `mise which oats`
//                                       resolves to the CLI, or does not
//   node: true | false                  `node` on PATH (a link to this node)
//   hyprland: true | false              `Hyprland` on PATH: a fake --verify-config
//                                       that logs its environment to
//                                       <root>/hyprland.log and refuses a
//                                       bindings.lua holding BREAKS_VERIFY, or
//                                       setup's block when FAKE_HYPR_REFUSE_BLOCK=1;
//                                       with FAKE_HYPR_SAVE_TO=<file>, checking
//                                       setup's block appends a line to <file>
//                                       (an editor saving meanwhile)
//   deploymentName: string
//   menu: true | false                  Omarchy's menu definition is there ($OMARCHY_PATH)
//   shell: false | "ok" | "unknown"     `omarchy-shell` on PATH: none (no
//                                       shell runs), or one that logs its
//                                       arguments to <root>/shell.log and
//                                       answers a summon with that word (the
//                                       popup opened, or the plugin is off)
// The kernel stand-in answers `status --json` from <root>/status.json (and
// <root>/status.mode: "envelope", "stderr" or "hang" for a failure) and
// `version --json` from <root>/version.json; files a test writes. With
// `--dir <d>`, status answers from <d>/status.json and <d>/status.mode
// instead, and `status --dir <d>` (text) prints a line naming <d>, or
// hangs as the JSON read does. When
// version.json lists the feature deployments-list, `deployments --json`
// answers the kernel's envelope around <root>/deployments.json (a result a
// test writes, else an empty list); <root>/deployments.mode "envelope" makes
// it fail, and "hang" makes it never answer (its pids in deployments.pids). Without the feature, deployments is refused as an older CLI does.
// FAKE_SELECT picks in omarchy-menu-select: "cancel" (the default), "first",
// or the text to return. FAKE_FLOATING_RUN=1 makes the floating terminal run
// its command with bash -c, as the real one does.
export function sandbox(t, options = {}) {
  const o = { launchers: true, print: "fixture", session: false, fuse: true, tmux: true, kernel: "ok", node: false, hyprland: true, deploymentName: "deployment", menu: true, shell: false, ...options };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oats-omarchy-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const fakebin = join(root, "fakebin");
  const deployment = join(root, o.deploymentName);
  const hostbin = join(root, "hostbin");
  for (const d of [home, fakebin, hostbin, deployment, join(root, "kernel")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(deployment, "oats-local.yaml"), "# a test deployment\n");
  for (const tool of HOST_TOOLS) {
    const found = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((f) => existsSync(f));
    if (found) symlinkSync(found, join(hostbin, tool));
  }

  const launchers = o.launchers === true ? LAUNCHERS : o.launchers === false ? [] : o.launchers;
  for (const name of launchers) writeExecutable(join(fakebin, name), `#!/bin/sh\necho "${name} $*" >> "${join(root, "launched.log")}"\n`);
  // The menu's commands, with the real ones' refusals: the selector needs a
  // prompt and at least one option (it never opens empty), the notifier a
  // headline. Each logs its arguments one per line, then "--".
  const logArgs = (log) => `for a; do printf '%s\\n' "$a"; done >> "${join(root, log)}"; echo -- >> "${join(root, log)}"`;
  if (launchers.includes("omarchy-menu-select")) writeExecutable(join(fakebin, "omarchy-menu-select"), `#!/bin/bash
${logArgs("select.log")}
if (( $# < 2 )); then echo "Usage: omarchy-menu-select <prompt> [option...] [-- menu args...]" >&2; exit 1; fi
case "\${FAKE_SELECT:-cancel}" in
  cancel) exit 1 ;;
  first) printf '%s\\n' "$2" ;;
  *) printf '%s\\n' "$FAKE_SELECT" ;;
esac
`);
  if (launchers.includes("omarchy-notification-send")) writeExecutable(join(fakebin, "omarchy-notification-send"), `#!/bin/bash
if (( $# < 1 )); then echo "Usage: omarchy-notification-send [options] <headline> [description]" >&2; exit 1; fi
${logArgs("notify.log")}
`);
  if (launchers.includes("omarchy-launch-floating-terminal-with-presentation")) writeExecutable(join(fakebin, "omarchy-launch-floating-terminal-with-presentation"), `#!/bin/bash
cmd="$*"
printf '%s\\n' "$cmd" >> "${join(root, "floating.log")}"
if [[ -n $FAKE_FLOATING_RUN ]]; then bash -c "$cmd"; fi
exit 0
`);
  if (o.shell) writeExecutable(join(fakebin, "omarchy-shell"), `#!/bin/sh
printf '%s\\n' "$*" >> "${join(root, "shell.log")}"
[ "$2" = summon ] && echo ${o.shell}
exit 0
`);

  const printText = o.print === "fixture" ? readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8")
    : o.print === "no-hyprland" ? readFileSync(fixture("print", "no-hyprland.txt"), "utf8")
    : o.print === "fail" ? null : o.print;
  writeFileSync(join(root, "print.txt"), printText ?? "");
  // Like the real one: --print writes its cache under $XDG_CACHE_HOME/omarchy.
  writeExecutable(join(fakebin, "omarchy"), `#!/bin/sh
if [ "$1 $2 $3" = "menu keybindings --print" ]; then
  mkdir -p "\${XDG_CACHE_HOME:-$HOME/.cache}/omarchy" && echo "$XDG_CACHE_HOME" >> "${join(root, "print-cache.log")}"
  ${printText === null ? 'echo "hyprctl: no running Hyprland" >&2; exit 1' : `cat "${join(root, "print.txt")}"`}
  exit 0
fi
echo "omarchy: unknown command $*" >&2; exit 1
`);

  writeExecutable(join(fakebin, "systemctl"), o.session
    ? `#!/bin/sh\n[ "$1 $2" = "--user show-environment" ] || exit 1\necho "HOME=${home}"\necho "PATH=${o.session}"\necho "XDG_RUNTIME_DIR=/run/user/1000"\n`
    : `#!/bin/sh\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n`);
  writeExecutable(join(fakebin, "ldconfig"), `#!/bin/sh
[ "$1" = "-p" ] || exit 1
echo "1234 libs found in cache \\\`/etc/ld.so.cache'"
echo "	libz.so.1 (libc6,x86-64) => /usr/lib/libz.so.1"
${o.fuse ? 'echo "	libfuse.so.2 (libc6,x86-64) => /usr/lib/libfuse.so.2"' : ""}
echo "	libfuse3.so.4 (libc6,x86-64) => /usr/lib/libfuse3.so.4"
`);
  if (o.tmux) writeExecutable(join(fakebin, "tmux"), "#!/bin/sh\nexit 0\n");
  if (o.hyprland) writeExecutable(join(fakebin, "Hyprland"), `#!/bin/bash
[[ $1 == --verify-config && $2 == -c && -n $3 ]] || { echo "fake Hyprland: $*" >&2; exit 2; }
printf '%s\\n' "config=$3" "HOME=$HOME" "XDG_CONFIG_HOME=$XDG_CONFIG_HOME" "XDG_STATE_HOME=$XDG_STATE_HOME" "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" "WAYLAND_DISPLAY=\${WAYLAND_DISPLAY-unset}" "HYPRLAND_INSTANCE_SIGNATURE=\${HYPRLAND_INSTANCE_SIGNATURE-unset}" "--" >> "${join(root, "hyprland.log")}"
bindings="$(dirname "$3")/bindings.lua"
cp "$bindings" "${join(root, "hyprland-saw.lua")}" 2>/dev/null
if [[ -n $FAKE_HYPR_SAVE_TO ]] && grep -q '>>> oats-omarchy' "$bindings"; then printf -- '-- concurrent save\n' >> "$FAKE_HYPR_SAVE_TO"; fi
echo "Hyprland 0.56.2 (fake)"
if grep -q BREAKS_VERIFY "$bindings" 2>/dev/null || { [[ -n $FAKE_HYPR_REFUSE_BLOCK ]] && grep -q '>>> oats-omarchy' "$bindings"; }; then
  echo "======== Config parsing result:"
  echo "config error in $bindings:3: attempt to call a nil value (field 'define_submap')"
  exit 1
fi
echo "======== Config parsing result:"
echo "config ok"
`);

  // A stand-in for the kernel's CLI, run as `oats` from PATH and by the shim
  // setup writes: `version --json` (from <root>/version.json) and
  // `status --json`. Anything else is logged and refused.
  const cliText = o.kernel === "fail" ? `#!/usr/bin/env node\nconsole.error("Error: Cannot find module 'yaml'"); process.exit(1);\n` : `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const [cmd, ...rest] = process.argv.slice(2);
const fake = (name) => { try { return readFileSync(${JSON.stringify(root)} + "/" + name, "utf8"); } catch { return null; } };
const version = fake("version.json") || JSON.stringify({ version: "0.60.0", features: ["session-attach-detach-key"] });
const dirAt = rest.indexOf("--dir");
const dir = dirAt >= 0 ? rest[dirAt + 1] : null;
const args = dirAt >= 0 ? [...rest.slice(0, dirAt), ...rest.slice(dirAt + 2)] : rest;
if (cmd === "status" && dir) appendFileSync(${JSON.stringify(root)} + "/status-dirs.log", dir + "\\n");
const at = (name) => { if (!dir) return fake(name); try { return readFileSync(dir + "/" + name, "utf8"); } catch { return null; } };
if (cmd === "status" && dir && args.length === 0 && (at("status.mode") || "").trim() !== "hang") { console.log("oats status — agents root " + dir + "/agents"); process.exit(0); }
if (cmd === "deployments" && rest.join(" ") === "--json") {
  if (!JSON.parse(version).features?.includes("deployments-list")) {
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_UNKNOWN_COMMAND", message: "unknown command: deployments" } })); process.exit(2);
  }
  if ((fake("deployments.mode") || "").trim() === "hang") {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    appendFileSync(${JSON.stringify(root)} + "/deployments.pids", process.pid + " " + child.pid + "\\n");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if ((fake("deployments.mode") || "").trim() === "envelope") { console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_DEPLOYMENTS_INVALID", message: "deployments.json cannot be read as this computer's deployments list (not JSON)" } })); process.exit(1); }
  const result = JSON.parse(fake("deployments.json") || JSON.stringify({ deploymentsApi: 1, file: ${JSON.stringify(join(home, ".oats", "config", "deployments.json"))}, deployments: [], imports: {} }));
  console.log(JSON.stringify({ schemaVersion: 1, ok: true, result })); process.exit(0);
}
if (cmd === "status" && (args.join(" ") === "--json" || (dir && args.length === 0))) {
  const mode = (at("status.mode") || "").trim();
  if (mode === "hang") {
    // A kernel that never answers, with a child of its own; both pids logged.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    appendFileSync(${JSON.stringify(root)} + "/status.pids", process.pid + " " + child.pid + "\\n");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (mode === "envelope") { console.log(JSON.stringify({ ok: false, error: { code: "E_LOCK", message: "oats-lock.json is unreadable: Unexpected end of JSON input" } })); process.exit(1); }
  else if (mode === "stderr") { console.error("oats: no oats-local.yaml at or above " + process.cwd()); process.exit(1); }
  else { process.stdout.write(at("status.json") || JSON.stringify({ root: dir || process.cwd(), agents: [] })); process.exit(0); }
}
if (cmd === "version" && rest.join(" ") === "--json") { process.stdout.write(version); process.exit(0); }
appendFileSync(${JSON.stringify(join(root, "kernel.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.error("fake kernel: " + process.argv.slice(2).join(" ")); process.exit(1);
`;
  const cli = o.kernel === "home-shim"
    ? join(deployment, "agents", "a", "instances", "a-1", ".oats", "bin", "oats")
    : join(root, "kernel", "lib", "node_modules", "@awebai", "oats", "bin", "oats.mjs");
  writeExecutable(cli, cliText);
  if (o.kernel === "mise" || o.kernel === "mise-fail") {
    const mise = join(root, "mise", "bin", "mise");
    writeExecutable(mise, o.kernel === "mise"
      ? `#!/bin/sh\nif [ "$1 $2" = "which oats" ]; then echo '${cli}'; exit 0; fi\necho "mise: unknown $*" >&2; exit 1\n`
      : `#!/bin/sh\necho "mise ERROR oats is not a mise bin" >&2\nexit 1\n`);
    symlinkSync(mise, join(fakebin, "oats"));
  } else if (o.kernel !== "none") symlinkSync(cli, join(fakebin, "oats"));
  if (o.node) symlinkSync(process.execPath, join(hostbin, "node"));

  if (o.menu) {
    mkdirSync(join(root, "omarchy", "default", "omarchy"), { recursive: true });
    writeFileSync(join(root, "omarchy", "default", "omarchy", "omarchy-menu.jsonc"), MENU_DEFAULTS);
  }

  const path = `${fakebin}:${hostbin}`;
  const env = {
    HOME: home, PATH: path, LANG: "C.UTF-8",
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_DIRS: join(root, "system-share"),
    OMARCHY_PATH: join(root, "omarchy"),
  };

  // run(["setup" | "waiting", ...args]): that command, from the deployment.
  // setup's --apply and --remove get --yes unless `yes: false` (no terminal
  // here to confirm in).
  const run = ([command, ...args], extra = {}, { cwd = deployment, yes = true } = {}) => {
    const confirm = command === "setup" && yes && !args.includes("--yes") && (args.includes("--apply") || args.includes("--remove"));
    const r = spawnSync(process.execPath, [BIN[command], ...args, ...(confirm ? ["--yes"] : [])], { env: { ...env, ...extra }, cwd, encoding: "utf8", timeout: 60_000 });
    let json = null;
    if (args.includes("--json")) { try { json = JSON.parse(r.stdout); } catch { /* left null; the test says so */ } }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  return { root, home, fakebin, deployment, env, cli, run, path };
}

// Every file, directory and link under `dir`: path → mode and bytes.
export function snapshot(dir, { exclude = [] } = {}) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (exclude.includes(r)) continue;
      const st = lstatSync(path);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isDirectory()) { out.set(r, `dir ${mode}`); walk(path, r); }
      else if (st.isSymbolicLink()) out.set(r, `link ${readlinkSync(path)}`);
      else out.set(r, `file ${mode} ${readFileSync(path).toString("base64")}`);
    }
  };
  walk(dir, "");
  return out;
}
