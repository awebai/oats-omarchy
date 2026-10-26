// `omarchy-install-oats` (bin/omarchy-install-oats, lib/install.mjs) on a
// temporary machine of stand-ins (test/helpers/install-world.mjs). Nothing
// is installed for real, and no harness, mise or installer of the host runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { awEnvironment, consentFacts, gettingStartedSkill, handoff, parseTools, PROMPT_FILE, renderPrompt } from "../lib/install.mjs";
import { ALL, deployments, found, GH_SCOPES, harnessRun, INSTALLER, keyMoved, miseInstalls, signedIn, stepLines, withChannel, world } from "./helpers/install-world.mjs";
import { repo, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

const BOOTSTRAP = ["oats onboard", "oats spawn", "aweb setup", "harness trust"];

// ---------------------------------------------------------------------------
// --check

test("--check: everything there and a steward: one line each, exit 0, nothing installed", (t) => {
  const w = world(t);
  ALL(w);
  withChannel(w);
  deployments(w);
  const r = w.run(["--check", "--harness", "claude"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.stdout, [
    "node: found 26.8.2 (mise)",
    "tmux: found 3.5a (other)",
    "aw: found 1.36.47 (npm-global)",
    "oats: found 0.67.1 (npm-global)",
    "steward: found steward @ merak",
    "claude: found 2.1.308 (local-bin)",
    "aweb-channel@awebai-marketplace: found (claude-plugin)",
    "",
  ].join("\n"));
  assert.equal(w.log("mise.log").includes("use"), false);
  assert.equal(w.log("pkg.log"), "");
});

test("--check: nothing installed, exit 1; without node, oats and the steward cannot be looked at", (t) => {
  const w = world(t);
  const r = w.run(["--check"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "node: missing\ntmux: missing\naw: missing\noats: missing: node is needed to run it\nsteward: missing: node and the OATS CLI are needed to look for it\n");
});

test("--check: no steward in any deployment is not ready, and says how to spawn one", (t) => {
  const w = world(t);
  ALL(w);
  deployments(w, { steward: false });
  const r = w.run(["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^steward: missing: no steward on this machine: spawn one with `oats spawn oats.machine\/steward --name steward` in the machine's deployment$/m);
});

test("--check: too old, with the upgrade command for how each was installed; an instance's shim is not the CLI", (t) => {
  const w = world(t);
  w.put("node", "nvm", "20.11.0");
  w.put("aw", "mise", "1.36.20");
  w.put("oats", "npm-global", "0.66.0");
  w.put("tmux", "other", "3.5a");
  let r = w.run(["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^node: too old: 20\.11\.0 < 22; upgrade: upgrade it the way you installed it$/m);
  assert.match(r.stdout, /^aw: too old: 1\.36\.20 < 1\.36\.33; upgrade: mise use -g npm:@awebai\/aw@latest$/m);
  assert.match(r.stdout, /^oats: missing: node is needed to run it$/m, "node too old: oats is not run");

  const w2 = world(t, { npmPrefix: undefined });
  w2.put("node", "mise", "26.8.2");
  w2.put("oats", "npm-global", "0.66.0");
  r = w2.run(["--check"]);
  assert.match(r.stdout, /^oats: too old: 0\.66\.0 < 0\.67\.1; upgrade: npm install -g @awebai\/oats@latest$/m);

  const w3 = world(t);
  w3.put("node", "pacman");
  r = w3.run(["--check"]);
  assert.match(r.stdout, /^node: too old: \d+\.\d+.* < 22; upgrade: sudo pacman -Syu nodejs$/m);

  const w4 = world(t);
  w4.put("node", "mise", "26.8.2");
  w4.put("oats", "shim", "0.67.1");
  r = w4.run(["--check"]);
  assert.match(r.stdout, /^oats: not usable: .*\/\.oats\/bin\/oats is an instance home's shim, not the installed OATS CLI: run omarchy-install-oats outside an agent session$/m);
});

test("--check: an npm global install under another prefix than npm's own gets that prefix in its upgrade command", (t) => {
  const w = world(t);
  w.put("node", "mise", "26.8.2");
  // aw under a second prefix, as when npm's prefix moved since it was installed.
  const old = join(w.root, "old-prefix");
  const file = join(old, "lib", "node_modules", "@awebai", "aw", "bin", "aw");
  writeExecutable(file, "#!/bin/sh\necho 'aw 1.36.1'\n");
  symlinkSync(file, join(w.other, "aw"));
  const r = w.run(["--check"]);
  assert.match(r.stdout, new RegExp(`^aw: too old: 1\\.36\\.1 < 1\\.36\\.33; upgrade: npm install -g --prefix ${old} @awebai/aw@latest$`, "m"));
});

test("--check: Omarchy's lazy wrapper is not an install until mise has the agent; the person's own ~/.local/bin is", (t) => {
  const w = world(t);
  w.put("node", "mise", "26.8.2");
  w.put("codex", "lazy");
  let r = w.run(["--check", "--harness", "codex"]);
  assert.match(r.stdout, /^codex: missing$/m);
  assert.equal(w.log("wrapper.log"), "", "the wrapper is never run");
  w.put("codex", "mise", "0.98.0");
  r = w.run(["--check", "--harness", "codex"]);
  assert.match(r.stdout, /^codex: found 0\.98\.0 \(mise\)$/m);
  const own = world(t);
  own.put("pi", "local-bin", "0.40.1");
  r = own.run(["--check", "--harness", "pi"]);
  assert.match(r.stdout, /^pi: found 0\.40\.1 \(local-bin\)$/m);
});

test("--check: a claude without the plugin command, or without the channel plugin", (t) => {
  const w = world(t);
  ALL(w);
  deployments(w);
  let r = w.run(["--check", "--harness", "claude"]);
  assert.match(r.stdout, /^aweb-channel@awebai-marketplace: missing$/m);
  assert.equal(r.status, 1);
  writeFileSync(join(w.root, "claude", "no-plugin"), "");
  r = w.run(["--check", "--harness", "claude"]);
  assert.match(r.stdout, /^aweb-channel@awebai-marketplace: too old: claude 2\.1\.308 has no plugin command; upgrade: upgrade it the way you installed it$/m);
});

test("--check: an oats on PATH that links to an instance home's shim is not the CLI, and is not run", (t) => {
  const w = world(t);
  ALL(w);
  deployments(w);
  rmSync(join(w.npm, "bin", "oats"));
  const shim = join(w.root, "agents", "one", "instances", "one-1", ".oats", "bin", "oats");
  writeExecutable(shim, `#!/bin/sh\necho RAN >> '${join(w.root, "shim.log")}'\necho '@awebai/oats 0.67.1'\n`);
  symlinkSync(shim, join(w.other, "oats"));
  const r = w.run(["--check"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.stdout, new RegExp(`^oats: not usable: ${shim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is an instance home's shim`, "m"));
  assert.equal(w.log("shim.log"), "");
});

// The no-terminal paths run under /bin/sh and under dash (Debian's and
// Ubuntu's /bin/sh), where a failed redirection of a special builtin ends
// the shell.
const SHELLS = ["/bin/sh", "/bin/dash"].filter((f) => existsSync(f));

for (const shell of SHELLS) test(`--now without --harness and without a terminal is refused before anything runs, the floating terminal included (${shell})`, (t) => {
  const w = world(t);
  const r = w.run(["--now"], { tty: false, shell });
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /^omarchy-install-oats: --now needs --harness claude\|codex\|pi without a terminal to ask in$/m);
  assert.equal(w.log("floating.log"), "");
  assert.equal(w.log("mise.log"), "");
});

test("bad arguments are refused before anything runs", (t) => {
  const w = world(t);
  for (const args of [["--harness", "grok"], ["--harness"], ["--bogus"], ["--now", "--harness=opencode"]]) {
    const r = w.run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /^omarchy-install-oats: .*\nusage: omarchy-install-oats /);
  }
  assert.equal(w.log("mise.log"), "");
});

// ---------------------------------------------------------------------------
// --now

test("--now with everything there: eight steps, each found and used, then the onboarding agent with the prompt as one argv element", (t) => {
  const w = world(t);
  ALL(w);
  withChannel(w);
  const { a } = deployments(w);
  const r = w.run(["--now", "--harness", "claude"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(stepLines(r.stdout), [
    "omarchy-install-oats: step 1/8: the harness your agents run on",
    "omarchy-install-oats: step 2/8: node, claude and tmux",
    "omarchy-install-oats: step 3/8: aw, the aweb CLI",
    "omarchy-install-oats: step 4/8: the OATS CLI",
    "omarchy-install-oats: step 5/8: Claude's aweb channel plugin",
    "omarchy-install-oats: step 6/8: GitHub",
    "omarchy-install-oats: step 7/8: the agent key",
    "omarchy-install-oats: step 8/8: the onboarding agent, in ~/Work",
  ]);
  for (const line of ["found node 26.8.2 (mise): using it", "found claude 2.1.308 (local-bin): using it", "found tmux 3.5a (other): using it", "found aw 1.36.47 (npm-global): using it", "found oats 0.67.1 (npm-global): using it", "found the awebai-marketplace marketplace: using it", "found aweb-channel@awebai-marketplace: using it"]) {
    assert.ok(r.stdout.includes(`omarchy-install-oats: ${line}\n`), line);
  }
  assert.equal(w.log("mise.log").includes("use"), false, "nothing installed");
  assert.equal(w.log("claude-plugin.log").includes("install"), false);
  const h = harnessRun(w);
  assert.equal(h.cwd, join(w.home, "Work"));
  assert.equal(h.argv.length, 6);
  assert.deepEqual(h.argv.slice(0, 5), ["--permission-mode", "auto", "--dangerously-load-development-channels", "plugin:aweb-channel@awebai-marketplace", "--"]);
  const prompt = h.argv[5];
  const list = found(w);
  assert.equal(prompt, renderPrompt({ skill: list.gettingStartedSkill, hostname: hostname(), harness: "claude", pluginDir: repo, pluginVersion: list.plugin.version, foundList: join(w.home, ".local", "state", "oats-omarchy", "found.json"), ...consentFacts({ githubLogin: "octo-person", githubScopes: GH_SCOPES, agentKey: "moved", pluginDir: repo }) }));
  for (const name of BOOTSTRAP) assert.ok(!prompt.includes(name), name);
  assert.deepEqual(list.deployments, [
    { dir: a, name: "merak", state: "ok", steward: true },
    { dir: join(w.root, "Work", "acme"), name: "acme", state: "ok", steward: false },
    { dir: join(w.root, "Gone", "old"), name: "old", state: "missing", steward: null },
  ]);
});

test("--now installs what is missing with mise, says so, and the found-list says installed", (t) => {
  const w = world(t);
  w.put("tmux", "other", "3.5a");
  w.put("pi", "lazy");
  miseInstalls(w, "node", "node@lts", "24.3.0");
  miseInstalls(w, "pi", "pi", "0.40.1");
  miseInstalls(w, "aw", "npm:@awebai/aw", "1.36.47");
  miseInstalls(w, "oats", "npm:@awebai/oats", "0.67.1");
  signedIn(w);
  // Without node, setup has never run here: the key is on the screen.
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "pi"], { installer, input: "y\n" });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.log("mise.log").split("--\n").filter((x) => x.startsWith("use\n")).map((x) => x.split("\n")[2]), ["node@lts", "pi", "npm:@awebai/aw", "npm:@awebai/oats"]);
  for (const line of ["installing node with mise (mise use -g node@lts)", "installed node 24.3.0 (mise)", "installed pi 0.40.1 (mise)", "installed aw 1.36.47 (mise)", "installed oats 0.67.1 (mise)", "step 5/8: skipped: the aweb channel plugin is for claude, and pi needs none"]) {
    assert.ok(r.stdout.includes(`omarchy-install-oats: ${line}\n`), line);
  }
  assert.equal(w.log("wrapper.log"), "", "Omarchy's wrapper never ran");
  assert.deepEqual(found(w).tools.map((x) => [x.name, x.state, x.origin]), [["node", "installed", "mise"], ["tmux", "found", "other"], ["aw", "installed", "mise"], ["oats", "installed", "mise"], ["pi", "installed", "mise"]]);
  assert.deepEqual(harnessRun(w).argv.length, 1);
});

test("--now installs tmux with omarchy-pkg-add, saying why it asks for sudo", (t) => {
  const w = world(t);
  ALL(w, { harness: "codex" });
  rmSync(join(w.other, "tmux"));
  writeFileSync(join(w.root, "pkg-plan"), `printf '#!/bin/sh\\necho "tmux 3.5a"\\n' > '${join(w.other, "tmux")}'\nchmod 755 '${join(w.other, "tmux")}'\n`);
  const r = w.run(["--now", "--harness", "codex"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(w.log("pkg.log"), "tmux\n--\n");
  assert.match(r.stdout, /installing tmux with omarchy-pkg-add: it is a system package, so it asks for your password\n/);
  assert.deepEqual(harnessRun(w).argv.slice(0, 2), ["--approve-for-me", "--"]);
  assert.match(readFileSync(INSTALLER, "utf8"), /^# omarchy:requires-sudo=true$/m);
});

test("--now: Claude's channel plugin, added when absent, and its marketplace first", (t) => {
  const w = world(t);
  ALL(w);
  const r = w.run(["--now", "--harness", "claude"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(w.log("claude-plugin.log"), "plugin\nlist\n--json\n--\nplugin\nmarketplace\nlist\n--json\n--\nplugin\nmarketplace\nadd\nawebai/claude-plugins\n--\nplugin\nlist\n--json\n--\nplugin\ninstall\naweb-channel@awebai-marketplace\n--\nplugin\nlist\n--json\n--\n");
  assert.deepEqual(found(w).tools.at(-1), { name: "aweb-channel@awebai-marketplace", version: null, origin: "claude-plugin", path: null, state: "installed" });
});

test("--now: a channel plugin installed for another project is not this session's: the user-scoped copy is installed; one for ~/Work is used", (t) => {
  const w = world(t);
  ALL(w);
  withChannel(w, { scope: "project", projectPath: join(w.root, "some-other-project") });
  let r = w.run(["--now", "--harness", "claude"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(w.log("claude-plugin.log").includes("plugin\ninstall\naweb-channel@awebai-marketplace\n"), "installed");
  assert.equal(found(w).tools.at(-1).state, "installed");
  const own = world(t);
  ALL(own);
  withChannel(own, { scope: "local", projectPath: join(own.home, "Work") });
  r = own.run(["--now", "--harness", "claude"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(!own.log("claude-plugin.log").includes("plugin\ninstall\n"));
  assert.equal(found(own).tools.at(-1).state, "found");
  const c = own.run(["--check", "--harness", "claude"]);
  assert.match(c.stdout, /^aweb-channel@awebai-marketplace: found \(claude-plugin\)$/m);
  withChannel(own, { enabled: false });
  assert.match(own.run(["--check", "--harness", "claude"]).stdout, /^aweb-channel@awebai-marketplace: not usable: it is installed and disabled for ~\/Work; enable it with: cd ~\/Work && claude plugin enable aweb-channel@awebai-marketplace$/m);
});

test("Claude's plugins are read where the onboarding session runs, ~/Work, never in the caller's directory", (t) => {
  const disable = (dir) => { mkdirSync(join(dir, ".claude"), { recursive: true }); writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "aweb-channel@awebai-marketplace": false } }, null, 2)); };
  // Disabled in ~/Work, enabled where the installer is started: a stop.
  const w = world(t);
  ALL(w);
  withChannel(w);
  disable(join(w.home, "Work"));
  let r = w.run(["--now", "--harness", "claude"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /step 5 \(channel\) failed: aweb-channel@awebai-marketplace it is installed and disabled for ~\/Work/);
  assert.ok(!existsSync(join(w.root, "harness.json")));
  assert.match(w.run(["--check", "--harness", "claude"]).stdout, /^aweb-channel@awebai-marketplace: not usable: /m);
  // Enabled in ~/Work, disabled in the caller's project: used.
  const v = world(t);
  ALL(v);
  withChannel(v);
  const project = join(v.root, "project");
  disable(project);
  mkdirSync(join(v.home, "Work"));
  r = v.run(["--now", "--harness", "claude"], { cwd: project });
  assert.equal(r.status, 0, r.out);
  assert.equal(found(v).tools.at(-1).state, "found");
  assert.deepEqual([...new Set(v.log("claude-plugin.cwd").trim().split("\n"))], [join(v.home, "Work")]);
  // No ~/Work yet: HOME, which holds no project's settings.
  const u = world(t);
  ALL(u);
  withChannel(u);
  u.run(["--check", "--harness", "claude"], { cwd: project });
  assert.deepEqual([...new Set(u.log("claude-plugin.cwd").trim().split("\n"))], [u.home]);
  assert.ok(!existsSync(join(u.home, "Work")), "--check creates nothing");
});

test("--now run again skips every step that is done and still starts the onboarding agent", (t) => {
  const w = world(t);
  ALL(w);
  const first = w.run(["--now", "--harness", "claude"]);
  assert.equal(first.status, 0, first.out);
  rmSync(join(w.root, "harness.json"));
  rmSync(join(w.root, "claude-plugin.log"));
  const again = w.run(["--now", "--harness", "claude"]);
  assert.equal(again.status, 0, again.out);
  assert.ok(!w.log("claude-plugin.log").includes("install"), "nothing installed again");
  assert.ok(existsSync(join(w.root, "harness.json")));
});

test("--now takes Omarchy's default agent as the harness without asking; it asks only when that is none of the three, claude first", (t) => {
  const w = world(t);
  ALL(w, { harness: "codex" });
  w.setDefaultAgent("codex");
  const r = w.run(["--now"]);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.stdout.includes("omarchy-install-oats: using codex (Omarchy's default agent)\n"), r.stdout);
  assert.doesNotMatch(r.stdout, /Which harness/);
  assert.deepEqual(harnessRun(w).argv.slice(0, 2), ["--approve-for-me", "--"]);
  const w2 = world(t);
  ALL(w2, { harness: "pi" });
  w2.setDefaultAgent("opencode");
  const r2 = w2.run(["--now"], { input: "pi\n" });
  assert.match(r2.stdout, /Which harness should your agents run on\? \[claude\/codex\/pi\] /, "a default agent outside the three: asked, claude first");
  assert.equal(r2.status, 0, r2.out);
});

// ---------------------------------------------------------------------------
// The consent screen (awebai/oats-omarchy#27): every act that is the
// person's, on one screen at the start, before anything is installed.

// A copy of the plugin whose bin/setup.mjs is a stand-in: it logs its argv
// and answers `answer` as setup --json does, so the installer's agent-key
// act is seen without a real setup on this machine (setup's own
// --steward-pending is test/agent-key.test.mjs's).
function pluginCopy(w, answer = { ok: true, schemaVersion: 1, result: { parts: [{ part: "agent-key", status: "applied", paths: [] }] } }) {
  const dir = join(w.root, "plugins", "ai.aweb.oats");
  cpSync(repo, dir, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)$/.test(src) });
  writeFileSync(join(dir, "bin", "setup.mjs"), `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(w.root, "setup.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(${JSON.stringify(JSON.stringify(answer))} + "\\n");
`);
  return { dir, installer: join(dir, "bin", "omarchy-install-oats") };
}
// Nothing done yet: gh not signed in, the key with Omarchy.
function nothingDone(w) {
  ALL(w);
  withChannel(w);
  signedIn(w, { scopes: null });
  rmSync(join(w.home, ".local", "state", "oats-omarchy", "state.json"));
}
const setupRuns = (w) => w.log("setup.log").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ghCalls = (w) => w.log("gh.log").split("--\n").filter(Boolean).map((c) => c.trim().split("\n"));
const SCREEN_END = "Make these changes? [y/N] ";
// Nothing installed, no sign-in, the key not moved, no agent started.
function nothingChanged(w) {
  assert.equal(w.log("mise.log").includes("use"), false);
  assert.deepEqual(ghCalls(w).filter((c) => c[1] !== "status"), [], "no sign-in");
  assert.deepEqual(setupRuns(w), [], "the key is not moved");
  assert.equal(existsSync(join(w.root, "harness.json")), false);
}

test("one consent screen before anything is installed: each act with why, what and its undo on a line of its own; [y/N]", (t) => {
  const w = world(t);
  nothingDone(w);
  const { dir, installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "\n" });
  const screen = r.stdout.slice(r.stdout.indexOf("OATS for this machine"), r.stdout.indexOf(SCREEN_END) + SCREEN_END.length);
  assert.equal(screen, `OATS for this machine

To set up OATS, these changes are made as you, in this terminal. You answer once:
nothing asks you again later, and no API keys are needed.

1. Sign in to GitHub, once
   Why:  your agents keep their work in your GitHub repositories and sign their commits.
   What: one browser approval (GitHub's device flow) for gh, with every scope
         onboarding needs: repo, read:org, gist, admin:ssh_signing_key, user:email.
         Git then signs in to github.com through gh.
   Undo:
     gh auth logout --hostname github.com
     git config --global --unset-all credential.https://github.com.helper
     git config --global --unset-all credential.https://gist.github.com.helper

2. The agent key opens your steward
   Why:  one key, SUPER + SHIFT + CTRL + A, opens the agent that looks after this machine.
   What: Omarchy's "Agent" binding on that key moves to OATS (lines in
         ~/.config/hypr/bindings.lua and a launcher in ~/.local/bin).
   Undo:
     ${dir}/setup --apply --only agent-key --agent-key omarchy

${SCREEN_END}`);
  assert.ok(r.stdout.indexOf("OATS for this machine") > r.stdout.indexOf("step 1/8"), "after the harness is known");
  assert.ok(!r.stdout.includes("step 2/8"), "and before any tool is looked at");
});

for (const [name, input] of [["Enter", "\n"], ["n", "n\n"], ["no answer", ""], ["anything but y", "sure\n"]]) {
  test(`the consent screen answered with ${name}: nothing was changed, nothing installed, no agent started`, (t) => {
    const w = world(t);
    nothingDone(w);
    w.put("tmux", "other", "3.5a");
    const { installer } = pluginCopy(w);
    const r = w.run(["--now", "--harness", "claude"], { installer, input });
    assert.equal(r.status, 1, r.out);
    assert.ok(r.stdout.endsWith(`${SCREEN_END}omarchy-install-oats: Nothing was changed. Run omarchy-install-oats --now again when you're ready.\n`), r.stdout);
    nothingChanged(w);
  });
}

test("the GitHub act's undo undoes all of it: run as the screen prints it, gh is signed out and git's helpers for github.com and gist.github.com are gone", (t) => {
  const w = world(t);
  nothingDone(w);
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "y\n" });
  assert.equal(r.status, 0, r.out);
  const screen = r.stdout.slice(r.stdout.indexOf("1. Sign in to GitHub"), r.stdout.indexOf("2. The agent key"));
  const undo = screen.slice(screen.indexOf("   Undo:\n") + "   Undo:\n".length).trim().split("\n").map((l) => l.trim());
  assert.deepEqual(undo, [
    "gh auth logout --hostname github.com",
    "git config --global --unset-all credential.https://github.com.helper",
    "git config --global --unset-all credential.https://gist.github.com.helper",
  ]);
  const get = (key) => spawnSync("git", ["config", "--global", "--get-all", key], { cwd: w.home, env: w.env(), encoding: "utf8" });
  for (const key of ["credential.https://github.com.helper", "credential.https://gist.github.com.helper"]) assert.match(get(key).stdout, /auth git-credential\n$/, `${key} set by the act`);
  for (const line of undo.slice(1)) assert.equal(spawnSync("sh", ["-c", line], { cwd: w.home, env: w.env(), encoding: "utf8" }).status, 0, line);
  for (const key of ["credential.https://github.com.helper", "credential.https://gist.github.com.helper"]) assert.equal(get(key).status, 1, `${key} gone`);
});

test("the consent screen answered y: gh signs in with every scope, with no terminal question of its own, git uses it, the key moves before the steward exists, then onboarding", (t) => {
  const w = world(t);
  nothingDone(w);
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "y\n" });
  assert.equal(r.status, 0, r.out);
  // The answer's newline is the terminal's echo: here the next line follows the prompt.
  assert.deepEqual(stepLines(r.stdout.replace(SCREEN_END, `${SCREEN_END}\n`)), [
    "omarchy-install-oats: step 1/8: the harness your agents run on",
    "omarchy-install-oats: step 2/8: node, claude, tmux and gh",
    "omarchy-install-oats: step 3/8: aw, the aweb CLI",
    "omarchy-install-oats: step 4/8: the OATS CLI",
    "omarchy-install-oats: step 5/8: Claude's aweb channel plugin",
    "omarchy-install-oats: step 6/8: GitHub",
    "omarchy-install-oats: step 7/8: the agent key",
    "omarchy-install-oats: step 8/8: the onboarding agent, in ~/Work",
  ]);
  assert.deepEqual(ghCalls(w).filter((c) => c[1] !== "status"), [
    ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", GH_SCOPES.join(","), "stdin=none"],
    ["auth", "setup-git", "--hostname", "github.com", "stdin=none"],
  ]);
  assert.equal(w.log("xdg-open.log"), "https://github.com/login/device\n--\n", "the browser opens at the device page");
  assert.ok(r.stdout.includes("omarchy-install-oats: approve this machine in your browser, at https://github.com/login/device, with the code gh shows below\n"), r.stdout);
  assert.ok(r.stdout.includes("omarchy-install-oats: signed in to GitHub as octo-person\n"));
  assert.deepEqual(setupRuns(w), [["--apply", "--only", "agent-key", "--agent-key", "oats", "--steward-pending", "--yes", "--json"]]);
  assert.ok(r.stdout.includes("omarchy-install-oats: the agent key opens the steward (SUPER + SHIFT + CTRL + A)\n"));
  assert.deepEqual(found(w).github, { login: "octo-person", scopes: GH_SCOPES });
  const prompt = harnessRun(w).argv.at(-1);
  assert.ok(prompt.includes("gh is signed in to GitHub as octo-person with every scope onboarding needs"), prompt);
  assert.ok(prompt.includes("The agent key, SUPER + SHIFT + CTRL + A, already opens the steward"), prompt);
});

test("signed in but short of scopes: the screen says which, and one refresh adds only those", (t) => {
  const w = world(t);
  nothingDone(w);
  signedIn(w, { scopes: ["gist", "read:org", "repo"] });
  keyMoved(w);
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "y\n" });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.stdout.includes(`   What: gh is signed in as octo-person; one browser approval (GitHub's device flow)
         adds the scopes it lacks: admin:ssh_signing_key, user:email.
`), r.stdout);
  assert.ok(!r.stdout.includes("2. The agent key"), "the key already opens OATS: left off");
  assert.deepEqual(ghCalls(w).filter((c) => c[1] !== "status").map((c) => c.slice(0, 6)), [
    ["auth", "refresh", "--hostname", "github.com", "--scopes", "admin:ssh_signing_key,user:email"],
    ["auth", "setup-git", "--hostname", "github.com", "stdin=none"],
  ]);
  assert.deepEqual(setupRuns(w), [], "nothing to do for the key");
  assert.deepEqual(found(w).github.scopes, ["gist", "read:org", "repo", "admin:ssh_signing_key", "user:email"]);
});

test("with every act done already there is no screen, and steps 6 and 7 say so", (t) => {
  const w = world(t);
  ALL(w);
  withChannel(w);
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.stdout.includes("OATS for this machine"));
  assert.ok(r.stdout.includes("omarchy-install-oats: found gh signed in to GitHub as octo-person with every scope onboarding needs: using it\n"), r.stdout);
  assert.ok(r.stdout.includes("omarchy-install-oats: the agent key already opens the steward\n"));
  assert.deepEqual(setupRuns(w), []);
});

