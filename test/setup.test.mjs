// The plugin's setup end to end against a temporary HOME, XDG directories
// and PATH fakes: plan, apply, remove and check, and what each refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDesktopExec } from "../lib/quote.mjs";
import { readDesktopEntry } from "../lib/desktop-entry.mjs";
import { repo, sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

const paths = (s) => ({
  shim: join(s.home, ".local/share/oats-omarchy/oats"),
  tuiEntry: join(s.home, ".local/share/applications/org.oats.tui.desktop"),
  tuiIcon: join(s.home, ".local/share/icons/hicolor/256x256/apps/org.oats.tui.png"),
  desktopEntry: join(s.home, ".local/share/applications/awebai-oats-desktop.desktop"),
  desktopIcon: join(s.home, ".local/share/icons/hicolor/256x256/apps/awebai-oats-desktop.png"),
  hook: join(s.home, ".config/omarchy/hooks/post-update.d/oats-omarchy.hook"),
  launcher: join(s.home, ".local/bin/omarchy-launch-oats"),
  state: join(s.home, ".local/state/oats-omarchy/state.json"),
  menu: join(s.home, ".config/omarchy/extensions/omarchy-menu.jsonc"),
});

function appImage(s, name = "OATS-Desktop.AppImage", dir = join(s.home, "Applications")) {
  mkdirSync(dir, { recursive: true });
  writeExecutable(join(dir, name), `#!/bin/sh\necho "desktop $*" >> "${join(s.root, "launched.log")}"\n`);
  return join(dir, name);
}

const part = (result, name) => result.parts.find((x) => x.part === name);

test("--plan writes nothing, not even Omarchy's keybindings cache", (t) => {
  const s = sandbox(t);
  appImage(s);
  const before = snapshot(s.home);
  const r = s.run(["setup", "--plan", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.schemaVersion, 1);
  assert.deepEqual(snapshot(s.home), before);
  const cache = readFileSync(join(s.root, "print-cache.log"), "utf8").trim();
  assert.ok(cache && !cache.startsWith(s.home) && !existsSync(cache), "--print ran with a temporary cache that is gone");
  assert.deepEqual(r.json.result.parts.map((x) => [x.part, x.status]), [["shim", "will apply"], ["tui", "will apply"], ["desktop", "will apply"], ["hook", "will apply"], ["launcher", "will apply"], ["menu", "will apply"], ["keys", "skipped"], ["agent-key", "skipped"]]);
  assert.equal(r.json.result.found.deployment.path, s.deployment);
  assert.deepEqual(r.json.result.found.deployment, { path: s.deployment, from: "the working directory" });
  assert.deepEqual(r.json.result.found.plugin, { dir: repo, inPlugins: false });
  assert.equal(r.json.result.found.node.path, process.execPath);
  assert.equal(r.json.result.found.kernel.cli, s.cli);
  assert.equal(r.json.result.found.launchPath.source, "minimal");
  assert.equal(r.json.result.keys.entry, "SUPER + O");
});

test("plan is the default mode, and the text says what it found and where", (t) => {
  const s = sandbox(t);
  const r = s.run(["setup"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^setup --plan \(nothing was written\)$/m);
  assert.match(r.stdout, /deployment {2}.* \(from the working directory\)/);
  assert.match(r.stdout, /Setup runs from .*, not from ~\/\.config\/omarchy\/plugins\/: the menu and the hook it writes point at this clone/);
  assert.match(r.stdout, /desktop   skipped: no OATS Desktop found/);
  assert.match(r.stdout, /Get OATS Desktop from https:\/\/github\.com\/awebai\/oats\/releases/);
  assert.match(r.stdout, /Paste this at the end of .*\/\.config\/hypr\/bindings\.lua/);
});

test("--apply writes exactly the parts, and a second --apply writes nothing", (t) => {
  const s = sandbox(t);
  appImage(s);
  const p = paths(s);
  const r = s.run(["setup", "--apply", "--ui", "tui", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.result.written.sort(), [p.shim, p.tuiEntry, p.tuiIcon, p.desktopEntry, p.desktopIcon, p.hook, p.launcher, p.menu].sort());
  assert.deepEqual(r.json.result.parts.map((x) => x.status), ["applied", "applied", "applied", "applied", "applied", "applied", "skipped", "skipped"]);

  assert.equal(readFileSync(p.shim, "utf8"), `#!/bin/sh\nexec '${process.execPath}' '${s.cli}' "$@"\n`);
  assert.equal(statSync(p.shim).mode & 0o777, 0o755);
  const tui = readDesktopEntry(readFileSync(p.tuiEntry, "utf8"));
  assert.equal(tui.Name, "OATS TUI");
  assert.equal(tui.Icon, "org.oats.tui");
  assert.equal(tui.Terminal, "false");
  assert.deepEqual(parseDesktopExec(tui.Exec), ["omarchy-launch-or-focus-tui", "--app-id=org.oats.tui", p.shim, "tui", "--dir", s.deployment]);
  const desktop = readDesktopEntry(readFileSync(p.desktopEntry, "utf8"));
  assert.equal(desktop.StartupWMClass, "awebai-oats-desktop");
  assert.equal(desktop.Icon, "awebai-oats-desktop");
  assert.deepEqual(parseDesktopExec(desktop.Exec), [join(s.home, "Applications/OATS-Desktop.AppImage"), "--dir", s.deployment]);
  assert.equal(statSync(p.hook).mode & 0o777, 0o755);
  assert.equal(readFileSync(p.launcher, "utf8"), `#!/bin/sh\nexec '${process.execPath}' '${repo}/bin/launch.mjs' "$@"\n`);
  assert.equal(statSync(p.launcher).mode & 0o777, 0o755);
  const state = JSON.parse(readFileSync(p.state, "utf8"));
  assert.equal(state.deployment, s.deployment);
  assert.deepEqual([state.node, state.cli, state.pluginDir], [process.execPath, s.cli, repo]);
  assert.equal(readFileSync(join(s.home, ".local/state/oats-omarchy/node"), "utf8"), `${process.execPath}\n`, "for the launcher");
  assert.equal(state.desktop.source, "appimage");
  assert.ok(state.files.filter((f) => f.kind !== "block").every((f) => f.prior.state === "absent" && f.digest.startsWith("sha256:")));
  const block = state.files.find((f) => f.kind === "block");
  assert.deepEqual({ path: block.path, created: block.created, comma: block.comma, prior: block.prior }, { path: p.menu, created: true, comma: false, prior: { state: "absent" } });

  const after = snapshot(s.home);
  const again = s.run(["setup", "--apply", "--json"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json.result.written, []);
  assert.deepEqual(again.json.result.parts.map((x) => x.status), ["already applied", "already applied", "already applied", "already applied", "already applied", "already applied", "skipped", "skipped"]);
  assert.deepEqual(snapshot(s.home), after, "the second --apply changed nothing");
  assert.match(s.run(["setup", "--apply"]).stdout, /already applied, nothing written/);
});

test("--apply then --remove restores the whole tree byte for byte, with no user files", (t) => {
  const s = sandbox(t);
  appImage(s);
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply", "--ui", "tui"]).status, 0);
  assert.notDeepEqual(snapshot(s.home), before);
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.result.restored.length, 8);
  assert.deepEqual(snapshot(s.home), before);
  const again = s.run(["setup", "--remove"]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /nothing to remove/);
});

test("--apply then --remove restores the whole tree byte for byte, with the user's own files at our paths", (t) => {
  const s = sandbox(t);
  appImage(s);
  const p = paths(s);
  mkdirSync(join(s.home, ".local/share/applications"), { recursive: true });
  writeFileSync(p.tuiEntry, "[Desktop Entry]\nName=My own OATS entry\nExec=true\n");
  chmodSync(p.tuiEntry, 0o750);
  mkdirSync(join(s.home, ".config/omarchy/hooks/post-update.d"), { recursive: true });
  writeFileSync(join(s.home, ".config/omarchy/hooks/post-update.d/mine.hook"), "echo mine\n");
  writeFileSync(p.hook, "echo an older hook of the same name\n");
  mkdirSync(join(s.home, "dotfiles"), { recursive: true });
  writeFileSync(join(s.home, "dotfiles/icon.png"), "not really a png");
  mkdirSync(join(s.home, ".local/share/icons/hicolor/256x256/apps"), { recursive: true });
  symlinkSync(join(s.home, "dotfiles/icon.png"), p.tuiIcon);
  mkdirSync(join(s.home, ".local/state"), { recursive: true });
  const before = snapshot(s.home);

  const r = s.run(["setup", "--apply", "--ui", "tui", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const state = JSON.parse(readFileSync(p.state, "utf8"));
  const prior = state.files.find((f) => f.role === "tui-entry").prior;
  assert.match(prior.backup, /^backup\/tui-entry-[0-9a-f]{12}$/);
  assert.deepEqual(prior, { state: "file", backup: prior.backup, mode: 0o750, digest: prior.digest });
  assert.equal(readFileSync(join(s.home, ".local/state/oats-omarchy", prior.backup), "utf8"), "[Desktop Entry]\nName=My own OATS entry\nExec=true\n");
  assert.equal(state.files.find((f) => f.role === "tui-icon").prior.state, "link");
  assert.equal(readFileSync(join(s.home, "dotfiles/icon.png"), "utf8"), "not really a png", "a link's target is never written through");

  const removed = s.run(["setup", "--remove"]);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.deepEqual(snapshot(s.home), before);
});

test("--remove regenerates only the caches the user already had, and the byte check excludes only those", (t) => {
  const s = sandbox(t);
  const apps = join(s.home, ".local/share/applications");
  const icons = join(s.home, ".local/share/icons/hicolor");
  mkdirSync(apps, { recursive: true });
  mkdirSync(icons, { recursive: true });
  writeFileSync(join(apps, "mimeinfo.cache"), "[MIME Cache]\n");
  writeFileSync(join(icons, "icon-theme.cache"), "cache");
  writeFileSync(join(icons, "index.theme"), "[Icon Theme]\nName=Hicolor\n");
  for (const tool of ["update-desktop-database", "gtk-update-icon-cache"]) {
    writeExecutable(join(s.fakebin, tool), `#!/bin/sh\necho "${tool} $*" >> "${join(s.root, "caches.log")}"\nfor d; do :; done\necho regenerated >> "$d/${tool === "update-desktop-database" ? "mimeinfo.cache" : "icon-theme.cache"}"\n`);
  }
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  const log = readFileSync(join(s.root, "caches.log"), "utf8").trim().split("\n");
  assert.deepEqual(log, [`update-desktop-database ${apps}`, `gtk-update-icon-cache -q -t ${icons}`, `update-desktop-database ${apps}`, `gtk-update-icon-cache -q -t ${icons}`]);
  const exclude = [".local/share/applications/mimeinfo.cache", ".local/share/icons/hicolor/icon-theme.cache"];
  assert.deepEqual(snapshot(s.home, { exclude }), new Map([...before].filter(([k]) => !exclude.includes(k))),
    "everything but the two caches update-desktop-database and gtk-update-icon-cache regenerate is byte for byte");

  const t2 = sandbox(t);
  assert.equal(t2.run(["setup", "--apply"]).status, 0);
  assert.equal(existsSync(join(t2.root, "caches.log")), false, "with no cache file, neither tool runs");
});

test("a user edit between --apply and --remove is left in place, named, E_MODIFIED; the rest is restored", (t) => {
  const s = sandbox(t);
  const p = paths(s);
  const before = snapshot(s.home);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  writeFileSync(p.tuiEntry, readFileSync(p.tuiEntry, "utf8").replace("Name=OATS", "Name=My OATS"));
  const r = s.run(["setup", "--remove", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, "E_MODIFIED");
  assert.match(r.json.error.message, /org\.oats\.tui\.desktop/);
  assert.ok(existsSync(p.tuiEntry), "the edited file stays");
  assert.ok(!existsSync(p.hook) && !existsSync(p.tuiIcon), "the rest is restored");
  assert.ok(existsSync(p.shim), "the shim stays until everything else is restored");
  assert.ok(existsSync(p.state), "the state stays, for the next --remove");
  const text = s.run(["setup", "--remove"]);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /left in place because it was changed since setup wrote it: .*org\.oats\.tui\.desktop/);

  unlinkSync(p.tuiEntry);
  const done = s.run(["setup", "--remove"]);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(snapshot(s.home), before);
});

test("another deployment recorded in the state: --plan names it, --apply refuses with E_OTHER_DEPLOYMENT", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const other = join(s.root, "other deployment");
  mkdirSync(other);
  writeFileSync(join(other, "oats-local.yaml"), "");
  const plan = s.run(["setup", "--plan", "--json", "--dir", other]);
  assert.equal(plan.status, 0);
  assert.ok(plan.json.result.notes.some((n) => n.includes(`another deployment, ${s.deployment}`) && n.includes("--remove")));
  const before = snapshot(s.home);
  const apply = s.run(["setup", "--apply", "--json"], {}, { cwd: other });
  assert.equal(apply.status, 1);
  assert.equal(apply.json.error.code, "E_OTHER_DEPLOYMENT");
  assert.deepEqual(snapshot(s.home), before);
});

test("--remove takes the deployment as --plan does: another one, or a bad --dir, is refused and nothing is removed", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const other = join(s.root, "other");
  mkdirSync(other);
  writeFileSync(join(other, "oats-local.yaml"), "");
  const before = snapshot(s.home);
  for (const [extra, opts, code] of [[["--dir", other], {}, "E_OTHER_DEPLOYMENT"], [[], { cwd: other }, "E_OTHER_DEPLOYMENT"], [["--dir", join(s.root, "nope")], {}, "E_NO_DEPLOYMENT"]]) {
    const r = s.run(["setup", "--remove", "--json", ...extra], {}, opts);
    assert.equal(r.status, 1, JSON.stringify(extra));
    assert.equal(r.json.error.code, code);
    assert.deepEqual(snapshot(s.home), before, "nothing was removed");
  }
  assert.match(s.run(["setup", "--remove", "--json", "--dir", other]).json.error.message, new RegExp(`applied for the deployment ${s.deployment}, not ${other} \\(from --dir\\); nothing was removed`));
  // The recorded deployment gone: --remove from outside any deployment still cleans up.
  rmSync(s.deployment, { recursive: true });
  const r = s.run(["setup", "--remove"], {}, { cwd: s.root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(s.home, ".local/state/oats-omarchy/state.json")), false);
});

test("a deployment path with a space: the hook and the shim run it, through bash and the kernel", (t) => {
  const s = sandbox(t, { deploymentName: "my agents & co" });
  const p = paths(s);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const hook = spawnSync("bash", [p.hook], { env: s.env, cwd: s.home, encoding: "utf8" });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout, "", "nothing drifted, so the hook is silent");
  const tui = readDesktopEntry(readFileSync(p.tuiEntry, "utf8"));
  assert.match(tui.Exec, /--dir "'.*\/my agents & co'"$/);
  assert.equal(parseDesktopExec(tui.Exec).at(-1), `'${s.deployment}'`, "quoted for omarchy-launch-or-focus's eval");
});

test("--check after a file was deleted reports it; the hook prints it and exits 0", (t) => {
  const s = sandbox(t);
  const p = paths(s);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(s.run(["setup", "--check"]).stdout, "");
  unlinkSync(p.tuiIcon);
  writeFileSync(p.tuiEntry, "changed\n");
  const r = s.run(["setup", "--check", "--json"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.result.drift, [`${p.tuiEntry} changed since setup wrote it`, `${p.tuiIcon} is missing`]);
  const hook = spawnSync("bash", [p.hook], { env: s.env, cwd: s.home, encoding: "utf8" });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, `oats-omarchy: ${p.tuiEntry} changed since setup wrote it\noats-omarchy: ${p.tuiIcon} is missing\n`);
});

test("--check reports a feature gone, the CLI gone or too old, the node gone and another deployment", (t) => {
  const s = sandbox(t);
  const p = paths(s);
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  rmSync(join(s.fakebin, "omarchy-launch-or-focus-tui"));
  const other = join(s.root, "other");
  mkdirSync(other);
  writeFileSync(join(other, "oats-local.yaml"), "");
  const r = s.run(["setup", "--check", "--json", "--dir", other]);
  assert.equal(r.status, 0);
  assert.ok(r.json.result.drift.some((d) => /no longer offers omarchy-launch-or-focus-tui/.test(d)), r.stdout);
  assert.ok(r.json.result.drift.includes(`setup is applied for the deployment ${s.deployment}, not ${other}`));

  writeFileSync(join(s.root, "version.json"), JSON.stringify({ version: "0.52.0", features: [] }));
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes("the OATS CLI is 0.52.0; setup needs 0.53.0 or later (`oats tui --dir`): run setup --apply again"));
  rmSync(s.cli);
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`the OATS CLI setup recorded, ${s.cli}, is gone: run setup --apply again`));

  const state = JSON.parse(readFileSync(p.state, "utf8"));
  writeFileSync(p.state, JSON.stringify({ ...state, node: join(s.root, "gone", "node") }));
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`the node setup recorded, ${join(s.root, "gone", "node")}, is gone: run setup --apply again`));
});

