// The agent key, SUPER + SHIFT + CTRL + A: Omarchy's binds it to
// `omarchy-agent --pick`; once the person picks OATS (--agent-key oats, the
// answer to setup's question, or the menu's Setup > Default Agent > OATS
// row), setup's key block in bindings.lua gains a second section that binds
// it to the launcher, omarchy-launch-oats, by its absolute path. Each section
// of the block has its own checks, and a refused one is skipped alone;
// --agent-key omarchy gives the key back. Hyprland is the sandbox's fake
// (test/omarchy-container.test.mjs runs the real one); the launcher and setup
// that the menu row runs are stubs, and bin/launch.mjs is never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as bindings from "../lib/bindings.mjs";
import { paths as discoverPaths } from "../lib/discover.mjs";
import * as files from "../lib/files.mjs";
import * as keys from "../lib/keys.mjs";
import * as menu from "../lib/menu.mjs";
import { shellQuote } from "../lib/quote.mjs";
import { AGENT_QUESTION, blocksFor, lookUpSteward, NOT_CHOSEN, ONLY_HEADING, setup, UI_QUESTION } from "../lib/setup.mjs";
import { fixture, repo, sandbox, snapshot, withStewards, writeExecutable } from "./helpers/sandbox.mjs";

const USER_BINDINGS = '-- My bindings\no.bind("SUPER + RETURN", "Terminal", "uwsm-app -- xdg-terminal-exec")\n';
const MY_SUPER_O = 'o.bind("SUPER + O", "Mine", "true")\n';
const APPLY = "Apply it? [y/N] ";
const HINT = "Answer OATS or omarchy (Enter is OATS).\n";

// The user's Lua layout under `home`: a hyprland.lua and their bindings.lua,
// on a machine with one steward (the tests of the steward gate change that).
function hypr(s, text = USER_BINDINGS, { mode = 0o640, home = s.home } = {}) {
  withStewards(s);
  const dir = join(home, ".config", "hypr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hyprland.lua"), 'require("hypr.bindings")\n');
  const file = join(dir, "bindings.lua");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

// The Desktop's standard install, beside the TUI every sandbox has: with
// both, --apply asks which opens first.
function withDesktop(s) {
  const image = join(s.home, ".local/opt/oats-desktop/OATS-Desktop.AppImage");
  writeExecutable(image, "#!/bin/sh\nexit 0\n");
  mkdirSync(join(s.home, ".local/share/applications"), { recursive: true });
  writeFileSync(join(s.home, ".local/share/applications/oats-desktop.desktop"), `[Desktop Entry]\nType=Application\nName=OATS Desktop\nExec=${image} %U\n`);
}

// What `omarchy menu keybindings --print` shows, from Omarchy 4.0.4's.
const PRINT = readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8");
const AGENT_LINE = /^SUPER SHIFT CTRL \+ A +→ Agent\n/m;
assert.match(PRINT, AGENT_LINE, "the fixture binds the agent key to Omarchy's Agent");
const printShows = (s, text) => writeFileSync(join(s.root, "print.txt"), text);

const part = (r, name) => r.json.result.parts.find((x) => x.part === name);
const stateOf = (s) => JSON.parse(readFileSync(join(discoverPaths(s.env).stateDir, "state.json"), "utf8"));
const keysRecord = (s) => stateOf(s).files.find((f) => f.role === "keys");
const wrapperOf = (s) => discoverPaths(s.env).wrapper;
const hyprCalls = (s) => {
  try { return readFileSync(join(s.root, "hyprland.log"), "utf8").split("--\n").filter(Boolean).length; } catch { return 0; }
};
const caveat = (s) => `SUPER + SHIFT + CTRL + A opens the steward through ${wrapperOf(s)}. The bar's right click, \`omarchy agent prompt\` and crash notifications still open Omarchy's agent: they run omarchy-agent directly.`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// setup() in this process, as from a terminal: the answers are given in
// turn (a function is called for its answer); what it printed, each question
// asked, and how many times Hyprland had run when each was asked come back.
// A question is what was printed since the answer before it, from its last
// line: no terminal echoes the answer's newline here.
function fromTerminal(s, args, answers) {
  let out = "";
  const asked = [];
  const hyprWhenAsked = [];
  const queue = [...answers];
  let answered = 0;
  const write = { write: (x) => { out += x; } };
  const status = setup([...args, "--dir", s.deployment], s.env, write, write, { interactive: true, ask: () => {
    asked.push(out.slice(Math.max(out.lastIndexOf("\n") + 1, answered)));
    answered = out.length;
    hyprWhenAsked.push(hyprCalls(s));
    const answer = queue.shift() ?? "";
    return typeof answer === "function" ? answer() : answer;
  } });
  return { status, out, asked, hyprWhenAsked };
}

// ---------------------------------------------------------------------------
// The section and the menu row, as exact strings, with paths that hold
// spaces and `$` (assertSafePath allows both).

const WRAPPER = "/home/my user/$HOME dir/.local/bin/omarchy-launch-oats";
const BINDINGS = "/home/my user/$HOME dir/.config/hypr/bindings.lua";
const NODE = "/opt/node $v/bin/node";
const PLUGIN = "/srv/my plugins/oats-omarchy";
const DEPLOYMENT = "/home/my user/my $deployment";

test("the agent key's section, in Lua and in hyprlang: the launcher by its absolute path, one shell word", () => {
  const line = String.raw`o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", "'/home/my user/$HOME dir/.local/bin/omarchy-launch-oats'")`;
  assert.equal(keys.agentBindLine(WRAPPER), line);
  assert.equal(keys.agentLua(WRAPPER), `-- OATS: SUPER + SHIFT + CTRL + A opens the machine's steward (omarchy-launch-oats).\nhl.unbind("SUPER + SHIFT + CTRL + A")\n${line}\n`);
  assert.equal(keys.agentConf(WRAPPER), "# OATS: SUPER + SHIFT + CTRL + A opens the machine's steward (omarchy-launch-oats).\nunbind = SUPER SHIFT CTRL, A\nbindd = SUPER SHIFT CTRL, A, OATS agent, exec, '/home/my user/$HOME dir/.local/bin/omarchy-launch-oats'\n");
  // Spaces alone: double quotes, escaped for Lua.
  assert.equal(keys.agentBindLine("/home/my user/.local/bin/omarchy-launch-oats"), String.raw`o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", "\"/home/my user/.local/bin/omarchy-launch-oats\"")`);
  // The section starts with the line bindings.sections splits the block at.
  assert.ok(keys.agentLua(WRAPPER).startsWith(bindings.AGENT_START));
  const block = bindings.composeBlock({ submap: "-- a\n", agentKey: keys.agentLua(WRAPPER) });
  assert.equal(block, `${bindings.START}-- a\n${keys.agentLua(WRAPPER)}${bindings.END}`);
  assert.deepEqual(bindings.sections(block), { submap: "-- a\n", agentKey: keys.agentLua(WRAPPER) });
  assert.deepEqual(bindings.sections(bindings.composeBlock({ agentKey: keys.agentLua(WRAPPER) })), { submap: "", agentKey: keys.agentLua(WRAPPER) });
  assert.equal(bindings.composeBlock({}), null);
});

test("the Default Agent row's check and pick, exactly; blocksFor puts them in the menu block", () => {
  const checked = String.raw`grep -qxF -e 'o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", "'\''/home/my user/$HOME dir/.local/bin/omarchy-launch-oats'\''")' -- '/home/my user/$HOME dir/.config/hypr/bindings.lua'`;
  assert.equal(menu.agentChecked({ bindings: BINDINGS, line: keys.agentBindLine(WRAPPER) }), checked);
  const pick = String.raw`omarchy-launch-floating-terminal-with-presentation ''\''/opt/node $v/bin/node'\'' '\''/srv/my plugins/oats-omarchy/bin/setup.mjs'\'' --dir '\''/home/my user/my $deployment'\'' --apply --agent-key oats --only agent-key && grep -qxF -e '\''o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", "'\''\'\'''\''/home/my user/$HOME dir/.local/bin/omarchy-launch-oats'\''\'\'''\''")'\'' -- '\''/home/my user/$HOME dir/.config/hypr/bindings.lua'\'' && '\''/home/my user/$HOME dir/.local/bin/omarchy-launch-oats'\'''`;
  assert.equal(menu.agentPick({ setup: files.setupArgv({ node: NODE, pluginDir: PLUGIN, deployment: DEPLOYMENT }), checked, wrapper: WRAPPER }), pick);
  // With this computer's list of deployments: no --dir.
  const listed = String.raw`omarchy-launch-floating-terminal-with-presentation ''\''/opt/node $v/bin/node'\'' '\''/srv/my plugins/oats-omarchy/bin/setup.mjs'\'' --apply --agent-key oats --only agent-key && grep -qxF -e '\''o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", "'\''\'\'''\''/home/my user/$HOME dir/.local/bin/omarchy-launch-oats'\''\'\'''\''")'\'' -- '\''/home/my user/$HOME dir/.config/hypr/bindings.lua'\'' && '\''/home/my user/$HOME dir/.local/bin/omarchy-launch-oats'\'''`;
  assert.equal(menu.agentPick({ setup: files.setupArgv({ node: NODE, pluginDir: PLUGIN, deployment: null }), checked, wrapper: WRAPPER }), listed);

  const blocks = blocksFor({ shimPath: "/x/oats", deployment: DEPLOYMENT, node: NODE, pluginDir: PLUGIN, tuiReady: true, desktopExec: null, ui: "tui", wrapper: WRAPPER, bindingsPath: BINDINGS });
  const items = menu.omarchyParse(`{\n${blocks.menu}}\n`).items;
  assert.deepEqual(Object.keys(items), ["oats-ui", menu.AGENT_ID]);
  assert.equal(menu.AGENT_ID, "setup.default.agent.oats");
  assert.ok(menu.IDS.includes(menu.AGENT_ID), "the conflict check covers it");
  assert.deepEqual(items[menu.AGENT_ID], { icon: "\u{F06A9}", label: "OATS", checked, action: pick });
  assert.equal(items[menu.AGENT_ID].icon, items["oats-ui"].icon, "Omarchy's agent glyph");
  assert.deepEqual(blocks.keys.agentKey, keys.agentLua(WRAPPER));
});

