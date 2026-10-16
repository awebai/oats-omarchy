// The Desktop's standard Linux install, laid out exactly as its install
// writes it: the AppImage at ~/.local/opt/oats-desktop/OATS-Desktop.AppImage
// and, beside it, a launcher entry with no StartupWMClass whose Exec runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as menu from "../oats-package/capabilities/oats-omarchy/lib/menu.mjs";
import { sandbox, snapshot, writeExecutable } from "./helpers/sandbox.mjs";

const FLAG = "--appimage-extract-and-run";

function install(s, { entry = true, appImage = true, exec = null } = {}) {
  const image = join(s.home, ".local/opt/oats-desktop/OATS-Desktop.AppImage");
  const file = join(s.home, ".local/share/applications/oats-desktop.desktop");
  if (appImage) writeExecutable(image, "#!/bin/sh\nexit 0\n");
  if (entry) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `[Desktop Entry]\nType=Application\nName=OATS Desktop\nExec=${exec ?? `${image} %U`}\nTerminal=false\nCategories=Development;\n`);
  }
  return { image, file };
}

const part = (r, name) => r.json.result.parts.find((x) => x.part === name);
const menuItems = (s) => menu.omarchyParse(readFileSync(join(s.home, ".config/omarchy/extensions/omarchy-menu.jsonc"), "utf8")).items;
const count = (text, word) => text.split(word).length - 1;

test("entry and AppImage: the entry is found through its Exec, no entry is written, the key and menu run its Exec without %U", (t) => {
  const s = sandbox(t);
  const { image, file } = install(s);
  const entryBytes = readFileSync(file);
  const plan = s.run(["setup", "--plan", "--json"]);
  assert.deepEqual(plan.json.result.found.desktop, { source: "entry", entry: file, appImage: image });
  assert.equal(part(plan, "desktop").status, "skipped");
  assert.match(part(plan, "desktop").reason, /the existing launcher entry .*oats-desktop\.desktop provides it/);
  assert.ok(!plan.json.result.fixes.some((f) => f.fix === "sudo pacman -S fuse2"));

  const apply = s.run(["setup", "--apply", "--json"]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(existsSync(join(s.home, ".local/share/applications/awebai-oats-desktop.desktop")), false);
  assert.ok(readFileSync(file).equals(entryBytes), "the user's entry is never changed");
  const command = `omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- ${image}"`;
  assert.equal(menuItems(s)["oats.desktop"].action, command);
  assert.ok(apply.json.result.keys.snippet.includes(`uwsm-app -- ${image}\\""`), "the key runs the same command");
  assert.ok(!apply.json.result.keys.snippet.includes("%U"));
});

test("the AppImage only: found in ~/.local/opt/oats-desktop, and its entry is written", (t) => {
  const s = sandbox(t);
  const { image } = install(s, { entry: false });
  const plan = s.run(["setup", "--plan", "--json"]);
  assert.deepEqual(plan.json.result.found.desktop, { source: "appimage", appImage: image });
  assert.equal(part(plan, "desktop").status, "will apply");
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.match(readFileSync(join(s.home, ".local/share/applications/awebai-oats-desktop.desktop"), "utf8"), new RegExp(`^Exec=${image.replace(/[.]/g, "\\.")} --dir `, "m"));
});

test("the entry without libfuse2: the fuse2 fix, the key and menu extract and run, the entry is left alone; --check reports the AppImage gone once", (t) => {
  const s = sandbox(t, { fuse: false });
  const { image, file } = install(s);
  const before = snapshot(s.home);
  const plan = s.run(["setup", "--plan", "--json"]);
  const fix = plan.json.result.fixes.find((f) => f.fix === "sudo pacman -S fuse2");
  assert.ok(fix, "the fuse2 fix is named");
  assert.match(fix.why, /your launcher entry .*oats-desktop\.desktop runs with --appimage-extract-and-run \(your entry is left as it is/);
  assert.match(part(plan, "desktop").reason, /with --appimage-extract-and-run \(libfuse2 is missing\)/);

  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(menuItems(s)["oats.desktop"].action, `omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- ${image} ${FLAG}"`);
  assert.equal(readFileSync(file, "utf8").includes(FLAG), false, "the user's entry is never changed");
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  unlinkSync(image);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, [`the Desktop AppImage ${image} is gone`]);
  writeExecutable(image, "#!/bin/sh\nexit 0\n");
  assert.equal(s.run(["setup", "--remove"]).status, 0);
  assert.deepEqual(snapshot(s.home), before);
});

test("the entry already extracts and runs (no libfuse2): the flag is not added twice, no fuse2 fix, a note says so", (t) => {
  const s = sandbox(t, { fuse: false });
  const image = join(s.home, ".local/opt/oats-desktop/OATS-Desktop.AppImage");
  install(s, { exec: `${image} ${FLAG} %U` });
  const plan = s.run(["setup", "--plan", "--json"]);
  assert.ok(!plan.json.result.fixes.some((f) => f.fix === "sudo pacman -S fuse2"));
  assert.ok(plan.json.result.notes.some((n) => /already runs the AppImage extracted \(--appimage-extract-and-run\), so it needs no libfuse2/.test(n)));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  const action = menuItems(s)["oats.desktop"].action;
  assert.equal(action, `omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- ${image} ${FLAG}"`);
  assert.equal(count(action, FLAG), 1);
});

// An entry may run the AppImage by its name on PATH; it is the same
// AppImage, and needs libfuse2 the same way.
test("an entry that runs the AppImage by name, without libfuse2: the fuse2 fix, the flag after the name, --check looks it up on PATH", (t) => {
  const s = sandbox(t, { fuse: false });
  const name = "OATS-Desktop.AppImage";
  writeExecutable(join(s.fakebin, name), "#!/bin/sh\nexit 0\n");
  const { file } = install(s, { appImage: false, exec: `${name} %U` });
  const plan = s.run(["setup", "--plan", "--json"]);
  assert.deepEqual(plan.json.result.found.desktop, { source: "entry", entry: file, appImage: name });
  assert.ok(plan.json.result.fixes.some((f) => f.fix === "sudo pacman -S fuse2"));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(menuItems(s)["oats.desktop"].action, `omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- ${name} ${FLAG}"`);
  assert.deepEqual(s.run(["setup", "--check", "--json"]).json.result.drift, []);
  unlinkSync(join(s.fakebin, name));
  const drift = s.run(["setup", "--check", "--json"]).json.result.drift;
  assert.equal(drift.length, 1, drift.join("\n"));
  assert.match(drift[0], /^the Desktop AppImage OATS-Desktop\.AppImage is gone from /);
});

test("an entry that already extracts and runs the AppImage by name: no fuse2 fix, the flag once", (t) => {
  const s = sandbox(t, { fuse: false });
  const name = "OATS-Desktop.AppImage";
  writeExecutable(join(s.fakebin, name), "#!/bin/sh\nexit 0\n");
  install(s, { appImage: false, exec: `${name} ${FLAG} %U` });
  const plan = s.run(["setup", "--plan", "--json"]);
  assert.ok(!plan.json.result.fixes.some((f) => f.fix === "sudo pacman -S fuse2"));
  assert.ok(plan.json.result.notes.some((n) => /already runs the AppImage extracted/.test(n)));
  assert.equal(s.run(["setup", "--apply"]).status, 0);
  assert.equal(menuItems(s)["oats.desktop"].action, `omarchy-launch-or-focus awebai-oats-desktop "uwsm-app -- ${name} ${FLAG}"`);
});