test("the hook: silent when nothing drifted; one line when the node, the plugin or the deployment is gone; always exit 0", (t) => {
  const s = sandbox(t);
  const p = paths(s);
  // Applied from a copy of the plugin, which then goes away.
  const plugin = join(s.root, "plugins", "oats-omarchy");
  cpSync(repo, plugin, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules)$/.test(src) });
  const apply = spawnSync(process.execPath, [join(plugin, "bin", "setup.mjs"), "--apply", "--yes"], { env: s.env, cwd: s.deployment, encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  const hook = () => spawnSync("bash", [p.hook], { env: s.env, cwd: s.home, encoding: "utf8" });
  assert.deepEqual([hook().status, hook().stdout], [0, ""]);
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`setup is applied from the plugin directory ${plugin}, and this setup runs from ${repo}: run setup --apply again`), "moved");

  rmSync(plugin, { recursive: true });
  assert.deepEqual([hook().status, hook().stdout], [0, `oats-omarchy: the plugin at ${plugin} was removed; its launchers, menu and keys remain. Add the plugin again and run setup --remove to clean them up.\n`]);
  assert.ok(s.run(["setup", "--check", "--json"]).json.result.drift.includes(`the plugin directory setup recorded, ${plugin}, is gone: run setup --apply again`));

  // The node (also when the plugin is gone too), then the deployment.
  const gone = `oats-omarchy: the node setup recorded, ${join(s.root, "gone", "node")}, is gone: run setup --apply again from the plugin.\n`;
  writeFileSync(p.hook, readFileSync(p.hook, "utf8").replaceAll(process.execPath, join(s.root, "gone", "node")));
  assert.deepEqual([hook().status, hook().stdout], [0, gone], "node and plugin both gone: the node first");
  const text = readFileSync(p.hook, "utf8").replaceAll(plugin, repo).replaceAll(join(s.root, "gone", "node"), process.execPath);
  writeFileSync(p.hook, text.replaceAll(process.execPath, join(s.root, "gone", "node")));
  assert.deepEqual([hook().status, hook().stdout], [0, gone]);
  writeFileSync(p.hook, text);
  rmSync(s.deployment, { recursive: true });
  assert.deepEqual([hook().status, hook().stdout], [0, `oats-omarchy: the OATS deployment ${s.deployment} is gone, so its Omarchy setup cannot be checked\n`]);
});

