// A temporary machine for `omarchy-install-oats` (test/install.test.mjs, and
// test/omarchy-container.test.mjs against the real Omarchy): a HOME, XDG
// directories and a PATH of stand-ins laid out the way each origin really is
// (mise installs and shims, an npm global prefix, ~/.local/bin, nvm,
// Omarchy's lazy wrappers, an instance's shim). Each stand-in logs what it
// was asked and models refusals. Nothing is installed for real, and no
// harness, mise or installer of the host runs.
//
// world(t, { system }) puts `system` (directories) at the end of PATH in
// place of the few linked host tools, and leaves out the stand-ins of the
// Omarchy commands found there.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fakeKernel } from "./fake-kernel.mjs";
import { fixture, repo, writeExecutable } from "./sandbox.mjs";
import { paths as discoverPaths } from "../../lib/discover.mjs";
import { agentBindLine } from "../../lib/keys.mjs";
import { STATE_SCHEMA } from "../../lib/state.mjs";

export const INSTALLER = join(repo, "bin", "omarchy-install-oats");
const TTY = join(repo, "test", "helpers", "tty.py");
// The host's python3, which runs it (the sandbox's PATH has none).
const PYTHON = (process.env.PATH || "").split(":").filter(Boolean).map((d) => join(d, "python3")).find((f) => existsSync(f));
export const STATUS = JSON.parse(readFileSync(fixture("steward", "status-0.67.1.json"), "utf8"));
// git is the host's own, run against this HOME's ~/.gitconfig only
// (GIT_CONFIG_NOSYSTEM), for github.com's credential helper.
const HOST_TOOLS = ["sh", "grep", "head", "readlink", "dirname", "basename", "mkdir", "cat", "env", "rm", "ln", "mv", "tr", "sort", "printf", "chmod", "sed", "git"];
const NPM_PKG = { aw: "@awebai/aw", oats: "@awebai/oats", claude: "@anthropic-ai/claude-code", codex: "@openai/codex", pi: "@mariozechner/pi-coding-agent" };
const MISE_DIR = { node: "node", tmux: "tmux", aw: "npm-awebai-aw", oats: "npm-awebai-oats", claude: "claude", codex: "codex", pi: "pi", gh: "gh" };
// Every scope the installer's GitHub sign-in asks for (GH_SCOPES).
export const GH_SCOPES = ["repo", "read:org", "gist", "admin:ssh_signing_key", "user:email"];