test("scopes GitHub normalized to a parent count: user covers user:email, write:org or admin:org cover read:org; nothing is asked", (t) => {
  for (const scopes of [["repo", "read:org", "gist", "admin:ssh_signing_key", "user"], ["repo", "write:org", "gist", "admin:ssh_signing_key", "user:email"], ["repo", "admin:org", "gist", "admin:ssh_signing_key", "user"]]) {
    const w = world(t);
    ALL(w);
    withChannel(w);
    signedIn(w, { scopes });
    const { installer } = pluginCopy(w);
    const r = w.run(["--now", "--harness", "claude"], { installer });
    assert.equal(r.status, 0, `${scopes}: ${r.out}`);
    assert.ok(!r.stdout.includes("OATS for this machine"), `${scopes}: no screen`);
    assert.deepEqual(ghCalls(w).filter((c) => c[1] !== "status"), [], `${scopes}: no sign-in`);
  }
});

test("signed in with every scope but git not using gh: the screen says so, and step 6 runs only setup-git", (t) => {
  const w = world(t);
  ALL(w);
  withChannel(w);
  signedIn(w, { git: false });
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "y\n" });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.stdout.includes(`   What: gh is signed in as octo-person with every scope onboarding needs;
         git then signs in to github.com through gh (gh auth setup-git).
`), r.stdout);
  assert.deepEqual(ghCalls(w).filter((c) => c[1] !== "status"), [["auth", "setup-git", "--hostname", "github.com", "stdin=none"]]);
  assert.equal(w.log("xdg-open.log"), "", "no browser approval");
});

