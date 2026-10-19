// Setup against a real Omarchy: its launchers, its hook runner, its
// keybindings --print and Hyprland's own --verify-config. Runs in CI's
// Arch + Omarchy container (OATS_OMARCHY_CONTAINER=1), as an unprivileged
// user, every case with a temporary HOME and XDG directories.
//
// Setup runs as a person runs it, through the plugin's `./setup` launcher
// with the container's node on PATH. `oats` on PATH is the sandbox's
// stand-in for the CLI (test/helpers/sandbox.mjs).
// Without a running Hyprland, `omarchy menu keybindings --print` answers with
// its static bindings only, so the "keys taken" cases serve the captured
// --print through a PATH fake of `omarchy`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { parseDesktopExec } from "../lib/quote.mjs";
import { readDesktopEntry } from "../lib/desktop-entry.mjs";
import { fixture, repo, sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";
import * as widget from "../widget.mjs";

const enabled = process.env.OATS_OMARCHY_CONTAINER === "1";
const OMARCHY = process.env.OMARCHY_PATH || "/usr/share/omarchy";
const verify = join(repo, "ci", "verify-hypr-config.sh");
const skip = enabled ? false : "set OATS_OMARCHY_CONTAINER=1 (CI's Omarchy container)";

// A sandbox whose PATH has the real Omarchy commands, and the real Hyprland,
// after the fakes. Only systemctl stays real too: in the container it has no
// user bus, which is the "no session" path.
function omarchySandbox(t, options = {}) {
  const s = sandbox(t, { launchers: false, print: "fail", fuse: true, ...options, hyprland: false });
  for (const fake of ["systemctl", "ldconfig", "omarchy"]) spawnSync("rm", ["-f", join(s.fakebin, fake)]);
  if (options.print && options.print !== "fail") {
    writeExecutable(join(s.fakebin, "omarchy"), `#!/bin/sh\n[ "$1 $2 $3" = "menu keybindings --print" ] && cat "${join(s.root, "print.txt")}" && exit 0\nexec ${OMARCHY}/bin/omarchy "$@"\n`);
  }
  s.env.PATH = `${s.fakebin}:${OMARCHY}/bin:/usr/bin:/bin`;
  s.env.OMARCHY_PATH = OMARCHY;
  const run = s.run;
  s.run = ([command, ...args], extra = {}) => {
    if (command !== "setup") return run([command, ...args], extra);
    const yes = (args.includes("--apply") || args.includes("--remove")) && !args.includes("--yes") ? ["--yes"] : [];
    const r = spawnSync("/bin/sh", [join(repo, "setup"), ...args, ...yes], { env: { ...s.env, ...extra }, cwd: s.deployment, encoding: "utf8", timeout: 60_000 });
    let json = null;
    if (args.includes("--json")) { try { json = JSON.parse(r.stdout); } catch { /* left null; the test says so */ } }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  return s;
}

// The user's Hyprland config as Omarchy installs it: its config/hypr files.
function userHypr(s, { layout }) {
  const dir = join(s.home, ".config", "hypr");
  mkdirSync(dir, { recursive: true });
  cpSync(join(OMARCHY, "config", "hypr"), dir, { recursive: true });
  if (layout === "conf") {
    spawnSync("rm", ["-f", join(dir, "bindings.lua")]);
    writeFileSync(join(dir, "bindings.conf"), "# the older layout\n");
  }
  return dir;
}

// Writes the printed snippet where the plan says, then checks the user's
// whole config with Hyprland --verify-config.
function verifySnippet(s, keys) {
  assert.ok(keys.snippet, "a snippet was printed");
  if (keys.format === "lua") {
    writeFileSync(keys.file, `${readFileSync(keys.file, "utf8")}\n${keys.snippet}`);
    return spawnSync("bash", [verify, "--expect", "ok", join(s.home, ".config", "hypr", "hyprland.lua"), s.home], { encoding: "utf8" });
  }
  const conf = join(s.root, "snippet.conf");
  writeFileSync(conf, keys.snippet);
  return spawnSync("bash", [verify, "--expect", "ok", conf, s.home], { encoding: "utf8" });
}

const plan = (s, extra = []) => {
  const r = s.run(["setup", "--plan", "--json", ...extra]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.json.result;
};

test("Omarchy is installed", { skip }, () => {
  const r = spawnSync("pacman", ["-Q", "omarchy", "hyprland"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  process.stdout.write(`# ${r.stdout.trim().replace(/\n/g, ", ")}\n`);
});

test("Lua layout, no Desktop: plan, apply, the real post-update hook, check, remove", { skip }, (t) => {
  const s = omarchySandbox(t);
  userHypr(s, { layout: "lua" });
  const before = snapshot(s.home);
  const p = plan(s);
  assert.equal(p.found.launchPath.source, "minimal", "no user bus in the container");
  assert.deepEqual(p.parts.map((x) => [x.part, x.status]), [["shim", "will apply"], ["tui", "will apply"], ["desktop", "skipped"], ["hook", "will apply"], ["menu", "will apply"], ["keys", "skipped"]]);
  assert.equal(p.found.menu.defaults, join(OMARCHY, "default", "omarchy", "omarchy-menu.jsonc"));
  assert.equal(p.keys.status, "unchecked", "--print without Hyprland");
  assert.match(p.keys.notes[0], /no running Hyprland answered/);
  assert.equal(p.found.libfuse2.ok, false, "fuse2 is not in Omarchy's packages");

  const apply = s.run(["setup", "--apply", "--json"]);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  const hook = spawnSync("omarchy-hook", ["post-update"], { env: s.env, cwd: s.home, encoding: "utf8" });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "", "Omarchy's hook runner ran our hook, which found no drift");
  assert.equal(s.run(["setup", "--check"]).stdout, "");

  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  // The snippet went into the user's bindings.lua for the check; take it out again.
  cpSync(join(OMARCHY, "config", "hypr", "bindings.lua"), p.keys.file);

  const removed = s.run(["setup", "--remove"]);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.deepEqual(snapshot(s.home), before);
});

// Setup writes the key block into the user's bindings.lua, checked by the
// real Hyprland on a copy first. The effective bindings are Omarchy's
// defaults (the captured --print), so SUPER + O is the stock pop-out.
test("the key block: apply verifies and writes it, a second apply changes nothing, remove restores byte for byte", { skip }, (t) => {
  const s = omarchySandbox(t, { print: "fixture" });
  userHypr(s, { layout: "lua" });
  const file = join(s.home, ".config", "hypr", "bindings.lua");
  const before = snapshot(s.home);
  const apply = s.run(["setup", "--apply", "--json"]);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  const keys = apply.json.result.parts.find((x) => x.part === "keys");
  assert.equal(keys.status, "applied", keys.reason);
  assert.equal(existsSync(join(s.root, "hyprland.log")), false, "the real Hyprland verified it, not the sandbox's fake");
  assert.match(readFileSync(file, "utf8"), /-- >>> oats-omarchy \(managed by setup; remove with setup --remove\) >>>\n[^]*-- <<< oats-omarchy <<<\n$/);
  // The live config, block included, as Hyprland reads it.
  const v = spawnSync("bash", [verify, "--expect", "ok", join(s.home, ".config", "hypr", "hyprland.lua"), s.home], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stdout + v.stderr);

  const written = readFileSync(file);
  const again = s.run(["setup", "--apply", "--json"]);
  assert.equal(again.json.result.parts.find((x) => x.part === "keys").status, "already applied");
  assert.ok(readFileSync(file).equals(written));
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("the key block: SUPER + O bound in the user's bindings.lua is refused, nothing written", { skip }, (t) => {
  const s = omarchySandbox(t, { print: "fixture" });
  userHypr(s, { layout: "lua" });
  const file = join(s.home, ".config", "hypr", "bindings.lua");
  writeFileSync(file, `${readFileSync(file, "utf8")}o.bind("SUPER + O", "Mine", "true")\n`);
  const mine = readFileSync(file);
  const p = plan(s);
  const keys = p.parts.find((x) => x.part === "keys");
  assert.equal(keys.status, "skipped");
  assert.match(keys.reason, /your bindings\.lua binds SUPER \+ O itself/);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.ok(readFileSync(file).equals(mine));
});

test("the key block: a block Hyprland refuses is not written, and Hyprland's lines are reported", { skip }, (t) => {
  const s = omarchySandbox(t, { print: "fixture" });
  userHypr(s, { layout: "lua" });
  const file = join(s.home, ".config", "hypr", "bindings.lua");
  // Valid on its own (Omarchy's own SUPER + O is bound before this file
  // runs); the block's o.bind("SUPER + O", ...) then fails.
  writeFileSync(file, `${readFileSync(file, "utf8")}local bind = o.bind\no.bind = function(keys, ...)\n  if keys == "SUPER + O" then error("SUPER + O is not for setup here") end\n  return bind(keys, ...)\nend\n`);
  const mine = readFileSync(file);
  const p = plan(s);
  const keys = p.parts.find((x) => x.part === "keys");
  assert.equal(keys.status, "skipped");
  assert.match(keys.reason, /^Hyprland --verify-config refuses your config with the key block added, so setup writes nothing:\n/);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.ok(readFileSync(file).equals(mine));
});

test("the .conf layout: the hyprlang snippet passes --verify-config", { skip }, (t) => {
  const s = omarchySandbox(t);
  userHypr(s, { layout: "conf" });
  const p = plan(s);
  assert.equal(p.found.bindings.format, "conf");
  assert.equal(p.keys.format, "conf");
  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("an AppImage without libfuse2: the entry extracts and runs, the plan names fuse2, and apply/remove is exact", { skip }, (t) => {
  const s = omarchySandbox(t);
  userHypr(s, { layout: "lua" });
  mkdirSync(join(s.home, "Applications"));
  writeExecutable(join(s.home, "Applications", "OATS-Desktop.AppImage"), "#!/bin/sh\nexit 0\n");
  const before = snapshot(s.home);
  const p = plan(s);
  assert.ok(p.fixes.some((f) => f.fix === "sudo pacman -S fuse2"));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const entry = readDesktopEntry(readFileSync(join(s.home, ".local/share/applications/awebai-oats-desktop.desktop"), "utf8"));
  assert.deepEqual(parseDesktopExec(entry.Exec).slice(1), ["--appimage-extract-and-run", "--dir", s.deployment]);
  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  cpSync(join(OMARCHY, "config", "hypr", "bindings.lua"), p.keys.file);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

const rebound = (action) => readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8")
  .split("\n").map((l) => (l.startsWith("SUPER + O ") ? `${"SUPER + O".padEnd(35)} → ${action}` : l)).join("\n");

for (const [name, print, expect] of [
  ["Omarchy's defaults", readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8"), "default"],
  ["SUPER + O rebound to a command", rebound("omarchy-launch-browser"), "command"],
  ["SUPER + O rebound with a description (commented double tap)", rebound("Scratch notes"), "description"],
]) {
  test(`keys taken, ${name}: the snippet passes --verify-config`, { skip }, (t) => {
    const s = omarchySandbox(t, { print });
    userHypr(s, { layout: "lua" });
    const p = plan(s);
    assert.equal(p.keys.status, "suggested");
    assert.equal(p.keys.pop.kind, expect);
    const v = verifySnippet(s, p.keys);
    assert.equal(v.status, 0, v.stdout + v.stderr);
  });
}

test("keys taken, a user submap named oats: the next free key, and it passes --verify-config", { skip }, (t) => {
  const s = omarchySandbox(t, { print: readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8") });
  const dir = userHypr(s, { layout: "lua" });
  writeFileSync(join(dir, "bindings.lua"), `${readFileSync(join(dir, "bindings.lua"), "utf8")}\nhl.define_submap("oats", "reset", function()\n  hl.bind("escape", hl.dsp.submap("reset"))\nend)\n`);
  const p = plan(s);
  assert.notEqual(p.keys.entry, "SUPER + O");
  assert.equal(p.keys.submap, "oats-omarchy");
  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

// The picker's commands as Omarchy's Util.execArgv runs them: bash -lc 'exec "$@"'.
const execArgv = (s, argv, extra = {}) => spawnSync("bash", ["-lc", 'exec "$@"', "bash", ...argv], { env: { ...s.env, ...extra }, cwd: s.root, encoding: "utf8", timeout: 30_000 });

test("the picker's agent row opens its session through the real floating terminal, as argv", { skip }, (t) => {
  const s = omarchySandbox(t, { deploymentName: "my agents" });
  const home = join(s.deployment, "agents", "x", "instances", "it's $(here)");
  mkdirSync(home, { recursive: true });
  writeExecutable(join(s.fakebin, "uwsm-app"), '#!/bin/bash\n[[ $1 == -- ]] && shift\nif [[ $1 == xdg-terminal-exec ]]; then while [[ $1 != -e ]]; do shift; done; shift; fi\nexec "$@"\n');
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const plugin = widget.parsePlugin(readFileSync(join(s.home, ".local/state/oats-omarchy/plugin.json"), "utf8"));
  assert.ok(plugin && plugin.agents && plugin.spawn, "setup wrote the picker's commands");
  const r = execArgv(s, widget.attachArgv(plugin, home));
  assert.equal(r.status, 0, r.stderr);
  const log = join(s.root, "kernel.log");
  waitFor(log, 1);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), ["session", "attach", "--detach-key", "M-o", "--home", home]);
});

test("the picker's soul row: the task as typed reaches the kernel through the real floating terminal, and the new instance's session opens", { skip }, (t) => {
  const s = omarchySandbox(t, { deploymentName: "my agents" });
  writeExecutable(join(s.fakebin, "uwsm-app"), '#!/bin/bash\n[[ $1 == -- ]] && shift\nif [[ $1 == xdg-terminal-exec ]]; then while [[ $1 != -e ]]; do shift; done; shift; fi\nexec "$@"\n');
  // Omarchy's input needs its running shell: a stand-in that answers.
  writeExecutable(join(s.fakebin, "omarchy-menu-input"), '#!/bin/sh\nprintf \'%s\' "$FAKE_INPUT"\n');
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const plugin = widget.parsePlugin(readFileSync(join(s.home, ".local/state/oats-omarchy/plugin.json"), "utf8"));
  const task = `'; touch "${join(s.root, "pwned")}" #\n$(touch pwned)`;
  const r = execArgv(s, widget.spawnArgv(plugin, s.deployment, "writer"), { FAKE_INPUT: task });
  assert.equal(r.status, 0, r.stderr);
  const kernel = join(s.root, "kernel.log");
  waitFor(kernel, 1);
  const spawned = JSON.parse(readFileSync(join(s.root, "spawn.log"), "utf8").trim());
  assert.deepEqual(spawned.argv.filter((a, i) => i !== 5), ["spawn", "writer", "--dir", s.deployment, "--task-file", "--json"]);
  assert.deepEqual([spawned.task, spawned.mode, spawned.cwd], [task, 0o600, s.deployment]);
  assert.deepEqual(JSON.parse(readFileSync(kernel, "utf8").trim()), ["session", "attach", "--detach-key", "M-o", "--home", join(s.deployment, "agents", "writer", "instances", "writer-1")]);
  assert.equal(existsSync(join(s.root, "pwned")), false);
  assert.equal(existsSync(join(spawned.argv[5], "..")), false, "the task's directory is gone");
});

test("the key block's Space opens the picker, and the whole block verifies with the real Hyprland", { skip }, (t) => {
  const s = omarchySandbox(t, { print: readFileSync(fixture("print", "omarchy-4.0.4.txt"), "utf8") });
  userHypr(s, { layout: "lua" });
  const p = plan(s);
  assert.match(p.keys.snippet, /o\.bind\("SPACE", "Open OATS", "omarchy-shell shell toggle ai\.aweb\.oats '\{\}'"\)/);
  const v = verifySnippet(s, p.keys);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("the real launchers run what setup wrote, with a deployment path that has a space", { skip }, (t) => {
  const s = omarchySandbox(t, { deploymentName: "my agents & co" });
  mkdirSync(join(s.home, "Applications"));
  const image = join(s.home, "Applications", "OATS Desktop.AppImage");
  const argvLog = join(s.root, "argv.log");
  writeExecutable(image, `#!/bin/sh\nfor a; do echo "desktop:$a"; done >> "${argvLog}"\n`);
  // uwsm-app is where Omarchy's chain leaves the launchers; hyprctl answers
  // that no window matches, as on a desktop with neither app open.
  writeExecutable(join(s.fakebin, "uwsm-app"), `#!/bin/sh\n[ "$1" = "--" ] && shift\nif [ "$1" = xdg-terminal-exec ]; then for a; do echo "terminal:$a"; done >> "${argvLog}"; exit 0; fi\nexec "$@"\n`);
  writeExecutable(join(s.fakebin, "hyprctl"), "#!/bin/sh\necho '[]'\n");
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const p = plan(s);
  const shim = join(s.home, ".local/share/oats-omarchy/oats");
  const terminal = ["terminal:xdg-terminal-exec", "terminal:--app-id=org.oats.tui", "terminal:-e", `terminal:${shim}`, "terminal:tui", "terminal:--dir", `terminal:${s.deployment}`];

  // The TUI's desktop entry, launched by GLib as the app launcher does.
  const entry = join(s.home, ".local/share/applications/org.oats.tui.desktop");
  const gio = spawnSync("gio", ["launch", entry], { env: s.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(gio.status, 0, gio.stderr);
  waitFor(argvLog, terminal.length);
  assert.deepEqual(readFileSync(argvLog, "utf8").trim().split("\n"), terminal);

  // The key's command line, as Hyprland runs it (sh -c).
  writeFileSync(argvLog, "");
  const tuiCommand = p.keys.snippet.match(/o\.bind\("T", "OATS TUI", "(.*)"\)/)[1].replace(/\\(.)/g, "$1");
  assert.equal(spawnSync("sh", ["-c", tuiCommand], { env: s.env, encoding: "utf8" }).status, 0);
  waitFor(argvLog, terminal.length);
  assert.deepEqual(readFileSync(argvLog, "utf8").trim().split("\n"), terminal);

  writeFileSync(argvLog, "");
  const desktopCommand = p.keys.snippet.match(/o\.bind\("D", "OATS Desktop", "(.*)"\)/)[1].replace(/\\(.)/g, "$1");
  assert.equal(spawnSync("sh", ["-c", desktopCommand], { env: s.env, encoding: "utf8" }).status, 0);
  const extract = p.found.libfuse2.ok ? [] : ["desktop:--appimage-extract-and-run"];
  waitFor(argvLog, extract.length + 2);
  assert.deepEqual(readFileSync(argvLog, "utf8").trim().split("\n"), [...extract, "desktop:--dir", `desktop:${s.deployment}`]);
});

// The launchers detach (setsid); give the end of the chain a moment.
function waitFor(file, lines) {
  for (let i = 0; i < 50; i++) {
    if (existsSync(file) && readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length >= lines) return;
    spawnSync("sleep", ["0.1"]);
  }
}

// Omarchy's own menu parser, shell/plugins/menu/MenuModel.js. Menu.qml
// imports it as a JS library (`import "MenuModel.js" as MenuModel`); it is
// plain functions with no QML imports, so it runs as a script in a vm
// context. A `.pragma` or `.import` line, should one appear, is dropped first.
function menuModel() {
  const src = readFileSync(join(OMARCHY, "shell", "plugins", "menu", "MenuModel.js"), "utf8").replace(/^\s*\.(pragma|import)\b.*$/gm, "");
  const context = {};
  vm.runInNewContext(`${src}\nthis.parseMenuJsonc = parseMenuJsonc; this.mergeMenuSources = mergeMenuSources; this.matchesQuery = matchesQuery;`, context);
  // Plain objects of this realm, for deepEqual.
  const plain = (x) => JSON.parse(JSON.stringify(x));
  return { parse: (text) => plain(context.parseMenuJsonc(text)), merge: (a, b) => plain(context.mergeMenuSources(a, b)), matches: (entry, query) => context.matchesQuery(entry, query, true) };
}

for (const [name, text] of [
  ["no menu file", null],
  ["a user file with a trailing comma", '{\n  // mine\n  "mine": {"icon":"m","label":"Mine","action":"true"},\n  "system.lock": {"label":"Lock it"},\n}\n'],
  ["a user file without one", '{\n  "mine": {"icon":"m","label":"Mine","action":"true"}\n}'],
  ["a user file with an items wrapper", '{\n  "items": {\n    "mine": {"label":"Mine","action":"true"}\n  }\n}\n'],
]) {
  test(`Omarchy's MenuModel reads the oats block, the user's items unchanged: ${name}`, { skip }, (t) => {
    const s = omarchySandbox(t);
    const file = join(s.home, ".config", "omarchy", "extensions", "omarchy-menu.jsonc");
    if (text !== null) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); }
    const before = snapshot(s.home);
    const model = menuModel();
    const defaults = model.parse(readFileSync(join(OMARCHY, "default", "omarchy", "omarchy-menu.jsonc"), "utf8"));
    const userBefore = text === null ? [] : model.parse(text);
    assert.equal(s.run(["setup", "--apply"]).status, 0);

    const user = model.parse(readFileSync(file, "utf8"));
    const byId = Object.fromEntries(user.map((item) => [item.id, item]));
    for (const item of userBefore) assert.deepEqual(byId[item.id], item, `${item.id} reads the same`);
    const merged = model.merge(defaults, user);
    const ids = ["oats", "oats.open", "oats.waiting", "oats.agents", "oats.souls", "oats.tui", "oats.status"];
    const oats = ids.map((id) => merged.items[id]);
    assert.deepEqual(oats.map((x) => [x.id, x.parent, x.kind]), [["oats", "root", "menu"], ...ids.slice(1).map((id) => [id, "oats", "action"])]);
    assert.deepEqual(oats.map((x) => x.label), ["OATS", "Open OATS", "Waiting on you", "Agents", "Souls", "Open OATS TUI", "Status"]);
    // Omarchy's own search finds them by these words.
    for (const word of ["oats", "agents", "instances", "souls", "waiting"]) {
      assert.ok(oats.some((x) => model.matches(x, word)), `"${word}" finds an oats row`);
    }
    assert.ok(model.matches(merged.items["oats.agents"], "instances"));
    assert.ok(model.matches(merged.items["oats.waiting"], "waiting"));
    assert.equal(merged.items["oats.desktop"], undefined, "no Desktop here");
    for (const item of defaults) if (!byId[item.id]) assert.ok(merged.items[item.id], `Omarchy's ${item.id} is still there`);

    assert.equal(s.run(["setup", "--remove"]).status, 0);
    assert.deepEqual(snapshot(s.home), before);
  });
}

test("waiting opens the chosen session through Omarchy's real floating terminal: the detach key arrives as argv", { skip }, (t) => {
  const s = omarchySandbox(t, { launchers: ["omarchy-menu-select"], deploymentName: "my agents" });
  const home = join(s.deployment, "agents", "x", "instances", "with space");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(s.root, "status.json"), JSON.stringify({ agents: [{ instances: [{ instance: "with space", home, waitingOnYou: { reason: "attention" } }] }] }));
  // The end of Omarchy's chain: uwsm-app runs the terminal's -e command.
  writeExecutable(join(s.fakebin, "uwsm-app"), '#!/bin/bash\n[[ $1 == -- ]] && shift\nif [[ $1 == xdg-terminal-exec ]]; then while [[ $1 != -e ]]; do shift; done; shift; fi\nexec "$@"\n');
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const r = s.run(["waiting", "--dir", s.deployment], { FAKE_SELECT: "first" });
  assert.equal(r.status, 0, r.stderr);
  const log = join(s.root, "kernel.log");
  waitFor(log, 1);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), ["session", "attach", "--detach-key", "M-o", "--home", home]);
});

test("the bar panel's row opens the same session through the real floating terminal, from the plugin.json setup wrote", { skip }, (t) => {
  const s = omarchySandbox(t, { deploymentName: "my agents" });
  const home = join(s.deployment, "agents", "x", "instances", "it's here");
  mkdirSync(home, { recursive: true });
  writeExecutable(join(s.fakebin, "uwsm-app"), '#!/bin/bash\n[[ $1 == -- ]] && shift\nif [[ $1 == xdg-terminal-exec ]]; then while [[ $1 != -e ]]; do shift; done; shift; fi\nexec "$@"\n');
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const plugin = widget.parsePlugin(readFileSync(join(s.home, ".local/state/oats-omarchy/plugin.json"), "utf8"));
  assert.ok(plugin, "setup wrote what the widget reads");
  // The bar's run: bash -lc <line>.
  const r = spawnSync("bash", ["-lc", widget.attachCommand(plugin, home)], { env: s.env, cwd: s.root, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const log = join(s.root, "kernel.log");
  waitFor(log, 1);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8").trim()), ["session", "attach", "--detach-key", "M-o", "--home", home]);
});