test("the row's check is true only while bindings.lua holds the bind line as setup writes it", (t) => {
  const s = sandbox(t);
  const wrapper = join(s.root, "my $HOME bin", "omarchy-launch-oats");
  const file = join(s.root, "my $HOME hypr", "bindings.lua");
  mkdirSync(join(s.root, "my $HOME hypr"));
  const checked = menu.agentChecked({ bindings: file, line: keys.agentBindLine(wrapper) });
  const run = () => spawnSync("bash", ["-c", checked], { env: s.env, encoding: "utf8" }).status;
  writeFileSync(file, `${USER_BINDINGS}${bindings.composeBlock({ agentKey: keys.agentLua(wrapper) })}`);
  assert.equal(run(), 0);
  writeFileSync(file, USER_BINDINGS);
  assert.equal(run(), 1);
  // The line indented, or part of a longer line, is not setup's.
  writeFileSync(file, `  ${keys.agentBindLine(wrapper)}\n-- ${keys.agentBindLine(wrapper)}\n`);
  assert.equal(run(), 1);
});

// The pick as the menu runs it (`bash -lc <action>`), with the sandbox's
// floating terminal running its command: a stub node stands in for setup and
// a stub launcher for omarchy-launch-oats, both logging their arguments.
// $STUB_SETUP is what the stub setup does: "write" the bind line (an apply
// that moved the key), "skip" (an apply that left it), or "fail".
function pickRig(s, { deployment = s.deployment } = {}) {
  const dir = join(s.root, "stub $HOME dir");
  const node = join(dir, "node");
  const plugin = join(dir, "my plugin");
  const wrapper = join(dir, "omarchy-launch-oats");
  const file = join(dir, "bindings.lua");
  const log = join(s.root, "pick.log");
  writeExecutable(node, `#!/bin/sh
printf '[%s]' setup "$@" >> "$PICK_LOG"; echo >> "$PICK_LOG"
case "$STUB_SETUP" in
  write) printf '%s\\n' "$STUB_LINE" >> "$STUB_BINDINGS" ;;
  fail) exit 1 ;;
esac
exit 0
`);
  writeExecutable(wrapper, `#!/bin/sh\nprintf '[%s]' launcher "$@" >> "$PICK_LOG"; echo >> "$PICK_LOG"\n`);
  writeFileSync(file, USER_BINDINGS);
  const blocks = blocksFor({ shimPath: join(dir, "oats"), deployment, node, pluginDir: plugin, tuiReady: true, desktopExec: null, ui: "tui", wrapper, bindingsPath: file });
  const row = menu.omarchyParse(`{\n${blocks.menu}}\n`).items[menu.AGENT_ID];
  const pick = (mode) => {
    writeFileSync(file, USER_BINDINGS);
    try { unlinkSync(log); } catch { /* first run */ }
    // A login shell's profile may put Omarchy's own bin first (its dev-link
    // mode): the sandbox's fakes go first again, so the real floating
    // terminal is never run. The rest is the action, as written.
    const r = spawnSync("bash", ["-lc", `PATH=${shellQuote(s.fakebin)}:"$PATH"\n${row.action}`], {
      env: { ...s.env, FAKE_FLOATING_RUN: "1", PICK_LOG: log, STUB_SETUP: mode, STUB_LINE: keys.agentBindLine(wrapper), STUB_BINDINGS: file },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return existsSync(log) ? readFileSync(log, "utf8") : "";
  };
  return { pick, plugin, row };
}

test("the row's pick: setup --apply --agent-key oats --only agent-key in the floating terminal, then the check, then the launcher only when the check passes", (t) => {
  const s = sandbox(t, { deploymentName: "my deployment $x" });
  const { pick, plugin, row } = pickRig(s);
  const setupLine = `[setup][${plugin}/bin/setup.mjs][--dir][${s.deployment}][--apply][--agent-key][oats][--only][agent-key]\n`;
  // The stub setup writes the bind line, so the check, which runs after it,
  // passes, and the launcher runs, with no arguments.
  assert.equal(pick("write"), `${setupLine}[launcher]\n`);
  const floating = readFileSync(join(s.root, "floating.log"), "utf8");
  assert.equal(floating.split("\n").filter(Boolean).length, 1, "one floating terminal, the sandbox's");
  assert.ok(row.action.startsWith("omarchy-launch-floating-terminal-with-presentation "));
  // An apply that leaves the key (the agent-key part skipped), or one that
  // fails: no launcher.
  assert.equal(pick("skip"), setupLine);
  assert.equal(pick("fail"), setupLine);
});

test("the row's pick with this computer's list of deployments passes no --dir", (t) => {
  const s = sandbox(t);
  const { pick, plugin } = pickRig(s, { deployment: null });
  assert.equal(pick("write"), `[setup][${plugin}/bin/setup.mjs][--apply][--agent-key][oats][--only][agent-key]\n[launcher]\n`);
});

test("after an apply, the menu row is written exactly, for a home and a deployment with spaces and $", (t) => {
  const s = sandbox(t, { deploymentName: "my deployment $x" });
  const home = join(s.root, "my home $HOME");
  Object.assign(s.env, { HOME: home, XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CONFIG_HOME: join(home, ".config") });
  const file = hypr(s, USER_BINDINGS, { home });
  const wrapper = join(home, ".local/bin/omarchy-launch-oats");
  assert.equal(wrapperOf(s), wrapper);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "applied");
  const line = `o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", "'${wrapper}'")`;
  assert.ok(readFileSync(file, "utf8").includes(`\n${line}\n`));
  const items = menu.omarchyParse(readFileSync(join(home, ".config/omarchy/extensions/omarchy-menu.jsonc"), "utf8")).items;
  const checked = `grep -qxF -e 'o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", "'\\''${wrapper}'\\''")' -- '${file}'`;
  const q = (x) => `'\\''${x}'\\''`;
  const inner = `${q(process.execPath)} ${q(`${repo}/bin/setup.mjs`)} --dir ${q(s.deployment)} --apply --agent-key oats --only agent-key && grep -qxF -e '\\''o.bind("SUPER + SHIFT + CTRL + A", "OATS agent", "'\\''\\'\\'''\\''${wrapper}'\\''\\'\\'''\\''")'\\'' -- ${q(file)} && ${q(wrapper)}`;
  assert.deepEqual(items[menu.AGENT_ID], { icon: "\u{F06A9}", label: "OATS", checked, action: `omarchy-launch-floating-terminal-with-presentation '${inner}'` });

  // The check, run as the menu runs it: true now, false once the key is
  // given back; the row stays, since it is where OATS is picked.
  const run = () => spawnSync("bash", ["-c", items[menu.AGENT_ID].checked], { env: s.env }).status;
  assert.equal(run(), 0);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "omarchy"]).status, 0);
  assert.equal(run(), 1);
  const after = menu.omarchyParse(readFileSync(join(home, ".config/omarchy/extensions/omarchy-menu.jsonc"), "utf8")).items;
  assert.deepEqual(after[menu.AGENT_ID], items[menu.AGENT_ID]);
});

// ---------------------------------------------------------------------------
// The flag, the question, and no choice at all.