test("git signing in through gh only in a repository's own config, run from there, is not git using gh: setup-git runs, globally", (t) => {
  const w = world(t);
  ALL(w);
  withChannel(w);
  signedIn(w, { git: false });
  const project = join(w.home, "project");
  mkdirSync(project);
  const git = (...args) => spawnSync("git", args, { cwd: project, env: w.env(), encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("config", "credential.https://github.com.helper", "!gh auth git-credential").status, 0);
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "y\n", cwd: project });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.stdout.includes("git then signs in to github.com through gh (gh auth setup-git)"), r.stdout);
  assert.deepEqual(ghCalls(w).filter((c) => c[1] !== "status").map((c) => c[1]), ["setup-git"]);
  assert.match(spawnSync("git", ["config", "--global", "--get", "credential.https://github.com.helper"], { cwd: w.home, env: w.env(), encoding: "utf8" }).stdout, /auth git-credential\n$/, "the global config has it");
});

test("a setup-git that fails after the sign-in is taken up again on the next run", (t) => {
  const w = world(t);
  nothingDone(w);
  writeFileSync(join(w.root, "gh", "fail-setup-git"), "");
  const { installer } = pluginCopy(w);
  const first = w.run(["--now", "--harness", "claude"], { installer, input: "y\n" });
  assert.equal(first.status, 1);
  assert.match(first.stderr, /^omarchy-install-oats: step 6 \(github\) failed: gh auth setup-git exited with status 1$/m);
  rmSync(join(w.root, "gh", "fail-setup-git"));
  const again = w.run(["--now", "--harness", "claude"], { installer, input: "y\n" });
  assert.equal(again.status, 0, again.out);
  assert.ok(again.stdout.includes("git then signs in to github.com through gh (gh auth setup-git)"), "on the screen again");
  assert.deepEqual(ghCalls(w).filter((c) => c[1] !== "status").map((c) => c[1]), ["login", "setup-git", "setup-git"], "no second sign-in");
});

