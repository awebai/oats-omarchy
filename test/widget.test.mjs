// The plugin's manifest and its bar widget's click. The click's command line
// is built by widget.mjs and run here through bash, with stand-ins for the
// two Omarchy launchers it calls, so the quoting is proven end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clickCommand, shellQuote, urlPath } from "../widget.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("manifest: a bar widget whose id and entry point Omarchy's validator accepts", () => {
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(m.schemaVersion, 1);
  for (const field of ["id", "name", "version", "kinds", "entryPoints"]) assert.ok(m[field], field);
  assert.match(m.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(!m.id.startsWith("omarchy.") && !m.id.includes(".."));
  assert.deepEqual(m.kinds, ["bar-widget"]);
  assert.ok(existsSync(join(root, m.entryPoints.barWidget)), m.entryPoints.barWidget);
  const qml = readFileSync(join(root, m.entryPoints.barWidget), "utf8");
  assert.match(qml, /moduleName: "ai\.aweb\.oats"/);
  assert.match(qml, /import "widget\.mjs" as Widget/);
});

test("shellQuote and urlPath", () => {
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(urlPath("file:///home/a%20b/it's/setup"), "/home/a b/it's/setup");
});

function world(t, { entry }) {
  const dir = mkdtempSync(join(tmpdir(), "oats-widget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const log = join(dir, "log");
  const plugin = join(dir, "plugins", "it's a $(touch pwned) `x` dir");
  for (const d of [home, bin, plugin]) mkdirSync(d, { recursive: true });
  const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
  // Each stand-in logs its argv, one argument per line.
  exe(join(bin, "uwsm-app"), `#!/bin/sh\nprintf 'uwsm-app\\n' >> '${log}'; printf '%s\\n' "$@" >> '${log}'\n`);
  // As Omarchy 4.0.4's launcher does: its arguments are one bash command line.
  exe(join(bin, "omarchy-launch-floating-terminal-with-presentation"), `#!/bin/bash\ncmd="$*"\nexec bash -c "$cmd"\n`);
  exe(join(plugin, "setup"), `#!/bin/sh\nprintf 'setup\\n' >> '${log}'; printf '%s\\n' "$@" >> '${log}'\n`);
  if (entry) {
    mkdirSync(join(home, ".local/share/applications"), { recursive: true });
    writeFileSync(join(home, ".local/share/applications/org.oats.tui.desktop"), "[Desktop Entry]\n");
  }
  const click = () => {
    const r = spawnSync("bash", ["-c", clickCommand(join(plugin, "setup"))], {
      cwd: dir, encoding: "utf8", timeout: 10000,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(log, "utf8").split("\n").filter(Boolean);
  };
  return { dir, click };
}

test("click, setup applied: opens the TUI entry setup wrote, through uwsm-app", (t) => {
  const w = world(t, { entry: true });
  assert.deepEqual(w.click(), ["uwsm-app", "--", "org.oats.tui.desktop"]);
});

test("click, setup not applied: setup --plan in the floating terminal, with a hostile plugin path kept literal", (t) => {
  const w = world(t, { entry: false });
  assert.deepEqual(w.click(), ["setup", "--plan"]);
  assert.ok(!existsSync(join(w.dir, "pwned")), "the path was not run as a command");
});