test("--plan --agent-key oats: the Agent key heading, where the choice came from, and the lines setup writes", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const before = snapshot(s.home);
  for (const flag of [["--agent-key", "oats"], ["--agent-key=oats"]]) {
    const text = s.run(["setup", "--plan", ...flag]).stdout;
    const snippet = keys.agentLua(wrapperOf(s)).trimEnd().split("\n").map((l) => `    ${l}`).join("\n");
    assert.ok(text.includes(`\nAgent key\n  OATS (--agent-key): SUPER + SHIFT + CTRL + A opens the steward through omarchy-launch-oats\n  Setup writes these lines into its oats-omarchy block in ${file}:\n\n${snippet}\n`), text);
  }
  const plan = s.run(["setup", "--plan", "--agent-key", "oats", "--json"]);
  assert.deepEqual(plan.json.result.agentKey, { choice: "oats", from: "--agent-key", snippet: keys.agentLua(wrapperOf(s)), format: "lua", file });
  assert.deepEqual(part(plan, "agent-key"), { part: "agent-key", status: "will apply", paths: [file] });
  const omarchy = s.run(["setup", "--plan", "--agent-key", "omarchy"]).stdout;
  assert.ok(omarchy.includes("\nAgent key\n  Omarchy's agent (--agent-key): SUPER + SHIFT + CTRL + A runs omarchy-agent --pick\n"), omarchy);
  assert.deepEqual(snapshot(s.home), before);
});

test("--agent-key takes oats or omarchy, with --plan or --apply only (E_BAD_ARGS, exit 2)", (t) => {
  const s = sandbox(t);
  const cases = [
    [["--plan", "--agent-key", "foo"], '--agent-key is oats or omarchy (got "foo")'],
    [["--apply", "--agent-key=OATS"], '--agent-key is oats or omarchy (got "OATS")'],
    [["--apply", "--agent-key"], "--agent-key needs a value"],
    [["--apply", "--agent-key", "--yes"], "--agent-key needs a value"],
    [["--check", "--agent-key", "oats"], "--agent-key goes with --plan or --apply"],
    [["--remove", "--agent-key", "oats"], "--agent-key goes with --plan or --apply"],
  ];
  for (const [args, message] of cases) {
    const r = s.run(["setup", ...args, "--json"], {}, { yes: false });
    assert.equal(r.status, 2, args.join(" "));
    assert.deepEqual([r.json.error.code, r.json.error.message], ["E_BAD_ARGS", message], args.join(" "));
    const text = s.run(["setup", ...args], {}, { yes: false });
    assert.equal(text.status, 2);
    assert.ok(text.stderr.startsWith(`setup: ${message}\nusage: setup `), text.stderr);
  }
  assert.equal(existsSync(join(s.home, ".local/state/oats-omarchy")), false);
});

test("no flag, no terminal, nothing recorded: --apply --yes asks nothing, refuses nothing, and leaves the key with Omarchy", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const r = s.run(["setup", "--apply", "--yes", "--json"], {}, { yes: false });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "skipped", reason: NOT_CHOSEN, paths: [] });
  assert.equal(NOT_CHOSEN, "not chosen, stays with Omarchy; pass --agent-key oats to open the steward with it");
  assert.deepEqual(r.json.result.agentKey, { choice: null, from: "not chosen" });
  assert.equal(part(r, "keys").status, "applied");
  assert.equal(part(r, "launcher").status, "applied", "the launcher is there for the person to pick later");
  assert.ok(!readFileSync(file, "utf8").includes(bindings.AGENT_START), "no agent-key section");
  assert.equal(stateOf(s).agentKey, null);
  assert.ok(Object.hasOwn(stateOf(s), "agentKey"), "written, as null");
  assert.ok(!r.json.result.notes.includes(caveat(s)));
  assert.match(s.run(["setup", "--plan"]).stdout, /\nAgent key\n {2}not chosen, stays with Omarchy; pass --agent-key oats to open the steward with it\n/);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

test("in a terminal, the agent key's question comes after the UI question and before Apply it?; Enter is OATS", (t) => {
  const s = sandbox(t);
  withDesktop(s);
  const file = hypr(s);
  const r = fromTerminal(s, ["--apply"], ["", "", "y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [UI_QUESTION, AGENT_QUESTION, APPLY]);
  assert.equal(AGENT_QUESTION, "The agent key (SUPER + SHIFT + CTRL + A) opens: OATS or Omarchy's agent? [OATS/omarchy] ");
  assert.match(r.out, /\nAgent key\n {2}OATS \(your answer\): SUPER \+ SHIFT \+ CTRL \+ A opens the steward through omarchy-launch-oats\n/, "the plan it shows has the answer");
  assert.equal(stateOf(s).agentKey, "oats");
  assert.ok(readFileSync(file, "utf8").includes(keys.agentLua(wrapperOf(s))));
  // A recorded choice is not asked again.
  assert.deepEqual(fromTerminal(s, ["--apply"], ["y"]).asked, [APPLY]);
  assert.equal(stateOf(s).agentKey, "oats");
});

for (const [answer, choice] of [["omarchy", "omarchy"], ["OMARCHY", "omarchy"], ["Oats", "oats"], [" oats ", "oats"]]) {
  test(`the agent key's question takes ${JSON.stringify(answer)} as ${choice}`, (t) => {
    const s = sandbox(t);
    const file = hypr(s);
    const r = fromTerminal(s, ["--apply"], [answer, "y"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.asked, [AGENT_QUESTION, APPLY], "one UI set up: no UI question");
    assert.equal(stateOf(s).agentKey, choice);
    assert.equal(readFileSync(file, "utf8").includes(bindings.AGENT_START), choice === "oats");
  });
}

test("the agent key's question asks again for anything else, with a hint; n still aborts", (t) => {
  const s = sandbox(t);
  hypr(s);
  const r = fromTerminal(s, ["--apply"], ["x", "steward", "omarchy", "y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [AGENT_QUESTION, AGENT_QUESTION, AGENT_QUESTION, APPLY]);
  assert.equal(r.out.split(HINT).length - 1, 2);
  assert.ok(r.out.includes(`${AGENT_QUESTION}${HINT}${AGENT_QUESTION}`));
  assert.equal(stateOf(s).agentKey, "omarchy");

  const fresh = sandbox(t);
  hypr(fresh);
  const before = snapshot(fresh.home);
  const no = fromTerminal(fresh, ["--apply"], ["", "n"]);
  assert.equal(no.status, 1);
  assert.match(no.out, /aborted: nothing was changed/);
  assert.deepEqual(snapshot(fresh.home), before, "the answer is not recorded either");
});

test("--yes in a terminal still asks the agent key's question; --agent-key given is not asked", (t) => {
  const s = sandbox(t);
  hypr(s);
  const r = fromTerminal(s, ["--apply", "--yes"], ["omarchy"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [AGENT_QUESTION]);
  assert.equal(stateOf(s).agentKey, "omarchy");
  assert.deepEqual(fromTerminal(s, ["--apply", "--yes"], []).asked, [], "recorded: not asked again");

  for (const choice of ["oats", "omarchy"]) {
    const given = sandbox(t);
    hypr(given);
    const g = fromTerminal(given, ["--apply", "--agent-key", choice], ["y"]);
    assert.equal(g.status, 0, g.out);
    assert.deepEqual(g.asked, [APPLY]);
    assert.match(g.out, /\nAgent key\n {2}\S.* \(--agent-key\)/);
    assert.equal(stateOf(given).agentKey, choice);
  }
});

// ---------------------------------------------------------------------------
// The two sections of the key block.

test("--apply --agent-key oats writes both sections in one block, SUPER + O first; a re-apply writes nothing and keeps the choice", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const plan = s.run(["setup", "--plan", "--agent-key", "oats", "--json"]);
  assert.ok(plan.json.result.notes.includes(caveat(s)), plan.json.result.notes.join("\n"));
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(part(r, "keys"), { part: "keys", status: "applied", paths: [file] });
  assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "applied", paths: [file] });
  assert.ok(r.json.result.notes.includes(caveat(s)));
  const rec = keysRecord(s);
  const { submap, agentKey } = bindings.sections(rec.block);
  assert.ok(submap.startsWith("-- OATS: SUPER + O, then T (TUI)") && submap.includes('o.bind("SUPER + O", "OATS", hl.dsp.submap("oats"))'), submap);
  assert.ok(!submap.includes("SUPER + SHIFT + CTRL + A"));
  assert.equal(agentKey, keys.agentLua(wrapperOf(s)));
  assert.equal(rec.block, `${bindings.START}${submap}${agentKey}${bindings.END}`);
  assert.equal(readFileSync(file, "utf8"), `${USER_BINDINGS}\n${rec.block}`, "one block, after a blank line");
  assert.equal(readFileSync(file, "utf8").split(bindings.START).length, 2);
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.equal(stateOf(s).agentKey, "oats");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);

  const after = snapshot(s.home);
  const again = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.deepEqual(again.json.result.written, []);
  assert.equal(part(again, "agent-key").status, "already applied");
  const kept = s.run(["setup", "--apply", "--json"]);
  assert.deepEqual(kept.json.result.written, []);
  assert.deepEqual(kept.json.result.agentKey, { choice: "oats", from: "chosen at an earlier --apply", snippet: agentKey, format: "lua", file });
  assert.equal(part(kept, "agent-key").status, "already applied");
  assert.deepEqual(snapshot(s.home), after, "nothing changed, the state included");
});

test("SUPER + O refused: the block holds the agent key's section alone", (t) => {
  const s = sandbox(t);
  const text = `${USER_BINDINGS}${MY_SUPER_O}`;
  const file = hypr(s, text);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "keys").status, "skipped");
  assert.match(part(r, "keys").reason, /^your bindings\.lua binds SUPER \+ O itself \(o\.bind\("SUPER \+ O"/);
  assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "applied", paths: [file] });
  const block = `${bindings.START}${keys.agentLua(wrapperOf(s))}${bindings.END}`;
  assert.equal(keysRecord(s).block, block);
  assert.equal(readFileSync(file, "utf8"), `${text}\n${block}`);
  assert.ok(r.json.result.notes.includes(caveat(s)));
  assert.ok(!r.json.result.notes.includes("SUPER+O becomes a prefix; pop-out moves to SUPER+O, O."));
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

const agentRefusals = [
  ["--print shows the agent key bound to something else", (s) => printShows(s, PRINT.replace(AGENT_LINE, "SUPER SHIFT CTRL + A                → My agent\n")),
    'SUPER + SHIFT + CTRL + A runs "My agent", not Omarchy\'s stock "Agent" (omarchy-agent --pick); setup does not replace it, so it does not move the agent key: adapt the snippet below'],
  ["--print shows Agent and another action on it", (s) => printShows(s, `${PRINT}SUPER SHIFT CTRL + A                → Mine\n`),
    'SUPER + SHIFT + CTRL + A runs "Mine" as well as Omarchy\'s stock "Agent" (omarchy-agent --pick); setup does not replace it, so it does not move the agent key: adapt the snippet below'],
  ["--print shows the agent key unbound", (s) => printShows(s, PRINT.replace(AGENT_LINE, "")),
    'SUPER + SHIFT + CTRL + A is not bound, Omarchy\'s stock "Agent" (omarchy-agent --pick); setup does not replace it, so it does not move the agent key: adapt the snippet below'],
  ["the user's bindings.lua binds it", (s) => hypr(s, `${USER_BINDINGS}o.bind("SUPER SHIFT CTRL + a", "Mine", "true")\n`),
    'your bindings.lua binds or unbinds SUPER + SHIFT + CTRL + A itself (o.bind("SUPER SHIFT CTRL + a"…); setup does not replace it, so it does not move the agent key: adapt the snippet below'],
  ["the user's bindings.lua binds it, spelled otherwise", (s) => hypr(s, `${USER_BINDINGS}o.bind('control+super+shift+A', "Mine", "true")\n`),
    "your bindings.lua binds or unbinds SUPER + SHIFT + CTRL + A itself (o.bind('control+super+shift+A'…); setup does not replace it, so it does not move the agent key: adapt the snippet below"],
  ["the user's bindings.lua unbinds it", (s) => hypr(s, `${USER_BINDINGS}hl.unbind("SUPER + SHIFT + CTRL + A")\n`),
    'your bindings.lua binds or unbinds SUPER + SHIFT + CTRL + A itself (hl.unbind("SUPER + SHIFT + CTRL + A"…); setup does not replace it, so it does not move the agent key: adapt the snippet below'],
];

for (const [name, arrange, reason] of agentRefusals) {
  test(`the agent key refused, SUPER + O still written: ${name}`, (t) => {
    const s = sandbox(t);
    hypr(s);
    arrange(s);
    const file = join(s.home, ".config/hypr/bindings.lua");
    const text = readFileSync(file, "utf8");
    const plan = s.run(["setup", "--plan", "--agent-key", "oats", "--json"]);
    assert.deepEqual(part(plan, "agent-key"), { part: "agent-key", status: "skipped", reason, paths: [] });
    assert.equal(part(plan, "keys").status, "will apply");
    assert.equal(plan.json.result.agentKey.snippet, keys.agentLua(wrapperOf(s)), "the snippet, for the person to adapt");
    assert.ok(!plan.json.result.notes.includes(caveat(s)));
    const shown = s.run(["setup", "--plan", "--agent-key", "oats"]).stdout;
    assert.ok(shown.includes(`  Setup does not write it (see the agent-key part); to move the key yourself, add this at the end of ${file}:\n\n    ${bindings.AGENT_START}`), shown);
    assert.ok(shown.includes(`  agent-key skipped: ${reason}\n`));

    const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(part(r, "keys").status, "applied");
    assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "skipped", reason, paths: [] });
    const rec = keysRecord(s);
    assert.deepEqual(bindings.sections(rec.block).agentKey, "", "the block holds the SUPER + O section alone");
    assert.equal(readFileSync(file, "utf8"), `${text}\n${rec.block}`);
    assert.equal(stateOf(s).agentKey, "oats", "the choice is recorded");
    assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  });
}