test("a sign-in that fails stops at step 6, before the key moves or the agent starts", (t) => {
  const w = world(t);
  nothingDone(w);
  writeFileSync(join(w.root, "gh", "fail"), "");
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "y\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^omarchy-install-oats: step 6 \(github\) failed: gh auth login exited with status 1$/m);
  assert.deepEqual(setupRuns(w), []);
  assert.equal(existsSync(join(w.root, "harness.json")), false);
});

test("a key setup leaves with Omarchy is said, and onboarding still starts, its prompt saying so", (t) => {
  const w = world(t);
  nothingDone(w);
  signedIn(w);
  const reason = "SUPER + SHIFT + CTRL + A is bound in your bindings.lua";
  const { installer } = pluginCopy(w, { ok: true, schemaVersion: 1, result: { parts: [{ part: "agent-key", status: "skipped", reason, paths: [] }] } });
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "y\n" });
  assert.equal(r.status, 0, r.out);
  assert.ok(r.stdout.includes(`omarchy-install-oats: the agent key stays with Omarchy: ${reason}\n`), r.stdout);
  const prompt = harnessRun(w).argv.at(-1);
  assert.ok(prompt.includes(`The agent key stays with Omarchy: ${reason}.`), prompt);
});

// The answers come from the terminal (/dev/tty), never from stdin, which a
// piped run (curl … | sh) would make the script itself (awebai/oats-omarchy#33).
test("--now takes its answers from the terminal: a y on stdin is not an answer", (t) => {
  const w = world(t);
  nothingDone(w);
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, input: "", stdin: "y\n" });
  assert.equal(r.status, 1, r.out);
  assert.ok(r.stdout.endsWith(`${SCREEN_END}omarchy-install-oats: Nothing was changed. Run omarchy-install-oats --now again when you're ready.\n`), r.stdout);
  nothingChanged(w);
});