// The machine. PATH is Omarchy's order: mise's shims before ~/.local/bin.
export function world(t, { npmPrefix, system } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oats-omarchy-install-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const hostbin = join(root, "hostbin");
  const other = join(root, "other", "bin");
  const npm = npmPrefix || join(root, "npm");
  const miseData = join(home, ".local", "share", "mise");
  const shims = join(miseData, "shims");
  const localBin = join(home, ".local", "bin");
  for (const d of [home, bin, hostbin, other, join(npm, "bin"), shims, localBin, join(root, "mise", "which"), join(root, "mise", "plan"), join(root, "claude"), join(root, "gh")]) mkdirSync(d, { recursive: true });
  for (const tool of HOST_TOOLS) {
    const found = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((f) => existsSync(f));
    if (found) symlinkSync(found, join(hostbin, tool));
  }
  const extra = [];
  const env = () => ({
    HOME: home, LANG: "C.UTF-8", PATH: [bin, shims, localBin, join(npm, "bin"), ...extra, other, ...(system || [hostbin])].join(":"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const log = (name) => (existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : "");
  const logArgs = (name) => `for a; do printf '%s\\n' "$a"; done >> '${join(root, name)}'; echo -- >> '${join(root, name)}'`;

  // Omarchy and the system's commands. mise's shims are links to mise, which
  // runs what `mise which` names when it is called by a tool's name.
  writeExecutable(join(bin, "mise"), `#!/bin/sh
n=\${0##*/}
if [ "$n" != mise ]; then
  f=$(cat '${join(root, "mise", "which")}'/"$n" 2>/dev/null) || { echo "mise ERROR $n is not installed" >&2; exit 127; }
  exec "$f" "$@"
fi
${logArgs("mise.log")}
case "$1" in
  which | where) [ -f '${join(root, "mise", "which")}'/"$2" ] || { echo "mise ERROR $2 is not installed" >&2; exit 1; }; cat '${join(root, "mise", "which")}'/"$2" ;;
  use)
    plan='${join(root, "mise", "plan")}'/$(printf '%s' "$3" | tr -c 'A-Za-z0-9' _)
    [ -f "$plan" ] || { echo "mise ERROR no plan for $3" >&2; exit 1; }
    sh "$plan" ;;
  *) echo "mise ERROR $*" >&2; exit 1 ;;
esac
`);
  writeExecutable(join(bin, "npm"), `#!/bin/sh\n[ "$1 $2" = "prefix -g" ] && { echo '${npm}'; exit 0; }\necho "npm: $*" >&2; exit 1\n`);
  writeExecutable(join(bin, "omarchy-pkg-add"), `#!/bin/sh\n${logArgs("pkg.log")}\nplan='${join(root, "pkg-plan")}'\n[ -f "$plan" ] && exec sh "$plan"\necho "error: target not found: $1" >&2; exit 1\n`);
  if (!system) writeExecutable(join(bin, "omarchy-version"), "#!/bin/sh\necho 4.0.4-1\n");
  writeExecutable(join(bin, "omarchy-launch-floating-terminal-with-presentation"), `#!/bin/sh\n${logArgs("floating.log")}\n`);
  writeExecutable(join(bin, "xdg-open"), `#!/bin/sh\n${logArgs("xdg-open.log")}\n`);
  const setDefaultAgent = (agent) => writeExecutable(join(bin, "omarchy-default-agent"), `#!/bin/sh\n${agent ? `echo ${agent}` : ""}\n`);
  if (!system) setDefaultAgent(null);

  const kernel = fakeKernel({ root, env: { XDG_DATA_HOME: join(root, "unused-shim") } });

  // A tool's executable, as it answers for itself.
  const script = (tool, version) => {
    switch (tool) {
      case "node": return `#!/bin/sh\n[ "$1" = --version ] && { echo v${version}; exit 0; }\nexec '${process.execPath}' "$@"\n`;
      case "tmux": return `#!/bin/sh\n[ "$1" = -V ] && { echo "tmux ${version}"; exit 0; }\nexit 1\n`;
      case "aw": return `#!/bin/sh
case "$1" in
  version) echo "aw ${version}"; echo "  commit: 0000" ;;
  whoami)
    { echo "cwd=$(pwd)"; env | grep -E '^(AWEB|AW)_' | sort; echo --; } >> '${join(root, "aw.log")}'
    [ -f '${join(root, "whoami.json")}' ] && cat '${join(root, "whoami.json")}' || { echo "no identity here" >&2; exit 1; } ;;
  *) echo "aw: $*" >&2; exit 1 ;;
esac
`;
      case "claude": return `#!/bin/sh
c='${join(root, "claude")}'
case "$1" in
  --version) echo "${version} (Claude Code)"; exit 0 ;;
  plugin)
    [ -f "$c/no-plugin" ] && { echo "error: unknown command 'plugin'" >&2; exit 1; }
    ${logArgs("claude-plugin.log")}
    echo "$PWD" >> '${join(root, "claude-plugin.cwd")}'
    case "$2 $3" in
      # enabled is the merged settings of the directory it runs in: a
      # project's .claude/settings.json can turn the plugin off there.
      "list --json")
        if grep -q '"aweb-channel@awebai-marketplace": *false' .claude/settings.json 2>/dev/null; then
          sed 's/"enabled": true/"enabled": false/' "$c/plugins.json" 2>/dev/null || echo '[]'
        else
          cat "$c/plugins.json" 2>/dev/null || echo '[]'
        fi ;;
      "marketplace list") cat "$c/marketplaces.json" 2>/dev/null || echo '[]' ;;
      "marketplace add") [ -f "$c/fail-marketplace" ] && { echo "failed to clone $4" >&2; exit 1; }; echo '[{"name":"awebai-marketplace","source":"github","repo":"awebai/claude-plugins"}]' > "$c/marketplaces.json" ;;
      "install aweb-channel@awebai-marketplace") printf '%s\\n' '[' '  {' '    "id": "aweb-channel@awebai-marketplace",' '    "version": "1.7.11",' '    "scope": "user",' '    "enabled": true' '  }' ']' > "$c/plugins.json" ;;
      *) echo "claude: $*" >&2; exit 1 ;;
    esac
    exit 0 ;;
esac
'${process.execPath}' -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))' '${join(root, "harness.json")}' "$@"
`;
      // gh as v2.102.0 behaves (cli/cli pkg/cmd/auth): `auth status --json
      // hosts --jq <expr>` prints what the installer's expression selects, here
      // gh/status ("<login> <scopes, comma and space>", as the X-OAuth-Scopes
      // header gives them), or nothing when not signed in, and exits 0 either
      // way, as --json does. `auth login` and `auth refresh` with no terminal
      // on stdin ask nothing: they print the one-time code and wait for the
      // browser approval (here: gh/fail makes it fail), then sign in with the
      // scopes given (refresh adds them to the token's). Each auth call is
      // logged with whether stdin was a terminal.
      case "gh": return `#!/bin/sh
g='${join(root, "gh")}'
case "$1" in
  --version) echo "gh version ${version} (2026-09-30)"; echo "https://github.com/cli/cli/releases/tag/v${version}"; exit 0 ;;
  auth)
    { for a; do printf '%s\\n' "$a"; done; if [ -t 0 ]; then echo stdin=terminal; else echo stdin=none; fi; echo --; } >> '${join(root, "gh.log")}'
    case "$2" in
      status) cat "$g/status" 2>/dev/null; exit 0 ;;
      login | refresh)
        echo "! First copy your one-time code: 1A2B-3C4D" >&2
        echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
        [ -f "$g/fail" ] && { echo "failed to authenticate via web browser: the code expired" >&2; exit 1; }
        prev= s=
        for a; do [ "$prev" = --scopes ] && s=$a; prev=$a; done
        if [ "$2" = login ]; then login=$(cat "$g/login" 2>/dev/null || echo octo-person); have=; else line=$(cat "$g/status"); login=\${line%% *}; have=$(printf '%s' "\${line#* }" | tr -d ' '); fi
        all=$(printf '%s' "\${have:+\$have,}$s" | tr ',' '\\n' | sed '/^$/d' | tr '\\n' ',' | sed 's/,$//; s/,/, /g')
        printf '%s %s\\n' "$login" "$all" > "$g/status"
        exit 0 ;;
      # As gh's ConfigureOurs (cli/cli v2.102.0): for github.com and its gist
      # host, --global, an empty helper, then gh's.
      setup-git)
        [ -f "$g/fail-setup-git" ] && { echo "failed to set up git credential helper" >&2; exit 1; }
        for key in credential.https://github.com.helper credential.https://gist.github.com.helper; do
          git config --global --replace-all "$key" "" && git config --global --add "$key" "!'$0' auth git-credential" || exit 1
        done
        exit 0 ;;
    esac ;;
esac
echo "gh: $*" >&2; exit 1
`;
      default: return `#!/bin/sh
[ "$1" = --version ] && { echo "${tool} ${version}"; exit 0; }
'${process.execPath}' -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))' '${join(root, "harness.json")}' "$@"
`;
    }
  };
  // The oats package: bin/oats.mjs (the fake kernel), package.json and the
  // getting-started skill, under a node_modules directory.
  const oatsPackage = (modules, version) => {
    const pkg = join(modules, "@awebai", "oats");
    mkdirSync(join(pkg, "skills", "oats-getting-started"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@awebai/oats", version }));
    writeFileSync(join(pkg, "skills", "oats-getting-started", "SKILL.md"), "# getting started\n");
    writeFileSync(join(kernel.k, "version.json"), JSON.stringify({ schemaVersion: 1, name: "@awebai/oats", version, features: ["deployments-list", "session-attach-detach-key", "session-inspect-running", "waiting-on-you"] }));
    writeExecutable(join(pkg, "bin", "oats.mjs"), `#!/bin/sh\nexec '${process.execPath}' '${join(kernel.k, "oats.mjs")}' "$@"\n`);
    return join(pkg, "bin", "oats.mjs");
  };
  const npmFile = (prefix, tool, version) => {
    if (tool === "oats") return oatsPackage(join(prefix, "lib", "node_modules"), version);
    const file = join(prefix, "lib", "node_modules", ...NPM_PKG[tool].split("/"), "bin", tool);
    writeExecutable(file, script(tool, version));
    return file;
  };

  // Puts `tool` at `version` where `origin` puts it.
  function put(tool, origin, version) {
    if (origin === "mise") {
      const base = join(miseData, "installs", MISE_DIR[tool], version);
      const file = ["aw", "oats"].includes(tool) ? npmFile(base, tool, version) : join(base, "bin", tool);
      if (!["aw", "oats"].includes(tool)) writeExecutable(file, script(tool, version));
      rmSync(join(shims, tool), { force: true });
      symlinkSync(join(bin, "mise"), join(shims, tool));
      writeFileSync(join(root, "mise", "which", tool), `${file}\n`);
      return file;
    }
    if (origin === "npm-global") {
      const file = npmFile(npm, tool, version);
      symlinkSync(file, join(npm, "bin", tool));
      return file;
    }
    if (origin === "local-bin") { writeExecutable(join(localBin, tool), script(tool, version)); return join(localBin, tool); }
    if (origin === "lazy") {
      writeExecutable(join(localBin, tool), `#!/bin/bash\nexport MISE_MINIMUM_RELEASE_AGE=0\nmise use -g --quiet "${tool}" || exit 1\necho WRAPPER RAN >> '${join(root, "wrapper.log")}'\nexec mise x "${tool}" -- "${tool}" "$@"\n`);
      return join(localBin, tool);
    }
    if (origin === "nvm") {
      const d = join(home, ".nvm", "versions", "node", `v${version}`, "bin");
      writeExecutable(join(d, tool), script(tool, version));
      extra.push(d);
      return join(d, tool);
    }
    if (origin === "pacman") { symlinkSync("/usr/bin/env", join(other, tool)); return "/usr/bin/env"; }
    if (origin === "shim") {
      const d = join(root, "agents", "a", "instances", "a-1", ".oats", "bin");
      mkdirSync(d, { recursive: true });
      symlinkSync(oatsPackage(join(root, "real-npm", "lib", "node_modules"), version), join(d, "oats"));
      extra.unshift(d);
      return join(d, "oats");
    }
    if (origin === "other") { writeExecutable(join(other, tool), script(tool, version)); return join(other, tool); }
    throw new Error(origin);
  }

  // What `mise use -g <spec>` does: fails, or succeeds and installs nothing.
  function planMise(spec, outcome) {
    const key = spec.replace(/[^A-Za-z0-9]/g, "_");
    writeFileSync(join(root, "mise", "plan", key), outcome === "fail" ? `echo "mise ERROR failed to install ${spec}: network unreachable" >&2\nexit 1\n` : "exit 0\n");
  }

  // The installer in a session of its own (test/helpers/tty.py): by default
  // with a terminal, a pty it reads `input` from as typed, as a person runs
  // it; `tty: false` with none. Its stdin is `stdin`, its output captured;
  // `shell` runs it (dash, say, which /bin/sh is on Debian and Ubuntu).
  const run = (args, { input = "", tty = true, stdin = "", extraEnv = {}, cwd = home, installer = INSTALLER, shell = "/bin/sh" } = {}) => {
    const answers = join(root, "answers");
    writeFileSync(answers, input);
    const mode = tty ? ["tty", answers] : ["none"];
    if (!PYTHON) throw new Error("the installer's tests need python3 on PATH (test/helpers/tty.py)");
    const r = spawnSync(PYTHON, [TTY, ...mode, "--", shell, installer, ...args], { env: { ...env(), ...extraEnv }, input: stdin, encoding: "utf8", timeout: 60_000, cwd });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
  };
  return { root, home, bin, other, npm, miseData, shims, localBin, kernel, env, log, put, planMise, run, setDefaultAgent };
}

// What `mise use -g <spec>` installs: `tool` at `version`, laid out when
// mise runs and not before; or "fail" (mise exits 1) or "nothing" (mise
// exits 0 and installs nothing).
export function miseInstalls(w, tool, spec, version) {
  if (version === "fail" || version === "nothing") { w.planMise(spec, version); return; }
  const scratch = mkdtempSync(join(w.root, "scratch-"));
  w.put(tool, "mise", version);
  const installDir = join(w.miseData, "installs", MISE_DIR[tool], version);
  const which = join(w.root, "mise", "which", tool);
  const shim = join(w.shims, tool);
  renameSync(installDir, join(scratch, "install"));
  renameSync(which, join(scratch, "which"));
  rmSync(shim);
  writeFileSync(join(w.root, "mise", "plan", spec.replace(/[^A-Za-z0-9]/g, "_")), [
    `mkdir -p '${join(w.miseData, "installs", MISE_DIR[tool])}'`, `mv '${scratch}/install' '${installDir}'`,
    `mv '${scratch}/which' '${which}'`, `ln -s '${join(w.bin, "mise")}' '${shim}'`, "",
  ].join("\n"));
}

export const ALL = (w, { harness = "claude", node = "26.8.2", aw = "1.36.47", oats = "0.67.1" } = {}) => {
  w.put("node", "mise", node);
  w.put("tmux", "other", "3.5a");
  w.put("aw", "npm-global", aw);
  w.put("oats", "npm-global", oats);
  w.put(harness, "local-bin", "2.1.308");
  signedIn(w);
  keyMoved(w);
};
// gh at `version`, signed in as `login` with `scopes` (null: not signed in),
// and git signing in to github.com through it unless `git` is false.
export function signedIn(w, { scopes = GH_SCOPES, login = "octo-person", version = "2.102.0", git = scopes !== null } = {}) {
  const gh = w.put("gh", "mise", version);
  if (scopes === null) rmSync(join(w.root, "gh", "status"), { force: true });
  else writeFileSync(join(w.root, "gh", "status"), `${login} ${scopes.join(", ")}\n`);
  const gitconfig = join(w.home, ".gitconfig");
  if (git) writeFileSync(gitconfig, `[credential "https://github.com"]\n\thelper =\n\thelper = !'${gh}' auth git-credential\n`);
  else rmSync(gitconfig, { force: true });
}
// The agent key already with OATS, as setup leaves it: its state records the
// choice, and bindings.lua holds the key's bind line.
export function keyMoved(w) {
  const p = discoverPaths(w.env());
  mkdirSync(p.stateDir, { recursive: true });
  writeFileSync(join(p.stateDir, "state.json"), JSON.stringify({ schemaVersion: STATE_SCHEMA, agentKey: "oats", files: [] }));
  mkdirSync(p.hyprDir, { recursive: true });
  writeFileSync(join(p.hyprDir, "bindings.lua"), `-- mine\n${agentBindLine(p.wrapper)}\n`);
}
// Claude's plugin list as `claude plugin list --json` prints it (indented),
// with the channel plugin as `entry` makes it.
export const withChannel = (w, entry = {}) => {
  writeFileSync(join(w.root, "claude", "plugins.json"), JSON.stringify([{ id: "aweb-channel@awebai-marketplace", version: "1.7.11", scope: "user", enabled: true, ...entry }], null, 2));
  writeFileSync(join(w.root, "claude", "marketplaces.json"), JSON.stringify([{ name: "awebai-marketplace", source: "github", repo: "awebai/claude-plugins" }]));
};
// One deployment with a steward, one without, and one the kernel lists as
// missing (its status is never read).
// `identityAddress`, when given, is the steward row's in `oats status --json`
// (the kernel's desktop-facts).
export function deployments(w, { steward = true, identityAddress } = {}) {
  const a = join(w.root, "Agents", "merak");
  const b = join(w.root, "Work", "acme");
  for (const d of [a, b]) mkdirSync(d, { recursive: true });
  let status = steward ? STATUS : { ...STATUS, agents: STATUS.agents.filter((x) => x.key !== "oats.machine/steward") };
  if (identityAddress !== undefined) status = { ...status, agents: status.agents.map((x) => (x.key === "oats.machine/steward" ? { ...x, instances: x.instances.map((i) => ({ ...i, identityAddress })) } : x)) };
  writeFileSync(join(a, "status.json"), JSON.stringify(status));
  writeFileSync(join(b, "status.json"), JSON.stringify({ ...STATUS, agents: STATUS.agents.filter((x) => x.key !== "oats.machine/steward") }));
  writeFileSync(join(w.kernel.k, "deployments.json"), JSON.stringify({ deploymentsApi: 1, file: join(w.home, ".oats", "config", "deployments.json"), deployments: [{ path: a, name: "merak", state: "ok" }, { path: b, name: "acme", state: "ok" }, { path: join(w.root, "Gone", "old"), name: "old", state: "missing" }], imports: {} }));
  return { a, b };
}
export const harnessRun = (w) => JSON.parse(readFileSync(join(w.root, "harness.json"), "utf8"));
export const found = (w) => JSON.parse(readFileSync(join(w.home, ".local", "state", "oats-omarchy", "found.json"), "utf8"));
export const stepLines = (out) => out.split("\n").filter((l) => /^omarchy-install-oats: step \d\/8: /.test(l));