// ---------------------------------------------------------------------------
// Giving the key back, and --remove.

test("--apply --agent-key omarchy takes the agent key's section out and keeps SUPER + O's; every other byte stays", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  const { submap } = bindings.sections(keysRecord(s).block);
  const r = s.run(["setup", "--apply", "--agent-key", "omarchy", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "removed", paths: [file] });
  assert.equal(part(r, "keys").status, "already applied", "its own section is unchanged");
  assert.deepEqual(r.json.result.written, [file]);
  const block = `${bindings.START}${submap}${bindings.END}`;
  assert.equal(keysRecord(s).block, block);
  assert.equal(readFileSync(file, "utf8"), `${USER_BINDINGS}\n${block}`);
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.equal(stateOf(s).agentKey, "omarchy");
  assert.ok(!r.json.result.notes.includes(caveat(s)));
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  // Kept: a later --apply without the flag leaves it with Omarchy.
  const again = s.run(["setup", "--apply", "--json"]);
  assert.deepEqual(again.json.result.written, []);
  assert.deepEqual(part(again, "agent-key"), { part: "agent-key", status: "skipped", reason: "stays with Omarchy (chosen at an earlier --apply)", paths: [] });
});

test("giving the key back with no SUPER + O section removes the whole block: the file, its record and its backup as before setup", (t) => {
  const s = sandbox(t);
  const text = `${USER_BINDINGS}${MY_SUPER_O}`;
  const file = hypr(s, text, { mode: 0o600 });
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  const rec = keysRecord(s);
  const backup = join(discoverPaths(s.env).stateDir, rec.prior.backup);
  assert.equal(readFileSync(backup, "utf8"), text);
  const verified = hyprCalls(s);

  const r = s.run(["setup", "--apply", "--agent-key", "omarchy", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "removed");
  assert.equal(readFileSync(file, "utf8"), text, "byte for byte as before setup");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(keysRecord(s), undefined, "no keys record");
  assert.equal(existsSync(backup), false, "its backup is deleted");
  assert.equal(hyprCalls(s), verified, "a removal is not verified");
  assert.equal(stateOf(s).agentKey, "omarchy");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("giving the key back after the person edited bindings.lua: the block's bytes alone go, their edits stay", (t) => {
  const s = sandbox(t);
  const text = `${USER_BINDINGS}${MY_SUPER_O}`;
  const file = hypr(s, text);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  const rec = keysRecord(s);
  const edited = `-- top\n${readFileSync(file, "utf8")}-- bottom\n`;
  writeFileSync(file, edited);
  const r = s.run(["setup", "--apply", "--agent-key", "omarchy", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "removed");
  assert.equal(readFileSync(file, "utf8"), edited.replace(rec.block, ""));
  assert.equal(readFileSync(file, "utf8"), `-- top\n${text}\n-- bottom\n`, "the separator stays with the person's bytes");
  assert.equal(keysRecord(s), undefined);
  assert.equal(existsSync(join(discoverPaths(s.env).stateDir, rec.prior.backup)), false);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

// Giving the key back needs no OATS CLI: with the CLI setup checked no
// longer answering, setup's lines for the agent key still go, and the
// SUPER + O lines stay exactly as they are.
for (const [name, text] of [["no SUPER + O section", `${USER_BINDINGS}${MY_SUPER_O}`], ["a SUPER + O section", USER_BINDINGS]]) {
  test(`giving the key back with the OATS CLI broken since, ${name}: the agent key's lines go all the same`, (t) => {
    const s = sandbox(t);
    const file = hypr(s, text);
    assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
    const k = bindings.sections(keysRecord(s).block);
    assert.ok(k.agentKey);
    writeExecutable(s.cli, "#!/usr/bin/env node\nprocess.exit(1);\n");
    const r = s.run(["setup", "--apply", "--agent-key", "omarchy", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(part(r, "agent-key").status, "removed");
    assert.match(part(r, "keys").reason, /the OATS CLI cannot be used/);
    assert.equal(part(r, "shim").status, "skipped");
    assert.equal(stateOf(s).agentKey, "omarchy");
    if (k.submap) {
      assert.equal(part(r, "keys").status, "skipped");
      assert.equal(keysRecord(s).block, bindings.composeBlock({ submap: k.submap }), "the SUPER + O lines as they were");
      assert.equal(readFileSync(file, "utf8"), bindings.appendBlock(text, keysRecord(s).block).text);
    } else {
      assert.equal(readFileSync(file, "utf8"), text, "the block is gone, the file as before setup");
      assert.equal(keysRecord(s), undefined);
    }
    assert.ok(!readFileSync(file, "utf8").includes(keys.AGENT_OURS));
  });
}

// The same for setup applied for this computer's list of deployments, run
// from outside any deployment: without a CLI to ask, it stays applied for
// the list, so there is no deployment to find, and the key goes back.
test("giving the key back with the OATS CLI broken since, applied for the list, from HOME: the agent key's lines go", (t) => {
  const s = sandbox(t);
  const text = `${USER_BINDINGS}${MY_SUPER_O}`;
  const file = hypr(s, text);
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.60.0", features: ["deployments-list"] }));
  // The list holds the deployment, whose status lists the steward.
  writeFileSync(join(s.root, "deployments.json"), JSON.stringify({ deploymentsApi: 1, file: join(s.home, ".oats", "config", "deployments.json"), deployments: [{ path: s.deployment, name: "machine", state: "ok" }], imports: {} }));
  const first = s.run(["setup", "--apply", "--agent-key", "oats", "--json"], {}, { cwd: s.home });
  assert.equal(part(first, "agent-key").status, "applied", part(first, "agent-key").reason);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(stateOf(s).deployment, null);
  writeExecutable(s.cli, "#!/usr/bin/env node\nprocess.exit(1);\n");
  const r = s.run(["setup", "--apply", "--agent-key", "omarchy", "--json"], {}, { cwd: s.home });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "removed");
  assert.equal(r.json.result.deployment, null);
  assert.equal(readFileSync(file, "utf8"), text);
  assert.equal(stateOf(s).deployment, null, "still applied for the list");
  assert.equal(stateOf(s).agentKey, "omarchy");
});

// A choice given back whose lines could not be taken out (here, edited into
// the state by hand) is what --check reports.
test("--check: the agent key's lines still in the block while the key is given back are drift", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  const statePath = join(discoverPaths(s.env).stateDir, "state.json");
  writeFileSync(statePath, JSON.stringify({ ...stateOf(s), agentKey: "omarchy" }));
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, [
    `the agent key still opens OATS, though it is given back to Omarchy: setup's lines for it are still in ${file}: run setup --apply again`,
  ]);
});

// Only the key block calls the shim (no TUI, hook or menu part): the shim and
// the launcher are applied for its SUPER + O lines, and so is the agent key.
test("the key block alone calls the shim: the launcher and the agent key's section are applied with it", (t) => {
  const s = sandbox(t, { launchers: ["omarchy-launch-floating-terminal-with-presentation"] });
  const file = hypr(s);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of ["shim", "keys", "launcher", "agent-key"]) assert.equal(part(r, name).status, "applied", `${name}: ${part(r, name).reason}`);
  for (const name of ["tui", "hook", "menu"]) assert.equal(part(r, name).status, "skipped", name);
  assert.ok(readFileSync(file, "utf8").includes(keys.agentBindLine(wrapperOf(s))));
});

// Hyprland refusing the candidate when only the submap's lines call the
// shim: Hyprland checks the one candidate, and nothing is retried without
// the agent key's lines; both sections are skipped with its reason.
test("the key block alone calls the shim, and Hyprland refuses the agent key's lines: nothing written, one verification, Hyprland's reason", (t) => {
  const s = sandbox(t, { launchers: ["omarchy-launch-floating-terminal-with-presentation"] });
  const file = hypr(s);
  const calls = join(s.root, "verify-count");
  writeExecutable(join(s.fakebin, "Hyprland"), `#!/bin/sh
printf 'verify\\n' >> '${calls}'
if grep -q 'OATS agent' "$(dirname "$3")/bindings.lua"; then
  printf '======== Config parsing result:\\nagent binding unsupported\\n'
  exit 1
fi
printf '======== Config parsing result:\\nconfig ok\\n'
`);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(file, "utf8"), USER_BINDINGS);
  assert.equal(part(r, "keys").status, "skipped");
  assert.equal(part(r, "agent-key").status, "skipped");
  assert.equal(part(r, "agent-key").reason, part(r, "keys").reason);
  assert.match(part(r, "keys").reason, /agent binding unsupported/);
  assert.equal(readFileSync(calls, "utf8"), "verify\nverify\n", "the unchanged copy, then the one candidate");
});

test("--remove after an apply with both sections puts the whole home back", (t) => {
  const s = sandbox(t);
  hypr(s);
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  assert.ok(existsSync(wrapperOf(s)));
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(snapshot(s.home), before);
});

// ---------------------------------------------------------------------------
// Hyprland's verification, the hyprlang layout, and --check.

test("Hyprland refusing the block skips both sections with its reason; the rest is applied", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  s.env.FAKE_HYPR_REFUSE_BLOCK = "1";
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const reason = part(r, "keys").reason;
  assert.match(reason, /^Hyprland --verify-config refuses your config with the key block added, so setup writes nothing:\n======== Config parsing result:\nconfig error in .*bindings\.lua:3/);
  assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "skipped", reason, paths: [] });
  assert.equal(readFileSync(file, "utf8"), USER_BINDINGS);
  assert.equal(part(r, "launcher").status, "applied");
});