for (const shell of SHELLS) test(`--now with no terminal to answer in, in the floating terminal's run, changes nothing and opens no other terminal (${shell})`, (t) => {
  const w = world(t);
  nothingDone(w);
  const { installer } = pluginCopy(w);
  const r = w.run(["--now", "--harness", "claude"], { installer, tty: false, shell, stdin: "y\n", extraEnv: { OMARCHY_INSTALL_OATS_TERMINAL: "1" } });
  assert.equal(r.status, 2, r.out);
  assert.ok(r.stderr.endsWith("omarchy-install-oats: Nothing was changed: no terminal to answer in\n"), r.stderr);
  nothingChanged(w);
  assert.equal(w.log("floating.log"), "");

  const asked = world(t);
  ALL(asked, { harness: "pi" });
  asked.setDefaultAgent("opencode");
  const r2 = asked.run(["--now"], { tty: false, shell, stdin: "pi\n", extraEnv: { OMARCHY_INSTALL_OATS_TERMINAL: "1" } });
  assert.equal(r2.status, 2, r2.out);
  assert.ok(r2.stderr.endsWith("omarchy-install-oats: Nothing was changed: no terminal to answer in\n"), r2.stderr);
  assert.doesNotMatch(r2.stdout, /using pi/);
  nothingChanged(asked);
  assert.equal(asked.log("floating.log"), "");

  // With nothing left to ask (the harness given, both acts done), still
  // nothing runs: the onboarding agent needs the terminal too.
  const done = world(t);
  ALL(done);
  withChannel(done);
  const r3 = done.run(["--now", "--harness", "claude"], { tty: false, shell, extraEnv: { OMARCHY_INSTALL_OATS_TERMINAL: "1" } });
  assert.equal(r3.status, 2, r3.out);
  assert.ok(r3.stderr.endsWith("omarchy-install-oats: Nothing was changed: no terminal to answer in\n"), r3.stderr);
  assert.equal(r3.stdout, "");
  nothingChanged(done);
  assert.equal(existsSync(join(done.home, "Work")), false, "no ~/Work");
  assert.equal(existsSync(join(done.home, ".local", "state", "oats-omarchy", "found.json")), false, "no found-list");
  assert.equal(done.log("floating.log"), "");
});

