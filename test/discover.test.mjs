// Discovery: what setup finds on the machine, against a sandbox HOME, XDG
// directories and PATH of fakes (never the real ones).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandbox, writeExecutable } from "./helpers/sandbox.mjs";
import {
  appImages, deployment, desktop, desktopEntries, features, fuse, GET_DESKTOP, kernel, launchEnvironment,
  layout, MINIMAL_PATH, missing, FEATURES, paths, printBindings, soulName,
} from "../oats-package/capabilities/oats-omarchy/lib/discover.mjs";

const write = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const entry = (lines) => `[Desktop Entry]\nType=Application\nName=OATS Desktop\n${lines.join("\n")}\n`;
// Far-future mtimes, so the sandbox's AppImages are newer than any on the host's /opt.
const future = (path, year) => { const d = new Date(`${year}-01-01T00:00:00Z`); utimesSync(path, d, d); };
const mine = (root, list) => list.filter((p) => p.startsWith(root));

test("soulName: a member soul, a package soul, and garbage", () => {
  assert.equal(soulName("github.com/acme/agents#builder"), "github.com/acme/agents/builder");
  assert.equal(soulName("package:oats.okf#knowledge-maintainer"), "oats.okf/knowledge-maintainer");
  for (const garbage of ["", undefined, null, "builder", "#builder", "repo#", "a#b#c", "repo#a/b", "repo/x"]) {
    assert.equal(soulName(garbage), null, String(garbage));
  }
});

test("soulName: a package soul with no package id is garbage", () => {
  assert.equal(soulName("package:#builder"), null);
});

test("deployment: missing, relative, nonexistent, a file, ok", (t) => {
  const s = sandbox(t);
  assert.match(deployment({}).reason, /OATS_TEAM_SCOPE is not set/);
  assert.equal(deployment({}).ok, false);
  assert.deepEqual(deployment({ OATS_TEAM_SCOPE: "rel/dep" }), { ok: false, reason: "OATS_TEAM_SCOPE is not absolute: rel/dep" });
  const gone = join(s.root, "gone");
  assert.deepEqual(deployment({ OATS_TEAM_SCOPE: gone }), { ok: false, path: gone, reason: `the deployment directory ${gone} does not exist` });
  const file = join(s.root, "a-file");
  writeFileSync(file, "");
  assert.equal(deployment({ OATS_TEAM_SCOPE: file }).ok, false);
  assert.deepEqual(deployment(s.env), { ok: true, path: s.deployment });
});