test("a failed write rolls back what the run wrote and reports nothing as written", (t) => {
  const s = sandbox(t);
  const hookDir = join(s.home, ".config/omarchy/hooks/post-update.d");
  mkdirSync(hookDir, { recursive: true });
  chmodSync(hookDir, 0o555);
  t.after(() => { try { chmodSync(hookDir, 0o755); } catch { /* already removed */ } });
  const before = snapshot(s.home);
  const r = s.run(["setup", "--apply", "--json"]);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, "E_APPLY_FAILED");
  assert.deepEqual(r.json.error.details.written, []);
  assert.match(r.json.error.message, /rolled back/);
  assert.deepEqual(snapshot(s.home), before);
});

test("an AppImage without libfuse2: the entry adds --appimage-extract-and-run, and the plan names fuse2", (t) => {
  const s = sandbox(t, { fuse: false });
  appImage(s, "oats-desktop-0.60.0-linux-x86_64.AppImage", join(s.home, "Downloads"));
  const r = s.run(["setup", "--plan", "--json"]);
  assert.equal(r.json.result.found.libfuse2.ok, false);
  assert.ok(r.json.result.fixes.some((f) => f.fix === "sudo pacman -S fuse2"));
  assert.match(r.json.result.keys.snippet, /oats-desktop-0\.60\.0-linux-x86_64\.AppImage --appimage-extract-and-run --dir/);
  assert.equal(s.run(["setup", "--apply", "--ui", "tui"]).status, 0);
  const desktop = readDesktopEntry(readFileSync(paths(s).desktopEntry, "utf8"));
  assert.deepEqual(parseDesktopExec(desktop.Exec).slice(1), ["--appimage-extract-and-run", "--dir", s.deployment]);
});