for (const shell of SHELLS) test(`--now with no terminal runs again in Omarchy's floating terminal, as omarchy-default-agent does (${shell})`, (t) => {
  const w = world(t);
  const r = w.run(["--now", "--harness", "pi"], { tty: false, shell });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.log("floating.log"), `OMARCHY_INSTALL_OATS_TERMINAL=1 '${INSTALLER}' --now --harness 'pi'\n--\n`);
  assert.equal(w.log("mise.log"), "", "nothing ran here");
});

test("the floating terminal's command line quotes the installer's path, whatever it holds, and the shell runs it to the same argv", (t) => {
  const w = world(t);
  // A copy of the installer in a plugin directory with a space, a ' and a $.
  const plugin = join(w.root, "plug in's $HOME");
  const self = join(plugin, "bin", "omarchy-install-oats");
  writeExecutable(self, readFileSync(INSTALLER, "utf8"));
  const r = w.run(["--now", "--harness", "pi"], { tty: false, installer: self });
  assert.equal(r.status, 0, r.out);
  const line = `OMARCHY_INSTALL_OATS_TERMINAL=1 '${join(w.root, "plug in")}'\\''s $HOME/bin/omarchy-install-oats' --now --harness 'pi'`;
  assert.equal(w.log("floating.log"), `${line}\n--\n`);
  // What Omarchy's floating terminal then runs (bash -c "$*"): the same
  // program, with the marker and the same arguments.
  const argvLog = join(w.root, "argv.log");
  writeExecutable(self, `#!/bin/sh\n{ echo "marker=$OMARCHY_INSTALL_OATS_TERMINAL"; for a; do printf '%s\\n' "$a"; done; } > '${argvLog}'\n`);
  const ran = spawnSync("/bin/sh", ["-c", line], { env: w.env(), encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(readFileSync(argvLog, "utf8"), "marker=1\n--now\n--harness\npi\n");
});

for (const [name, set, expect, after] of [
  ["step 2 (tools): mise fails", (w) => { w.put("tmux", "other", "3.5a"); w.put("claude", "local-bin", "2.1.308"); miseInstalls(w, "node", "node@lts", "fail"); }, /^omarchy-install-oats: step 2 \(tools\) failed: mise use -g node@lts exited with status 1$/m],
  ["step 2 (tools): no mise", (w) => { rmSync(join(w.bin, "mise")); }, /^omarchy-install-oats: step 2 \(tools\) failed: mise is not on PATH: Omarchy ships it; install mise, then run omarchy-install-oats --now again$/m],
  ["step 2 (tools): mise installs a node below the floor", (w) => { miseInstalls(w, "node", "node@lts", "20.1.0"); }, /^omarchy-install-oats: step 2 \(tools\) failed: the installed node is too old: 20\.1\.0 < 22; upgrade: mise use -g node@lts$/m],
  ["step 2 (tools): installed but not on PATH", (w) => { miseInstalls(w, "node", "node@lts", "nothing"); }, /^omarchy-install-oats: step 2 \(tools\) failed: node was installed, but it is not on PATH: open a new terminal and run omarchy-install-oats --now again$/m],
  ["step 3 (aw): too old, never replaced or shadowed", (w) => { ALL(w, { aw: "1.36.20" }); }, /^omarchy-install-oats: step 3 \(aw\) failed: aw is too old: 1\.36\.20 < 1\.36\.33; upgrade: npm install -g @awebai\/aw@latest$/m,
    (w) => { assert.ok(!w.log("mise.log").includes("use\n"), "no mise install in front of it"); assert.ok(!existsSync(join(w.shims, "aw"))); }],
  ["step 4 (oats): an instance's shim", (w) => { ALL(w); rmSync(join(w.npm, "bin", "oats")); w.put("oats", "shim", "0.67.1"); }, /^omarchy-install-oats: step 4 \(oats\) failed: .*\.oats\/bin\/oats is an instance home's shim/m],
  ["step 5 (channel): claude has no plugin command", (w) => { ALL(w); writeFileSync(join(w.root, "claude", "no-plugin"), ""); }, /^omarchy-install-oats: step 5 \(channel\) failed: claude 2\.1\.308 has no plugin command; upgrade: upgrade it the way you installed it$/m],
  ["step 5 (channel): the marketplace cannot be added", (w) => { ALL(w); writeFileSync(join(w.root, "claude", "fail-marketplace"), ""); }, /failed to clone awebai\/claude-plugins\nomarchy-install-oats: step 5 \(channel\) failed: claude plugin marketplace add awebai\/claude-plugins exited with status 1$/m],
  ["step 5 (channel): the plugin is installed and disabled, and stays so", (w) => { ALL(w); withChannel(w, { enabled: false }); }, /^omarchy-install-oats: step 5 \(channel\) failed: aweb-channel@awebai-marketplace it is installed and disabled for ~\/Work; enable it with: cd ~\/Work && claude plugin enable aweb-channel@awebai-marketplace$/m,
    (w) => assert.ok(!w.log("claude-plugin.log").includes("install\n"), "not installed again")],
  ["step 8 (onboarding): a deployment whose status cannot be read is not a deployment without a steward", (w) => { ALL(w); withChannel(w); const { a } = deployments(w); writeFileSync(join(a, "status.mode"), "envelope:E_LOCK"); }, /^the deployment merak \(.*\/Agents\/merak\) could not be read: oats status --json: the kernel refused status \(E_LOCK\)\nomarchy-install-oats: step 8 \(onboarding\) failed: the found-list could not be written$/m,
    (w) => assert.ok(!existsSync(join(w.home, ".local", "state", "oats-omarchy", "found.json")), "no found-list")],
  ["step 8 (onboarding): a deployment whose status is not JSON", (w) => { ALL(w); withChannel(w); const { b } = deployments(w); writeFileSync(join(b, "status.json"), "not json"); }, /^the deployment acme \(.*\/Work\/acme\) could not be read: oats status --json: .*JSON/m],
  ["step 8 (onboarding): ~/Work is a file", (w) => { ALL(w); withChannel(w); writeFileSync(join(w.home, "Work"), "notes"); }, /^omarchy-install-oats: step 8 \(onboarding\) failed: .*\/Work is there and is not a directory$/m],
]) test(`--now stops at the failing step with its reason: ${name}`, (t) => {
  const w = world(t);
  set(w);
  // A machine with an act still to do answers the consent screen y.
  const r = w.run(["--now", "--harness", "claude"], { input: "y\n" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, expect);
  assert.ok(!existsSync(join(w.root, "harness.json")), "no onboarding agent");
  after?.(w);
});

test("--now keeps what is there: ~/Work/.aw, the deployments and Claude's plugins are byte-identical; aw runs without the session's selectors", (t) => {
  const w = world(t);
  ALL(w);
  withChannel(w);
  const { a } = deployments(w);
  mkdirSync(join(w.home, "Work", ".aw"), { recursive: true });
  writeFileSync(join(w.home, "Work", ".aw", "identity.yaml"), "alias: merak\nsigning_key: secret-bytes\n");
  writeFileSync(join(w.root, "whoami.json"), JSON.stringify({ alias: "merak", address: "juan.aweb.ai/merak", did: "did:key:z6Mk", name: "merak" }));
  const before = [snapshot(join(w.home, "Work")), snapshot(a), snapshot(join(w.root, "claude"))];
  const r = w.run(["--now", "--harness", "claude"], { extraEnv: { AWEB_IDENTITY_HOME: "/elsewhere/.aw", AW_TEAM: "x", AWEB_URL: "https://example", AWKWARD: "kept" } });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual([snapshot(join(w.home, "Work")), snapshot(a), snapshot(join(w.root, "claude"))], before);
  assert.equal(w.log("aw.log"), `cwd=${join(w.home, "Work")}\n--\n`, "no AWEB_* or AW_* selector reached aw");
  assert.deepEqual(found(w).awIdentity, { dir: join(w.home, "Work", ".aw"), alias: "merak", address: "juan.aweb.ai/merak", role: "work" });
  assert.ok(!readFileSync(join(w.home, ".local", "state", "oats-omarchy", "found.json"), "utf8").includes("secret"));
});

test("the found-list: the shape docs/found-list.md fixes, written 0600, with a deployment-root identity", (t) => {
  const w = world(t);
  ALL(w);
  withChannel(w);
  deployments(w);
  mkdirSync(join(w.home, "Work", ".aw"), { recursive: true });
  writeFileSync(join(w.home, "oats-local.yaml"), "# a deployment above ~/Work\n");
  writeFileSync(join(w.root, "whoami.json"), JSON.stringify({ alias: "root", address: null }));
  const r = w.run(["--now", "--harness", "claude"]);
  assert.equal(r.status, 0, r.out);
  const path = join(w.home, ".local", "state", "oats-omarchy", "found.json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const list = found(w);
  assert.deepEqual(Object.keys(list), ["schemaVersion", "writtenAt", "machine", "harness", "plugin", "gettingStartedSkill", "tools", "github", "awIdentity", "deployments"]);
  assert.deepEqual(list.github, { login: "octo-person", scopes: GH_SCOPES });
  assert.equal(list.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(list.writtenAt)));
  assert.deepEqual(list.machine, { hostname: hostname(), platform: "omarchy", omarchyVersion: "4.0.4-1" });
  assert.equal(list.harness, "claude");
  assert.deepEqual(list.plugin, { dir: repo, version: JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8")).version });
  assert.equal(list.gettingStartedSkill, join(w.npm, "lib", "node_modules", "@awebai", "oats", "skills", "oats-getting-started", "SKILL.md"));
  assert.deepEqual(list.tools.map((x) => Object.keys(x)), list.tools.map(() => ["name", "version", "origin", "path", "state"]));
  assert.deepEqual(list.tools.map((x) => x.name), ["node", "tmux", "aw", "oats", "claude", "aweb-channel@awebai-marketplace"]);
  assert.equal(list.tools[3].path, join(w.npm, "lib", "node_modules", "@awebai", "oats", "bin", "oats.mjs"));
  assert.deepEqual(list.awIdentity, { dir: join(w.home, "Work", ".aw"), alias: "root", address: null, role: "deployment-root" });
  for (const d of list.deployments) assert.deepEqual(Object.keys(d), ["dir", "name", "state", "steward"]);
  for (const d of list.deployments) assert.equal(d.steward === null, d.state !== "ok", "steward is read for ok deployments only");
});

// ---------------------------------------------------------------------------
// The prompt, and lib/install.mjs on its own.

test("the onboarding prompt names facts only: none of the bootstrap's commands, every placeholder filled", () => {
  const template = readFileSync(PROMPT_FILE, "utf8");
  for (const name of BOOTSTRAP) assert.ok(!template.includes(name), name);
  const values = { skill: "/s/SKILL.md", hostname: `it's "merak"; $(x)`, harness: "pi", pluginDir: "/p", pluginVersion: "0.7.0", foundList: "/f/found.json" };
  const prompt = renderPrompt({ ...values, ...consentFacts({ githubLogin: "octo-person", githubScopes: GH_SCOPES, agentKey: "moved", pluginDir: "/p" }) });
  assert.ok(prompt.includes(`Its hostname is it's "merak"; $(x).`), "a hostname with a quote, as it is");
  assert.ok(prompt.includes("/s/SKILL.md") && prompt.includes("/f/found.json") && prompt.includes("/p, version 0.7.0"));
  assert.ok(!/\{\{/.test(prompt));
  assert.throws(() => renderPrompt({}, "{{nope}}"), /unknown placeholder \{\{nope\}\}/);
  // The agent never applies setup (auto mode refuses it as persistence):
  // the agent key is the person's to move.
  assert.ok(prompt.includes("Never run the plugin's setup with --apply or --remove"));
  assert.ok(prompt.includes("/p/setup --plan and /p/setup --check"));
  // What the installer did in the person's terminal, stated as facts.
  assert.ok(prompt.includes("gh is signed in to GitHub as octo-person with every scope onboarding needs (repo, read:org, gist, admin:ssh_signing_key, user:email)"), prompt);
  assert.ok(prompt.includes("The agent key, SUPER + SHIFT + CTRL + A, already opens the steward"), prompt);
  // A way to try it that works on Omarchy's Lua Hyprland, where `hyprctl dispatch exec` is a Lua error.
  assert.ok(prompt.includes("the person presses it or runs setsid ~/.local/bin/omarchy-launch-oats in a terminal; never hyprctl dispatch exec"), prompt);
  assert.doesNotMatch(prompt, /consent/);
  // A key setup left with Omarchy: the person's own act, the typed command
  // first (the menu row exists only once setup has run).
  const kept = renderPrompt({ ...values, ...consentFacts({ githubLogin: "octo-person", githubScopes: GH_SCOPES, agentKey: "SUPER + SHIFT + CTRL + A is bound in your bindings.lua", pluginDir: "/p" }) });
  assert.ok(kept.includes("The agent key stays with Omarchy: SUPER + SHIFT + CTRL + A is bound in your bindings.lua."), kept);
  assert.ok(kept.includes("tell them to type /p/setup --apply --only agent-key in a terminal, or, once setup has added it, to choose Setup › Default Agent › OATS"));
  // One sentence of why goes in front of the command (awebai/oats-omarchy#26).
  const why = kept.indexOf("tell them in one sentence why: the agent key, SUPER + SHIFT + CTRL + A, becomes one key that opens the agent that looks after this machine");
  assert.ok(why >= 0 && why < kept.indexOf("tell them to type /p/setup --apply --only agent-key"), kept);
  assert.doesNotMatch(kept, /consent/);
});

test("handoff: a hostname with a quote reaches the found-list and the prompt as it is", async (t) => {
  const w = world(t);
  w.put("node", "mise", "26.8.2");
  const oats = w.put("oats", "npm-global", "0.67.1");
  const env = w.env();
  const r = await handoff({ env, harness: "pi", oats, aw: null, toolsText: "node\t26.8.2\tmise\t/n\tfound\n", hostname: `o'brien "box"` });
  assert.ok(r.prompt.includes(`Its hostname is o'brien "box".`));
  assert.equal(JSON.parse(readFileSync(r.path, "utf8")).machine.hostname, `o'brien "box"`);
});

test("lib/install.mjs: tools lines, the skill from the CLI's own package, aw's environment", (t) => {
  assert.deepEqual(parseTools("aw\t1.36.47\tmise\t/a\tinstalled\nx\t-\tclaude-plugin\t-\tfound\n"), [
    { name: "aw", version: "1.36.47", origin: "mise", path: "/a", state: "installed" },
    { name: "x", version: null, origin: "claude-plugin", path: null, state: "found" },
  ]);
  assert.throws(() => parseTools("aw\t1\tmise\t/a\ttoo-old\n"), /cannot hold/);
  const w = world(t);
  const oats = w.put("oats", "npm-global", "0.67.1");
  assert.equal(gettingStartedSkill(oats), join(w.npm, "lib", "node_modules", "@awebai", "oats", "skills", "oats-getting-started", "SKILL.md"));
  const loose = join(w.root, "loose", "oats");
  writeExecutable(loose, "#!/bin/sh\n");
  assert.throws(() => gettingStartedSkill(loose), /is not inside the @awebai\/oats package/);
  assert.deepEqual(awEnvironment({ HOME: "/h", AWEB_IDENTITY_HOME: "/x", AW_TEAM: "t", AWKWARD: "k", PATH: "/p" }), { HOME: "/h", AWKWARD: "k", PATH: "/p" });
});

test("the installer is POSIX sh with Omarchy's header, needs no node to start, and is executable", () => {
  const text = readFileSync(INSTALLER, "utf8");
  assert.match(text, /^#!\/bin\/sh\n# omarchy:summary=.*\n# omarchy:args=\[--check\|--now\] \[--harness claude\|codex\|pi\]\n# omarchy:requires-sudo=true\n/);
  assert.equal(statSync(INSTALLER).mode & 0o111, 0o111);
});