test("launchEnvironment: no user session → the minimal PATH, features on this command's PATH", (t) => {
  const s = sandbox(t);
  const l = launchEnvironment(s.env);
  assert.equal(l.source, "minimal");
  assert.equal(l.path, MINIMAL_PATH);
  assert.equal(l.featurePath, s.env.PATH);
  assert.match(l.reason, /systemctl --user show-environment: exit 1: Failed to connect to bus/);
  assert.match(l.featureSource, /this command's PATH/);
  // No PATH at all: the minimal one for both.
  assert.equal(launchEnvironment({ HOME: s.home }).featurePath, MINIMAL_PATH);
});

test("launchEnvironment: a user session PATH is used for the launch and for features", (t) => {
  const sessionPath = "/session/bin:/usr/bin:/bin";
  const s = sandbox(t, { session: sessionPath });
  const l = launchEnvironment(s.env);
  assert.equal(l.source, "session");
  assert.equal(l.path, sessionPath);
  assert.equal(l.featurePath, sessionPath);
});

test("features and missing: command -v skips absent names, non-executable files and directories", (t) => {
  const s = sandbox(t, { launchers: false });
  const dir = join(s.root, "feature-bin");
  writeExecutable(join(dir, "omarchy-launch-or-focus-tui"), "#!/bin/sh\n");
  writeExecutable(join(dir, "omarchy-hook"), "#!/bin/sh\n");
  write(join(dir, "omarchy-launch-or-focus"), "#!/bin/sh\n");
  chmodSync(join(dir, "omarchy-launch-or-focus"), 0o644);
  mkdirSync(join(dir, "uwsm-app"));
  const found = features({ featurePath: `${dir}:relative/bin:` });
  assert.equal(found["omarchy-launch-or-focus-tui"], join(dir, "omarchy-launch-or-focus-tui"));
  assert.equal(found["omarchy-hook"], join(dir, "omarchy-hook"));
  assert.equal(found["omarchy-launch-or-focus"], null);
  assert.equal(found["uwsm-app"], null);
  assert.deepEqual(missing(found, FEATURES.apps), ["omarchy-launch-or-focus", "uwsm-app"]);
  assert.deepEqual(missing(found, FEATURES.hook), []);
  // A later PATH entry supplies what an earlier one lacks.
  const later = join(s.root, "later-bin");
  writeExecutable(join(later, "uwsm-app"), "#!/bin/sh\n");
  assert.equal(features({ featurePath: `${dir}:${later}` })["uwsm-app"], join(later, "uwsm-app"));
  // The sandbox's own PATH has every launcher.
  const all = features(launchEnvironment(sandbox(t).env));
  assert.deepEqual(missing(all, [...FEATURES.apps, ...FEATURES.hook]), []);
});

test("kernel: ok, unset, relative, nonexistent, and a CLI that fails --version", (t) => {
  const s = sandbox(t);
  const launch = launchEnvironment(s.env);
  const ok = kernel(s.env, launch);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.version, "@awebai/oats 0.60.0 (desktop API v1)");
  assert.equal(ok.node, process.execPath);
  assert.equal(ok.cli, s.cli);

  const unset = kernel({ ...s.env, OATS_NODE_BIN: undefined }, launch);
  assert.equal(unset.ok, false);
  assert.match(unset.reason, /^OATS_NODE_BIN is not set/);
  assert.match(kernel({ ...s.env, OATS_CLI_BIN: "" }, launch).reason, /^OATS_CLI_BIN is not set/);
  assert.equal(kernel({ ...s.env, OATS_CLI_BIN: "kernel/oats.mjs" }, launch).reason, "OATS_CLI_BIN is not absolute: kernel/oats.mjs");
  const gone = join(s.root, "kernel", "gone.mjs");
  assert.equal(kernel({ ...s.env, OATS_CLI_BIN: gone }, launch).reason, `OATS_CLI_BIN does not exist: ${gone}`);

  const bad = sandbox(t, { kernel: "fail" });
  const failed = kernel(bad.env, launchEnvironment(bad.env));
  assert.equal(failed.ok, false);
  assert.ok(failed.reason.includes(`failed with the minimal PATH ${MINIMAL_PATH}`), failed.reason);
  assert.match(failed.reason, /Cannot find module 'yaml'/);

  const session = sandbox(t, { kernel: "fail", session: "/session/bin:/usr/bin:/bin" });
  assert.match(kernel(session.env, launchEnvironment(session.env)).reason, /failed with the user session's PATH/);
});

test("fuse: ldconfig -p with and without libfuse.so.2", (t) => {
  assert.deepEqual(fuse(sandbox(t, { fuse: true }).env), { ok: true, via: "ldconfig -p" });
  // libfuse3 alone is not libfuse2.
  assert.deepEqual(fuse(sandbox(t, { fuse: false }).env), { ok: false, via: "ldconfig -p" });
});

test("desktop entries: by StartupWMClass, or by an Exec that runs an OATS Desktop AppImage", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  write(join(p.applications, "a-class.desktop"), entry(["Exec=/apps/oats-bin --flag %U", "StartupWMClass=awebai-oats-desktop"]));
  write(join(p.applications, "b-appimage.desktop"), entry(['Exec="/apps/my apps/OATS-Desktop-1.2.AppImage" %U']));
  write(join(p.applications, "c-env.desktop"), entry(["Exec=env FOO=1 BAR=2 /apps/oats_desktop.AppImage %f"]));
  write(join(p.applications, "d-other.desktop"), entry(["Exec=/usr/bin/other-app %U", "StartupWMClass=other"]));
  write(join(p.applications, "e-hidden.desktop"), entry(["Exec=/apps/OATS-Desktop.AppImage", "Hidden=true"]));
  write(join(p.applications, "f-noexec.desktop"), entry(["StartupWMClass=awebai-oats-desktop"]));
  write(join(p.applications, "g-notes.txt"), entry(["Exec=/apps/OATS-Desktop.AppImage"]));
  const found = desktopEntries(p);
  assert.deepEqual(found, [
    { path: join(p.applications, "a-class.desktop"), exec: ["/apps/oats-bin", "--flag"] },
    { path: join(p.applications, "b-appimage.desktop"), exec: ["/apps/my apps/OATS-Desktop-1.2.AppImage"] },
    { path: join(p.applications, "c-env.desktop"), exec: ["env", "FOO=1", "BAR=2", "/apps/oats_desktop.AppImage"] },
  ]);
});