test("an interactive --apply verifies the block once, after the answers, never while it asks", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const r = fromTerminal(s, ["--apply"], ["", "y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [AGENT_QUESTION, APPLY]);
  assert.deepEqual(r.hyprWhenAsked, [0, 0], "the plan shown before the questions runs no Hyprland");
  assert.match(r.out, /Once you confirm, and before it writes the key block, setup runs Hyprland --verify-config/);
  assert.equal(hyprCalls(s), 2, "the current copy and the candidate, once");
  assert.equal(readFileSync(join(s.root, "hyprland-saw.lua"), "utf8"), readFileSync(file, "utf8"), "it checked what was written, both sections");
  assert.ok(readFileSync(file, "utf8").includes(keys.agentLua(wrapperOf(s))));

  // A change while setup waits for the answer: the check after it sees it.
  const s2 = sandbox(t);
  const file2 = hypr(s2);
  const late = fromTerminal(s2, ["--apply"], ["oats", () => { s2.env.FAKE_HYPR_REFUSE_BLOCK = "1"; return "y"; }]);
  assert.equal(late.status, 0, late.out);
  assert.equal(readFileSync(file2, "utf8"), USER_BINDINGS, "the key block was not written");
});

test("the hyprlang layout: nothing is written to bindings.conf, and the plan prints the agent key's hyprlang lines", (t) => {
  const s = sandbox(t);
  const dir = join(s.home, ".config/hypr");
  mkdirSync(dir, { recursive: true });
  const conf = join(dir, "bindings.conf");
  writeFileSync(conf, "# mine\n");
  const plan = s.run(["setup", "--plan", "--agent-key", "oats", "--json"]);
  assert.deepEqual(plan.json.result.agentKey, { choice: "oats", from: "--agent-key", snippet: keys.agentConf(wrapperOf(s)), format: "conf", file: conf });
  assert.equal(part(plan, "agent-key").status, "skipped");
  assert.match(part(plan, "agent-key").reason, /the hyprlang layout\), and setup writes the key only into bindings\.lua/);
  const text = s.run(["setup", "--plan", "--agent-key", "oats"]).stdout;
  assert.ok(text.includes(`to move the key yourself, add this at the end of ${conf}:\n\n    # OATS: SUPER + SHIFT + CTRL + A opens the machine's steward (omarchy-launch-oats).\n    unbind = SUPER SHIFT CTRL, A\n    bindd = SUPER SHIFT CTRL, A, OATS agent, exec, ${wrapperOf(s)}\n`), text);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(conf, "utf8"), "# mine\n");
  assert.ok(!r.json.result.written.includes(conf));
});

