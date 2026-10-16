// No file in this repository names a terminal emulator. Terminal windows open
// through Omarchy's launchers, which run the user's default terminal through
// xdg-terminal-exec; naming one would pick it for them.
//
// This file holds the pattern list, so it is the one file the scan skips
// (besides .git). Binary files are scanned too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const repo = resolve(dirname(self), "..");

const TERMINALS = [
  "ghostty", "alacritty", "kitty", "foot", "wezterm", "konsole", "gnome-terminal",
  "xterm", "urxvt", "st-256color", "terminator", "tilix", "xfce4-terminal",
];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN = new RegExp(`\\b(?:${TERMINALS.map(escape).join("|")})\\b`, "gi");

// Every match in every file under `root`, as "path:line: name".
function scan(root, skip = new Set()) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === ".git" || skip.has(path)) continue;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      const lines = readFileSync(path, "latin1").split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(PATTERN)) hits.push(`${relative(root, path)}:${i + 1}: ${match[0]}`);
      });
    }
  };
  walk(root);
  return hits;
}

test("no file in the repository names a terminal emulator", () => {
  assert.deepEqual(scan(repo, new Set([self])), []);
});

test("the scan catches a planted name, in any case, and only as a whole word", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oats-omarchy-terminals-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(repo, "test", "fixtures", "terminal-names", "clean"), dir, { recursive: true });
  assert.deepEqual(scan(dir), [], "the clean fixture has no names (footer and kittycat are not whole-word matches)");

  writeFileSync(join(dir, "sub", "planted.desktop"), `[Desktop Entry]\nExec=${TERMINALS[2].toUpperCase()} -e oats tui\n`);
  assert.deepEqual(scan(dir), [`sub/planted.desktop:2: ${TERMINALS[2].toUpperCase()}`]);

  for (const name of TERMINALS) {
    writeFileSync(join(dir, "each.txt"), `run ${name} here\n`);
    assert.deepEqual(scan(dir).filter((hit) => hit.startsWith("each.txt")), [`each.txt:1: ${name}`], name);
  }
});