test("an existing Desktop entry is used, not replaced", (t) => {
  const s = sandbox(t);
  const image = appImage(s);
  const apps = join(s.home, ".local/share/applications");
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, "oats-desktop.desktop"), `[Desktop Entry]\nName=OATS Desktop\nExec=${image} --no-sandbox %U\nStartupWMClass=awebai-oats-desktop\n`);
  const r = s.run(["setup", "--apply", "--ui", "tui", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(part(r.json.result, "desktop").status, "skipped");
  assert.match(part(r.json.result, "desktop").reason, /existing launcher entry .*oats-desktop\.desktop provides it/);
  assert.ok(!existsSync(paths(s).desktopEntry));
  assert.match(r.json.result.keys.snippet, new RegExp(`uwsm-app -- ${image.replace(/[/.]/g, "\\$&")} --no-sandbox\\\\"`));
});

test("missing launchers, hook runner or kernel skip their parts with the reason", (t) => {
  const noApps = sandbox(t, { launchers: ["omarchy-hook"] });
  const a = noApps.run(["setup", "--plan", "--json"]).json.result;
  assert.match(part(a, "tui").reason, /not on this command's PATH .*: omarchy-launch-or-focus-tui, omarchy-launch-or-focus, uwsm-app/);
  assert.equal(part(a, "hook").status, "will apply");

  const noHook = sandbox(t, { launchers: ["omarchy-launch-or-focus-tui", "omarchy-launch-or-focus", "uwsm-app"] });
  assert.match(part(noHook.run(["setup", "--plan", "--json"]).json.result, "hook").reason, /omarchy-hook/);

  const badKernel = sandbox(t, { kernel: "fail" });
  const k = badKernel.run(["setup", "--plan", "--json"]).json.result;
  for (const name of ["shim", "tui", "hook", "menu"]) assert.match(part(k, name).reason, /the OATS CLI cannot be used: .*version --json` did not answer as the OATS CLI does, with the minimal PATH/, name);
  assert.ok(k.fixes.some((f) => /npm install -g @awebai\/oats/.test(f.fix)), "the fix names the global install");
  assert.equal(badKernel.run(["setup", "--apply"]).status, 0, "nothing to apply is not a failure");
});

test("the session PATH is used when there is one, and tmux missing from it is a fix", (t) => {
  const s = sandbox(t, { tmux: false });
  // The session's PATH holds the launchers but no tmux.
  const sessionPath = `${s.fakebin}:/nonexistent`;
  writeExecutable(join(s.fakebin, "systemctl"), `#!/bin/sh\necho "PATH=${sessionPath}"\n`);
  const r = s.run(["setup", "--plan", "--json"]).json.result;
  assert.equal(r.found.launchPath.source, "session");
  assert.equal(r.found.tmux, null);
  assert.ok(r.fixes.some((f) => f.fix === "sudo pacman -S tmux"));
  assert.match(r.found.features.on, /the user session's PATH/);
});

test("bad arguments exit 2; no deployment exits 1 with E_NO_DEPLOYMENT; remove and check without state exit 0", (t) => {
  const s = sandbox(t);
  for (const args of [["setup", "--bogus"], ["setup", "--apply", "--remove"], ["setup", "--desktop"], ["setup", "--remove", "--desktop", "/x"]]) {
    const r = s.run([...args, "--json"]);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.json.error.code, "E_BAD_ARGS");
  }
  assert.match(s.run(["setup", "--bogus"]).stderr, /unknown argument: --bogus\nusage: setup /);
  const noDep = s.run(["setup", "--plan", "--json"], {}, { cwd: s.root });
  assert.equal(noDep.status, 1);
  assert.equal(noDep.json.error.code, "E_NO_DEPLOYMENT");
  assert.match(noDep.json.error.message, /no OATS deployment: no oats-local\.yaml at or above .*; pass --dir <deployment>/);
  assert.match(s.run(["setup", "--plan", "--json", "--dir", join(s.root, "nope")]).json.error.message, /--dir .*nope does not exist/);
  assert.match(s.run(["setup", "--plan", "--json", "--dir", s.root]).json.error.message, /holds no oats-local\.yaml/);
  const check = s.run(["setup", "--check"]);
  assert.deepEqual([check.status, check.stdout], [0, ""]);
  const desktopFlag = s.run(["setup", "--plan", "--desktop", "/nonexistent/OATS.AppImage", "--json"]);
  assert.match(part(desktopFlag.json.result, "desktop").reason, /--desktop \/nonexistent\/OATS\.AppImage is not an existing executable file/);
});

test("the deployment, in order: --dir, the working directory and above, then the one setup is applied for", (t) => {
  const s = sandbox(t);
  const inside = join(s.deployment, "agents", "x", "instances", "x-1", "work");
  mkdirSync(inside, { recursive: true });
  assert.deepEqual(s.run(["setup", "--plan", "--json"], {}, { cwd: inside }).json.result.found.deployment, { path: s.deployment, from: "the working directory" });
  assert.deepEqual(s.run(["setup", "--plan", "--json", "--dir", "."], {}, { cwd: s.deployment }).json.result.found.deployment, { path: s.deployment, from: "--dir" });
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.deepEqual(s.run(["setup", "--plan", "--json"], {}, { cwd: s.root }).json.result.found.deployment, { path: s.deployment, from: "setup's state" });
  assert.deepEqual(s.run(["setup", "--check", "--json"], {}, { cwd: s.root }).json.result.drift, []);
  assert.equal(s.run(["setup", "--remove"], {}, { cwd: s.root }).status, 0);
});