test("--check: a recorded block with either section or both is this version's; another section b is from another version", (t) => {
  // SUPER + O alone (no agent key chosen).
  const a = sandbox(t);
  hypr(a);
  assert.equal(a.run(["setup", "--apply"]).status, 0);
  assert.equal(bindings.sections(keysRecord(a).block).agentKey, "");
  assert.deepEqual(a.run(["setup", "--check", "--json"]).json.result.drift, []);

  // The agent key alone (SUPER + O refused).
  const b = sandbox(t);
  hypr(b, `${USER_BINDINGS}${MY_SUPER_O}`);
  assert.equal(b.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  assert.equal(bindings.sections(keysRecord(b).block).submap, "");
  assert.deepEqual(b.run(["setup", "--check", "--json"]).json.result.drift, []);

  // Both, then a section b that differs, in the file and in the record alike.
  const both = sandbox(t);
  const file = hypr(both);
  assert.equal(both.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  assert.deepEqual(both.run(["setup", "--check", "--json"]).json.result.drift, []);
  const stateFile = join(discoverPaths(both.env).stateDir, "state.json");
  const state = stateOf(both);
  const rec = state.files.find((f) => f.role === "keys");
  const other = rec.block.replace('"OATS agent"', '"OATS steward"');
  assert.notEqual(other, rec.block);
  writeFileSync(file, readFileSync(file, "utf8").replace(rec.block, other));
  rec.block = other;
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  assert.deepEqual(both.run(["setup", "--check", "--json"]).json.result.drift, [`the oats key block in ${file} is from another version of setup: run setup --apply again`]);
  assert.match(both.run(["setup", "--check"]).stdout, new RegExp(`^oats-omarchy: the oats key block in ${escape(file)} is from another version of setup`));
});

// ---------------------------------------------------------------------------
// The steward gate: the key moves to OATS only when findSteward
// (lib/steward.mjs) finds exactly one steward, read when setup runs. The
// recorded choice stays "oats" either way, and a key already moved stays.

const NO_STEWARD = "the agent key stays with Omarchy until this machine has one steward: no steward on this machine: spawn one with `oats spawn oats.machine/steward --name steward` in the machine's deployment; run setup --apply again after spawning it";
const agentLines = (file) => readFileSync(file, "utf8").includes(keys.AGENT_OURS);

test("the steward gate: one steward, and the key moves to OATS", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  withStewards(s, ["steward"]);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "applied");
  assert.ok(agentLines(file));
});

test("the steward gate: no steward, the key stays with Omarchy, the choice is recorded, and the plan says why", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  withStewards(s, []);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "skipped", reason: NO_STEWARD, paths: [] });
  assert.equal(part(r, "keys").status, "applied", "SUPER + O is written all the same");
  assert.equal(part(r, "launcher").status, "applied");
  assert.ok(!agentLines(file));
  assert.equal(stateOf(s).agentKey, "oats");
  assert.ok(s.run(["setup", "--plan"]).stdout.includes(`  agent-key skipped: ${NO_STEWARD}\n`));
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

test("the steward gate: two stewards, the key stays with Omarchy, and both are named", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  withStewards(s, ["steward", "steward-2"]);
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "skipped");
  assert.match(part(r, "agent-key").reason, /^the agent key stays with Omarchy until this machine has one steward: several stewards on this machine, and none is chosen: steward @ \S+, steward-2 @ \S+; run setup --apply again after spawning it$/);
  assert.ok(!agentLines(file));
  assert.equal(stateOf(s).agentKey, "oats");
});

test("the steward gate: a key already moved stays with OATS when no steward is found at a re-apply, and the plan notes it", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  const moved = readFileSync(file, "utf8");
  withStewards(s, []);
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "already applied");
  assert.equal(readFileSync(file, "utf8"), moved, "section b is kept, unchanged");
  assert.deepEqual(r.json.result.written, []);
  assert.ok(r.json.result.notes.includes("No steward was found now (no steward on this machine: spawn one with `oats spawn oats.machine/steward --name steward` in the machine's deployment): the agent key still opens OATS, and says so when it is pressed."), r.json.result.notes.join("\n"));
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

test("the steward gate: a later --apply with one steward moves the key without asking again", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  withStewards(s, []);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  assert.ok(!agentLines(file));
  withStewards(s, ["steward"]);
  const r = fromTerminal(s, ["--apply"], ["y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [APPLY], "only Apply it?: the choice is recorded");
  assert.ok(agentLines(file));
  assert.ok(readFileSync(file, "utf8").includes(keys.agentBindLine(wrapperOf(s))));
});

test("the steward gate: the kernel read for it fails, and the key stays with Omarchy with the kernel's reason", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  writeFileSync(join(s.root, "status.mode"), "envelope");
  const r = s.run(["setup", "--apply", "--agent-key", "oats", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "skipped");
  assert.match(part(r, "agent-key").reason, /^the agent key stays with Omarchy until this machine has one steward: no steward on this machine: .*; not read: .*oats-lock\.json is unreadable/);
  assert.ok(!agentLines(file));
});

// The lookup answers within its budget however slow the kernel is, and
// leaves no kernel running: the fake kernel's status read hangs, with a
// child of its own (both pids logged in status.pids).
test("the steward lookup stops at its budget: its reason, and the hanging kernel read and its child are gone", async (t) => {
  const s = sandbox(t);
  writeFileSync(join(s.root, "status.mode"), "hang");
  const started = Date.now();
  const found = lookUpSteward({ node: process.execPath, cli: s.cli, features: [], deployment: s.deployment, env: s.env, path: s.env.PATH }, { budgetMs: 1500 });
  assert.deepEqual(found, { ok: false, reason: "no answer within 1.5 s" });
  assert.ok(Date.now() - started < 10_000, "the budget, not the backstop");
  const pids = readFileSync(join(s.root, "status.pids"), "utf8").trim().split(/\s+/).map(Number);
  assert.equal(pids.length, 2);
  const alive = () => pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  for (let i = 0; i < 40 && alive().length; i++) await new Promise((done) => setTimeout(done, 50));
  try { assert.deepEqual(alive(), [], "the kernel read and its child are gone"); } finally { for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
});

// ---------------------------------------------------------------------------
// --only agent-key: what picking OATS for the agent key changes, and nothing
// else. The Default Agent row runs it; a person types it. SUPER + O, the
// launcher entries, the hook, the menu and the default UI stay as they are,
// on disk and in setup's state.

// The paths under HOME that are new or changed since `before`; none may go.
function changedSince(s, before) {
  const after = snapshot(s.home);
  for (const path of before.keys()) assert.ok(after.has(path), `${path} is still there`);
  return [...after].filter(([path, entry]) => before.get(path) !== entry).map(([path]) => path).sort();
}
const ONLY_RUN = ["setup", "--apply", "--only", "agent-key"];
const stateRel = ".local/state/oats-omarchy";

test("--only agent-key on a fresh HOME writes the shim, the launcher and a key block holding only the agent key's section, and nothing else", (t) => {
  const s = sandbox(t);
  // Both UIs found and none chosen: a full --apply without a terminal would
  // refuse (E_UI_REQUIRED); this one never asks.
  withDesktop(s);
  const file = hypr(s);
  const p = discoverPaths(s.env);
  const before = snapshot(s.home);
  const r = s.run([...ONLY_RUN, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.result.parts.map((x) => [x.part, x.status]), [["shim", "applied"], ["launcher", "applied"], ["agent-key", "applied"]]);
  assert.deepEqual([...r.json.result.written].sort(), [p.shim, p.wrapper, file].sort());
  const rec = keysRecord(s);
  assert.deepEqual(changedSince(s, before), [
    ".config/hypr/bindings.lua",
    ".local/bin", relative(s.home, p.wrapper),
    ".local/share/oats-omarchy", relative(s.home, p.shim),
    ".local/state", stateRel, `${stateRel}/backup`, `${stateRel}/${rec.prior.backup}`, `${stateRel}/node`, `${stateRel}/state.json`,
  ].sort(), "no launcher entry, icon, hook, menu or plugin.json");
  const block = `${bindings.START}${keys.agentLua(p.wrapper)}${bindings.END}`;
  assert.equal(rec.block, block);
  assert.equal(readFileSync(file, "utf8"), `${USER_BINDINGS}\n${block}`);
  assert.equal(readFileSync(p.shim, "utf8"), files.shim({ node: process.execPath, cli: s.cli }));
  assert.equal(readFileSync(p.wrapper, "utf8"), files.launcher({ node: process.execPath, pluginDir: repo }));
  const state = stateOf(s);
  assert.deepEqual([state.parts, state.ui, state.agentKey, state.desktop, state.deployment], [["shim", "launcher", "keys"], null, "oats", null, s.deployment]);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, [], "no drift: the bar widget's file goes with a full --apply");

  // A full --apply afterwards takes the narrowed apply as its own work.
  const plan = s.run(["setup", "--plan", "--ui", "tui", "--json"]);
  for (const name of ["shim", "launcher"]) assert.deepEqual(part(plan, name), { part: name, status: "already applied", paths: [name === "shim" ? p.shim : p.wrapper] }, "no \"replaces an existing file\"");
  assert.ok(!s.run(["setup", "--plan", "--ui", "tui"]).stdout.includes("replaces"));
  const full = s.run(["setup", "--apply", "--ui", "tui", "--json"]);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  for (const name of ["tui", "hook", "menu", "keys"]) assert.equal(part(full, name).status, "applied", name);
  assert.equal(part(full, "agent-key").status, "already applied");
  assert.ok(!full.json.result.written.includes(p.shim) && !full.json.result.written.includes(p.wrapper));
  assert.deepEqual(bindings.sections(keysRecord(s).block).agentKey, keys.agentLua(p.wrapper));
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

test("--only agent-key over a full setup: SUPER + O's section, the entries, the hook, the menu, the bar widget's file and the default UI stay byte for byte", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const p = discoverPaths(s.env);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "omarchy"]).status, 0);
  const submap = bindings.sections(keysRecord(s).block).submap;
  assert.ok(submap.includes("SUPER + O") && !submap.includes("OATS Desktop"), submap);
  // The Desktop appears since: a full --apply would now plan SUPER + O's
  // section anew (with D), and asks which UI opens first.
  withDesktop(s);
  assert.equal(part(s.run(["setup", "--plan", "--ui", "tui", "--json"]), "keys").status, "will apply");
  assert.equal(s.run(["setup", "--apply", "--json"]).json.error.code, "E_UI_REQUIRED");
  const state0 = stateOf(s);
  const drift0 = s.run(["setup", "--check", "--json"]).json.result.drift;
  const before = snapshot(s.home);

  const r = s.run([...ONLY_RUN, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.result.parts.map((x) => [x.part, x.status]), [["shim", "already applied"], ["launcher", "already applied"], ["agent-key", "applied"]]);
  assert.deepEqual(r.json.result.written, [file]);
  assert.deepEqual(changedSince(s, before), [".config/hypr/bindings.lua", `${stateRel}/state.json`]);
  const block = `${bindings.START}${submap}${keys.agentLua(p.wrapper)}${bindings.END}`;
  assert.equal(readFileSync(file, "utf8"), `${USER_BINDINGS}\n${block}`, "SUPER + O's section as recorded, byte for byte");
  assert.equal(readFileSync(join(s.root, "hyprland-saw.lua"), "utf8"), readFileSync(file, "utf8"), "Hyprland verified the whole candidate, both sections");
  const { files: files1, agentKey: agentKey1, ...rest1 } = stateOf(s);
  const { files: files0, agentKey: agentKey0, ...rest0 } = state0;
  assert.deepEqual([agentKey0, agentKey1], ["omarchy", "oats"]);
  assert.deepEqual(rest1, rest0, "the deployment, node, plugin directory, Desktop, parts and default UI as recorded");
  assert.deepEqual(files1.filter((f) => f.role !== "keys"), files0.filter((f) => f.role !== "keys"));
  assert.equal(keysRecord(s).block, block);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, drift0);

  // Given back the same way: only the agent key's section goes.
  const backBefore = snapshot(s.home);
  const back = s.run([...ONLY_RUN, "--agent-key", "omarchy", "--json"]);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(part(back, "agent-key").status, "removed");
  assert.deepEqual(changedSince(s, backBefore), [".config/hypr/bindings.lua", `${stateRel}/state.json`]);
  assert.equal(readFileSync(file, "utf8"), `${USER_BINDINGS}\n${bindings.composeBlock({ submap })}`);
  assert.equal(stateOf(s).agentKey, "omarchy");
});

