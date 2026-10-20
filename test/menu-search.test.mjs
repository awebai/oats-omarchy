// Typing "oats" in SUPER + SPACE: the default UI is the first row. Ranked by
// Omarchy 4.0.4's own search code (test/fixtures/omarchy-4.0.4/MenuModel.js,
// vendored unchanged and pinned below) over the root of its menu and the
// block setup writes, with the app launchers installed, OATS's own two among
// them. The container test ranks the same block with the real Omarchy's code
// and whole menu.
//
// MenuModel.js is shell/plugins/menu/MenuModel.js of basecamp/omarchy at its
// v4.0.4 release, and omarchy-menu-root.jsonc is derived from
// default/omarchy/omarchy-menu.jsonc there. Omarchy is MIT licensed; its
// notice is test/fixtures/omarchy-4.0.4/LICENSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as menu from "../lib/menu.mjs";
import { menuBlock } from "./fixtures/v0.3.0/blocks.mjs";
import { appRow, loadMenuModel, search } from "./helpers/omarchy-search.mjs";
import { fixture, sandbox, writeExecutable } from "./helpers/sandbox.mjs";

const MODEL = fixture("omarchy-4.0.4", "MenuModel.js");
// sha256 of /usr/share/omarchy/shell/plugins/menu/MenuModel.js in the
// omarchy 4.0.4-1 package. Re-vendor by copying that file from a newer
// package unchanged, then set this and check the ranking still holds.
const DIGEST = "ff6b265ca477d0d04297b0d9a5d9715960069db6da44603160d329e087e55fd8";
const DEFAULTS = readFileSync(fixture("omarchy-4.0.4", "omarchy-menu-root.jsonc"), "utf8");
const QUERIES = ["o", "oa", "oat", "oats", "OATS"];

// The launchers OATS installs (their entries' Name), and others whose names
// start with the same letters.
const APPS = [
  appRow({ id: "org.oats.tui", name: "OATS", subtext: "The OATS terminal UI: your agents and their sessions" }),
  appRow({ id: "awebai-oats-desktop", name: "OATS Desktop", subtext: "OATS Desktop: your agents and their sessions" }),
  appRow({ id: "obsidian", name: "Obsidian", keywords: ["notes"] }),
  appRow({ id: "com.obsproject.Studio", name: "OBS Studio", keywords: ["oats"] }),
];

test("the vendored MenuModel.js is Omarchy 4.0.4's, unchanged", () => {
  assert.equal(createHash("sha256").update(readFileSync(MODEL)).digest("hex"), DIGEST);
});

// A home with both UIs: the TUI, and the Desktop's standard install.
function both(t) {
  const s = sandbox(t);
  const image = join(s.home, ".local/opt/oats-desktop/OATS-Desktop.AppImage");
  writeExecutable(image, "#!/bin/sh\nexit 0\n");
  mkdirSync(join(s.home, ".local/share/applications"), { recursive: true });
  writeFileSync(join(s.home, ".local/share/applications/oats-desktop.desktop"), `[Desktop Entry]\nType=Application\nName=OATS Desktop\nExec=${image} %U\n`);
  return s;
}

for (const ui of ["tui", "desktop"]) {
  test(`with --ui ${ui}, "o", "oa", "oat", "oats" and "OATS" show the row that opens ${ui === "tui" ? "the TUI" : "the Desktop"} first`, (t) => {
    const s = both(t);
    const r = s.run(["setup", "--apply", "--ui", ui]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const user = readFileSync(join(s.home, ".config/omarchy/extensions/omarchy-menu.jsonc"), "utf8");
    const items = menu.omarchyParse(user).items;
    const model = loadMenuModel(MODEL);
    for (const query of QUERIES) {
      const rows = search(model, { defaults: DEFAULTS, user, apps: APPS }, query);
      assert.equal(rows[0].itemId, "oats-ui", `${query}: ${JSON.stringify(rows.slice(0, 4))}`);
      assert.equal(rows[0].label, "OATS");
      assert.equal(rows[0].action, items[`oats.${ui}`].action, `${query}: it opens what the submenu's ${ui} row opens`);
      const ids = rows.map((x) => x.itemId);
      // The launchers are there, and ranked below it.
      for (const id of ["apps.org.oats.tui", "apps.awebai-oats-desktop"]) assert.ok(ids.indexOf(id) > 0, `${query}: ${id} in ${ids}`);
      if (query.length >= 3) assert.ok(ids.indexOf("oats") > 0, `${query}: the submenu is found too, below it`);
    }
  });
}

// What the test tells apart: v0.3.0's block, its submenu labelled OATS and
// nothing else at the root, puts the submenu first.
test("v0.3.0's block: the submenu labelled OATS is first, which is why it has another label now", () => {
  const user = `{\n${menuBlock({ tui: "t", desktop: "d", waiting: "w", status: "s" })}}\n`;
  const model = loadMenuModel(MODEL);
  for (const query of ["oat", "oats"]) assert.equal(search(model, { defaults: DEFAULTS, user, apps: APPS }, query)[0].itemId, "oats", query);
  // And an action labelled OATS beside it would lose to it.
  const both = `{\n  "oats-ui": {"label":"OATS","action":"t"},\n${menuBlock({ tui: "t", desktop: "d", waiting: "w", status: "s" })}}\n`;
  assert.equal(search(model, { defaults: DEFAULTS, user: both, apps: APPS }, "oats")[0].itemId, "oats");
});

test("with neither UI set up there is no OATS row, and the submenu stays", () => {
  const block = menu.block({ ui: null, tui: null, desktop: null, waiting: "w", status: "s" });
  const items = menu.omarchyParse(`{\n${block}}\n`).items;
  assert.deepEqual(Object.keys(items), ["oats", "oats.waiting", "oats.status"]);
  assert.equal(items.oats.label, menu.SUBMENU_LABEL);
});