test("desktop entries: $XDG_DATA_HOME wins over $XDG_DATA_DIRS, and setup's own entries are not existing", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  const system = join(p.dataDirs[0], "applications", "oats-system.desktop");
  const user = join(p.applications, "oats-user.desktop");
  write(system, entry(["Exec=/apps/OATS-Desktop.AppImage", "StartupWMClass=awebai-oats-desktop"]));
  write(user, entry(["Exec=/home-apps/OATS-Desktop.AppImage"]));
  const d = desktop(p);
  assert.equal(d.source, "entry");
  assert.equal(d.entry, user);
  assert.deepEqual(d.exec, ["/home-apps/OATS-Desktop.AppImage"]);
  assert.deepEqual(d.others, [system]);
  // An entry setup wrote is skipped.
  const theirs = desktop(p, { ours: new Set([user]) });
  assert.equal(theirs.entry, system);
  assert.deepEqual(theirs.others, []);
});

test("desktop entries: a Hidden=true entry in $XDG_DATA_HOME hides the same desktop file ID in $XDG_DATA_DIRS", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  write(join(p.dataDirs[0], "applications", "oats-desktop.desktop"), entry(["Exec=/apps/OATS-Desktop.AppImage", "StartupWMClass=awebai-oats-desktop"]));
  write(join(p.applications, "oats-desktop.desktop"), entry(["Exec=/apps/OATS-Desktop.AppImage", "Hidden=true"]));
  assert.deepEqual(desktopEntries(p), []);
});

test("AppImages: ~/Applications, ~/.local/bin and ~/Downloads to depth 2, not 3; .bak ignored", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  const hits = [
    join(s.home, "Applications", "OATS-Desktop-1.0.AppImage"),
    join(s.home, ".local", "bin", "oats_desktop.appimage"),
    join(s.home, "Downloads", "release", "OATS Desktop 2.AppImage"),
  ];
  const misses = [
    join(s.home, "Downloads", "a", "b", "OATS-Desktop.AppImage"),
    join(s.home, "Applications", "OATS-Desktop.AppImage.bak"),
    join(s.home, "Applications", "Other-App.AppImage"),
    join(s.home, "Documents", "OATS-Desktop.AppImage"),
  ];
  for (const path of [...hits, ...misses]) writeExecutable(path, "#!/bin/sh\n");
  const found = mine(s.root, appImages(p).map((i) => i.path));
  assert.deepEqual([...found].sort(), [...hits].sort());
  for (const i of appImages(p).filter((i) => i.path.startsWith(s.root))) assert.equal(i.executable, true);
});

test("desktop: several AppImages → the newest by mtime, the others listed", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  const older = join(s.home, "Applications", "OATS-Desktop-1.0.AppImage");
  const newest = join(s.home, "Downloads", "OATS-Desktop-1.1.AppImage");
  const oldest = join(s.home, ".local", "bin", "OATS-Desktop-0.9.AppImage");
  for (const [path, year] of [[older, 2998], [newest, 2999], [oldest, 2997]]) { writeExecutable(path, "#!/bin/sh\n"); future(path, year); }
  const d = desktop(p);
  assert.equal(d.source, "appimage");
  assert.equal(d.appImage, newest);
  assert.deepEqual(mine(s.root, d.others), [older, oldest]);
});

test("desktop: the newest AppImage is not executable → no source, and a chmod fix", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  const image = join(s.home, "Applications", "OATS-Desktop.AppImage");
  write(image, "");
  chmodSync(image, 0o644);
  future(image, 2999);
  const d = desktop(p);
  assert.equal(d.source, null);
  assert.equal(d.reason, `${image} is not executable`);
  assert.equal(d.fix, `chmod +x '${image}', then run setup again`);
});