test("--only agent-key gives the key back with --agent-key omarchy: the block goes, the shim and the launcher stay", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  const p = discoverPaths(s.env);
  // Nothing applied yet: there is nothing to give back, and nothing is written.
  const fresh = snapshot(s.home);
  const none = s.run([...ONLY_RUN, "--agent-key", "omarchy", "--json"]);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.deepEqual(none.json.result.written, []);
  assert.deepEqual(snapshot(s.home), fresh);

  assert.equal(s.run(ONLY_RUN).status, 0);
  const rec = keysRecord(s);
  const r = s.run([...ONLY_RUN, "--agent-key", "omarchy", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const left = "the agent key is given back, so it is left as it is";
  assert.deepEqual(r.json.result.parts, [
    { part: "shim", status: "skipped", reason: left, paths: [] },
    { part: "launcher", status: "skipped", reason: left, paths: [] },
    { part: "agent-key", status: "removed", paths: [file] },
  ]);
  assert.deepEqual(r.json.result.agentKey, { choice: "omarchy", from: "--agent-key" });
  assert.equal(readFileSync(file, "utf8"), USER_BINDINGS, "the block is gone, the file as before setup");
  assert.equal(keysRecord(s), undefined);
  assert.equal(existsSync(join(p.stateDir, rec.prior.backup)), false);
  assert.ok(existsSync(p.shim) && existsSync(p.wrapper));
  assert.equal(stateOf(s).agentKey, "omarchy");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

test("--plan --only agent-key: its heading, only its parts, no default UI or SUPER + O; it writes nothing", (t) => {
  const s = sandbox(t);
  withDesktop(s);
  const file = hypr(s);
  const p = discoverPaths(s.env);
  assert.equal(ONLY_HEADING, "Only the agent key: SUPER + O, the launchers, the menu and the hook are left as they are");
  const before = snapshot(s.home);
  const text = s.run(["setup", "--plan", "--only", "agent-key"]).stdout;
  assert.ok(text.startsWith(`setup --plan --only agent-key (nothing was written)\n\n${ONLY_HEADING}\n  shim      will apply\n            ${p.shim}\n  launcher  will apply\n            ${p.wrapper}\n  agent-key will apply\n            ${file}\n\nAgent key\n  OATS (--only agent-key): SUPER + SHIFT + CTRL + A opens the steward through omarchy-launch-oats\n`), text);
  for (const heading of ["\nParts\n", "\nDefault UI\n", "\nKeys\n"]) assert.ok(!text.includes(heading), heading);
  assert.ok(!text.includes("SUPER+O becomes a prefix"));
  assert.ok(text.endsWith("\nRun `setup --apply --only agent-key` to write the parts marked \"will apply\"; `setup --apply --only agent-key --agent-key omarchy` gives the key back.\n"), text);
  // The mode alone is --plan, as without --only.
  assert.equal(s.run(["setup", "--only=agent-key"]).stdout, text);

  const plan = s.run(["setup", "--plan", "--only", "agent-key", "--agent-key", "oats", "--json"]);
  const result = plan.json.result;
  assert.equal(result.only, "agent-key");
  assert.deepEqual(result.parts.map((x) => x.part), ["shim", "launcher", "agent-key"]);
  assert.ok(!Object.hasOwn(result, "ui") && !Object.hasOwn(result, "keys"), Object.keys(result).join(", "));
  assert.deepEqual(result.agentKey, { choice: "oats", from: "--agent-key", snippet: keys.agentLua(p.wrapper), format: "lua", file });
  assert.ok(result.notes.includes(caveat(s)));
  assert.deepEqual(snapshot(s.home), before);
});

test("--only takes agent-key, with --plan or --apply only, and not with --ui or --desktop (E_BAD_ARGS, exit 2)", (t) => {
  const s = sandbox(t);
  const cases = [
    [["--apply", "--only", "menu"], '--only takes agent-key (got "menu")'],
    [["--plan", "--only=keys"], '--only takes agent-key (got "keys")'],
    [["--apply", "--only"], "--only needs a value"],
    [["--apply", "--only", "--yes"], "--only needs a value"],
    [["--check", "--only", "agent-key"], "--only goes with --plan or --apply"],
    [["--remove", "--only", "agent-key"], "--only goes with --plan or --apply"],
    [["--apply", "--only", "agent-key", "--ui", "tui"], "--ui does not go with --only agent-key, which leaves the default UI as it is"],
    [["--plan", "--only", "agent-key", "--desktop", "/opt/x.AppImage"], "--desktop does not go with --only agent-key, which leaves the Desktop as it is"],
  ];
  for (const [args, message] of cases) {
    const r = s.run(["setup", ...args, "--json"], {}, { yes: false });
    assert.equal(r.status, 2, args.join(" "));
    assert.deepEqual([r.json.error.code, r.json.error.message], ["E_BAD_ARGS", message], args.join(" "));
    const text = s.run(["setup", ...args], {}, { yes: false });
    assert.ok(text.stderr.startsWith(`setup: ${message}\nusage: setup `), text.stderr);
  }
  assert.match(s.run(["setup", "--apply", "--only", "x"], {}, { yes: false }).stderr, /\[--only agent-key\]/, "the usage names it");
  assert.equal(existsSync(join(s.home, ".local/state/oats-omarchy")), false);
});

test("--only agent-key still needs the person's yes: in a terminal it asks only Apply it?, and without one it refuses without --yes", (t) => {
  const s = sandbox(t);
  withDesktop(s);
  const file = hypr(s);
  const before = snapshot(s.home);
  const refused = s.run([...ONLY_RUN, "--json"], {}, { yes: false });
  assert.equal(refused.status, 1);
  assert.equal(refused.json.error.code, "E_CONFIRM");
  assert.deepEqual(snapshot(s.home), before);
  const no = fromTerminal(s, ["--apply", "--only", "agent-key"], ["n"]);
  assert.deepEqual(no.asked, [APPLY], "no UI question, no agent key question");
  assert.deepEqual(snapshot(s.home), before);
  const r = fromTerminal(s, ["--apply", "--only", "agent-key"], ["y"]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.asked, [APPLY]);
  assert.deepEqual(r.hyprWhenAsked, [0], "verified after the answer, not before");
  assert.ok(r.out.includes(`\n${ONLY_HEADING}\n`));
  assert.ok(readFileSync(file, "utf8").includes(keys.agentLua(wrapperOf(s))));
});

test("--only agent-key keeps the steward gate: with no steward the key stays with Omarchy, and the shim and the launcher are written for a later run", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  withStewards(s, []);
  const r = s.run([...ONLY_RUN, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "skipped", reason: "the agent key stays with Omarchy until this machine has one steward: no steward on this machine: spawn one with `oats spawn oats.machine/steward --name steward` in the machine's deployment; run setup --apply --only agent-key again after spawning it", paths: [] });
  assert.equal(part(r, "shim").status, "applied");
  assert.equal(part(r, "launcher").status, "applied");
  assert.equal(readFileSync(file, "utf8"), USER_BINDINGS);
  assert.equal(stateOf(s).agentKey, "oats");
  withStewards(s, ["steward"]);
  const again = s.run([...ONLY_RUN, "--json"]);
  assert.equal(part(again, "agent-key").status, "applied");
  assert.ok(agentLines(file));
});

test("--only agent-key keeps the stock-binding check and Hyprland's verification", (t) => {
  // The person binds the key themselves: the plan prints the lines to adapt.
  const s = sandbox(t);
  const mine = `${USER_BINDINGS}o.bind("SUPER SHIFT CTRL + a", "Mine", "true")\n`;
  const file = hypr(s, mine);
  const r = s.run([...ONLY_RUN, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").reason, agentRefusals[3][2]);
  assert.equal(readFileSync(file, "utf8"), mine);
  assert.equal(part(r, "launcher").status, "applied", "the snippet runs the launcher");
  assert.ok(s.run(["setup", "--plan", "--only", "agent-key"]).stdout.includes(`to move the key yourself, add this at the end of ${file}:`));

  // Hyprland refuses the candidate: nothing goes into bindings.lua.
  const h = sandbox(t);
  const hfile = hypr(h);
  h.env.FAKE_HYPR_REFUSE_BLOCK = "1";
  const refused = h.run([...ONLY_RUN, "--json"]);
  assert.equal(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(part(refused, "agent-key").reason, /^Hyprland --verify-config refuses your config with the key block added/);
  assert.equal(readFileSync(hfile, "utf8"), USER_BINDINGS);
});

test("--only agent-key leaves a hook or menu the person changed alone, where a full --apply refuses", (t) => {
  const s = sandbox(t);
  hypr(s);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "omarchy"]).status, 0);
  const hook = join(s.home, ".config/omarchy/hooks/post-update.d/oats-omarchy.hook");
  writeFileSync(hook, `${readFileSync(hook, "utf8")}# mine\n`);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats", "--json"]).json.error.code, "E_MODIFIED");
  const r = s.run([...ONLY_RUN, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "applied");
  assert.ok(readFileSync(hook, "utf8").endsWith("# mine\n"));
});

test("--remove after --only agent-key on a fresh HOME puts the whole home back", (t) => {
  const s = sandbox(t);
  hypr(s);
  const before = snapshot(s.home);
  assert.equal(s.run(ONLY_RUN).status, 0);
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(snapshot(s.home), before);
});

// What the state records after --only agent-key is what the files it leaves
// run: the OATS CLI of a shim it did not touch, and, over its own work
// alone, the node of the shim and launcher it rewrote.
test("--only agent-key giving the key back keeps the recorded OATS CLI of the shim it leaves alone", (t) => {
  const s = sandbox(t);
  hypr(s);
  assert.equal(s.run(["setup", "--apply", "--agent-key", "oats"]).status, 0);
  const cli = stateOf(s).cli;
  const shim = readFileSync(discoverPaths(s.env).shim, "utf8");
  // `oats` is gone from PATH; the CLI setup recorded is still there.
  unlinkSync(join(s.fakebin, "oats"));
  const r = s.run([...ONLY_RUN, "--agent-key", "omarchy", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "removed");
  assert.equal(readFileSync(discoverPaths(s.env).shim, "utf8"), shim);
  assert.equal(stateOf(s).cli, cli);
  assert.ok(!s.run(["setup", "--check", "--json"]).json.result.drift.some((d) => d.includes("OATS CLI")));
});

test("--only agent-key again over its own work alone records the node its rewritten shim and launcher run", (t) => {
  const s = sandbox(t, { node: true });
  hypr(s);
  const p = discoverPaths(s.env);
  assert.equal(s.run(ONLY_RUN).status, 0);
  const old = stateOf(s).node;
  unlinkSync(old);
  const node = join(s.fakebin, "node");
  symlinkSync(process.execPath, node);
  const r = s.run([...ONLY_RUN, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([...r.json.result.written].sort(), [p.shim, p.wrapper].sort());
  assert.ok(readFileSync(p.wrapper, "utf8").includes(node));
  assert.equal(stateOf(s).node, node);
  assert.equal(readFileSync(join(p.stateDir, "node"), "utf8"), `${node}\n`);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
});

// The launcher finds the steward through the state: a full setup applied for
// this computer's list, with an OATS CLI that no longer keeps one, gives it
// no deployment to look in, whatever --dir names now.
test("--only agent-key does not move the key over a full setup applied for the list once the OATS CLI keeps none: a full --apply comes first", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.65.0", features: ["deployments-list"] }));
  writeFileSync(join(s.root, "deployments.json"), JSON.stringify({ deploymentsApi: 1, file: join(s.home, ".oats/config/deployments.json"), deployments: [{ path: s.deployment, name: "deployment", state: "ok" }], imports: {} }));
  assert.equal(s.run(["setup", "--apply", "--agent-key", "omarchy"]).status, 0);
  assert.equal(stateOf(s).deployment, null);
  const before = readFileSync(file, "utf8");
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.60.0", features: [] }));
  const blocked = "setup is applied for this computer's list of deployments, which this OATS CLI no longer keeps, so the launcher would find no steward: run a full setup --apply --dir <deployment> first, which switches it, then setup --apply --only agent-key";
  const r = s.run([...ONLY_RUN, "--dir", s.deployment, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(part(r, "agent-key"), { part: "agent-key", status: "skipped", reason: `the agent key stays with Omarchy: ${blocked}`, paths: [] });
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(stateOf(s).deployment, null, "the full setup's deployment as recorded");
  assert.equal(stateOf(s).agentKey, "oats", "the choice is recorded");
  // The full --apply switches it, and moves the key on the recorded choice.
  const full = s.run(["setup", "--apply", "--dir", s.deployment, "--json"]);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.equal(part(full, "agent-key").status, "applied");
  assert.equal(stateOf(s).deployment, s.deployment);
  assert.ok(agentLines(file));
});

test("--only agent-key over its own work alone records the deployment its launcher reads, even when no file changes", (t) => {
  const s = sandbox(t);
  const file = hypr(s);
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.65.0", features: ["deployments-list"] }));
  writeFileSync(join(s.root, "deployments.json"), JSON.stringify({ deploymentsApi: 1, file: join(s.home, ".oats/config/deployments.json"), deployments: [{ path: s.deployment, name: "deployment", state: "ok" }], imports: {} }));
  assert.equal(part(s.run([...ONLY_RUN, "--json"]), "agent-key").status, "applied");
  assert.equal(stateOf(s).deployment, null);
  const moved = readFileSync(file, "utf8");
  // The same CLI without the list: the key already moved, every file current.
  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.65.0", features: [] }));
  const r = s.run([...ONLY_RUN, "--dir", s.deployment, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.result.parts.map((x) => x.status), ["already applied", "already applied", "already applied"]);
  assert.deepEqual(r.json.result.written, []);
  assert.equal(readFileSync(file, "utf8"), moved);
  assert.equal(stateOf(s).deployment, s.deployment, "the state alone is rewritten");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  // Nothing changes on a second run.
  const after = snapshot(s.home);
  assert.deepEqual(s.run([...ONLY_RUN, "--dir", s.deployment, "--json"]).json.result.written, []);
  assert.deepEqual(snapshot(s.home), after);
});

test("--only agent-key giving the key back over its own work alone keeps the node the untouched shim and launcher run, so --check says it is gone", (t) => {
  const s = sandbox(t, { node: true });
  hypr(s);
  const p = discoverPaths(s.env);
  assert.equal(s.run(ONLY_RUN).status, 0);
  const old = stateOf(s).node;
  unlinkSync(old);
  symlinkSync(process.execPath, join(s.fakebin, "node"));
  const shim = readFileSync(p.shim, "utf8");
  const launcher = readFileSync(p.wrapper, "utf8");
  const r = s.run([...ONLY_RUN, "--agent-key", "omarchy", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(part(r, "agent-key").status, "removed");
  assert.deepEqual([readFileSync(p.shim, "utf8"), readFileSync(p.wrapper, "utf8")], [shim, launcher]);
  assert.equal(stateOf(s).node, old);
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`the node setup recorded, ${old}, is gone: run setup --apply again`));
});