test("desktop: --desktop overrides an entry and AppImages; refused unless absolute, existing, executable", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  write(join(p.applications, "oats.desktop"), entry(["Exec=/apps/OATS-Desktop.AppImage", "StartupWMClass=awebai-oats-desktop"]));
  const flag = join(s.root, "elsewhere", "Desktop.AppImage");
  writeExecutable(flag, "#!/bin/sh\n");
  assert.deepEqual(desktop(p, { flag }), { source: "flag", appImage: flag, others: [] });
  assert.deepEqual(desktop(p, { flag: "elsewhere/Desktop.AppImage" }), { source: null, reason: "--desktop must be an absolute path: elsewhere/Desktop.AppImage" });
  const gone = join(s.root, "gone.AppImage");
  assert.deepEqual(desktop(p, { flag: gone }), { source: null, reason: `--desktop ${gone} is not an existing executable file` });
  const plain = join(s.root, "plain.AppImage");
  write(plain, "");
  chmodSync(plain, 0o644);
  assert.equal(desktop(p, { flag: plain }).source, null);
  assert.equal(desktop(p, { flag: join(s.root, "elsewhere") }).source, null);
});

test("desktop: none found → a reason and the GET_DESKTOP fix", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  if (appImages(p).length) { t.skip("this host has an OATS Desktop AppImage in /opt"); return; }
  const d = desktop(p);
  assert.equal(d.source, null);
  assert.match(d.reason, /^no OATS Desktop found \(no launcher entry with StartupWMClass=awebai-oats-desktop/);
  assert.equal(d.fix, GET_DESKTOP);
});

test("layout: Lua only, hyprlang only, both (Lua wins), neither", (t) => {
  const s = sandbox(t);
  const p = paths(s.env);
  const lua = join(p.hyprDir, "bindings.lua");
  const conf = join(p.hyprDir, "bindings.conf");
  assert.deepEqual(layout(p), { kind: "lua", file: lua, exists: false, both: false });
  write(conf, "");
  assert.deepEqual(layout(p), { kind: "conf", file: conf, exists: true, both: false });
  write(lua, "");
  assert.deepEqual(layout(p), { kind: "lua", file: lua, exists: true, both: true });
  const lone = sandbox(t);
  const q = paths(lone.env);
  write(join(q.hyprDir, "bindings.lua"), "");
  assert.deepEqual(layout(q), { kind: "lua", file: join(q.hyprDir, "bindings.lua"), exists: true, both: false });
});

test("printBindings: the real capture → ok, with its text", (t) => {
  const s = sandbox(t, { print: "fixture" });
  const r = printBindings(s.env, launchEnvironment(s.env));
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /SUPER SHIFT \+ F\s+→ File manager/);
});

test("printBindings: no running Hyprland (exit 0, only the two static lines) → not ok", (t) => {
  const s = sandbox(t, { print: "no-hyprland" });
  const r = printBindings(s.env, launchEnvironment(s.env));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no running Hyprland answered/);
});

test("printBindings: omarchy fails → not ok, with its error", (t) => {
  const s = sandbox(t, { print: "fail" });
  const r = printBindings(s.env, launchEnvironment(s.env));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "omarchy menu keybindings --print: exit 1: hyprctl: no running Hyprland");
});

test("printBindings: no omarchy command → not ok", (t) => {
  const s = sandbox(t);
  const env = { ...s.env, PATH: join(s.root, "empty") };
  assert.deepEqual(printBindings(env, { featurePath: env.PATH }), { ok: false, reason: "the omarchy command was not found" });
});

test("printBindings: runs omarchy with a temporary XDG_CACHE_HOME that is gone afterwards", (t) => {
  const s = sandbox(t);
  for (const print of ["fixture", "fail"]) {
    const box = sandbox(t, { print });
    printBindings(box.env, launchEnvironment(box.env));
    const logged = readFileSync(join(box.root, "print-cache.log"), "utf8").trim().split("\n");
    assert.equal(logged.length, 1);
    const [cache] = logged;
    assert.ok(cache.startsWith(join(tmpdir(), "oats-omarchy-print-")), cache);
    assert.equal(existsSync(cache), false, `${cache} is left behind`);
    assert.equal(existsSync(join(box.home, ".cache")), false);
  }
  assert.equal(existsSync(join(s.home, ".cache")), false);
});
