// Hyprland --verify-config on a copy of the user's config, before setup
// writes the key block into the live bindings.lua (Hyprland reloads as soon
// as it changes).
//
// Omarchy's hyprland.lua sets package.path from $HOME: $HOME/.local/state,
// $HOME/.config, then $OMARCHY_PATH. So the copy lives in a temporary HOME
// (mode 0700, under a private temporary directory, removed afterwards) that
// holds ~/.config/hypr and what the shipped config loads from the state
// directory: the current theme's Lua modules, Omarchy's Hyprland toggles and
// the saved workspace layouts. The config runs shell commands as it loads
// (io.popen), so these are copies, never links to the live directories.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { run } from "./system.mjs";

export const COPY_LIMIT = 50 * 1024 * 1024;
const LINES = 5;
const LINE_LENGTH = 200;

class TooLarge extends Error {}

// Regular files (links followed) from `src` into `dst`: the whole tree (to a
// depth that a link cycle cannot defeat), or only the top level's files
// matching `only`. Bounded by `budget.left`.
const DEPTH = 8;
function copyTree(src, dst, budget, { recursive = true, only = null, depth = 0 } = {}) {
  let entries;
  try { entries = readdirSync(src, { withFileTypes: true }); } catch { return; }
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const from = join(src, entry.name);
    let st;
    try { st = statSync(from); } catch { continue; } // a dangling link
    if (st.isDirectory()) { if (recursive && depth < DEPTH) copyTree(from, join(dst, entry.name), budget, { recursive, only, depth: depth + 1 }); continue; }
    if (!st.isFile() || (only && !only.test(entry.name))) continue;
    budget.left -= st.size;
    if (budget.left < 0) throw new TooLarge(`${from}`);
    copyFileSync(from, join(dst, entry.name));
  }
}

// What Hyprland said, bounded: from "Config parsing result" on when it says
// so, else its last lines.
function firstLines(out) {
  const lines = String(out).split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const at = lines.findIndex((l) => /Config parsing result/i.test(l));
  const from = at >= 0 ? lines.slice(at) : lines.slice(-LINES);
  return from.slice(0, LINES).map((l) => (l.length > LINE_LENGTH ? `${l.slice(0, LINE_LENGTH - 1)}…` : l)).join("\n");
}

// → { ok: true } or { ok: false, stage: "copy" | "current" | "candidate", reason }.
// `hyprland` is the Hyprland binary; `candidate` the bindings.lua to check.
export function verifyBindings({ hyprland, p, env, candidate, limit = COPY_LIMIT }) {
  const root = mkdtempSync(join(tmpdir(), "oats-omarchy-verify-"));
  try {
    const home = join(root, "home");
    const hypr = join(home, ".config", "hypr");
    const state = join(home, ".local", "state", "omarchy");
    const budget = { left: limit };
    try {
      copyTree(p.hyprDir, hypr, budget);
      copyTree(join(p.home, ".local", "state", "omarchy", "current", "theme"), join(state, "current", "theme"), budget, { recursive: false, only: /\.lua$/ });
      copyTree(join(p.stateHome, "omarchy", "toggles", "hypr"), join(state, "toggles", "hypr"), budget, { recursive: false });
      copyTree(join(p.home, ".local", "state", "omarchy", "toggles", "hypr"), join(state, "toggles", "hypr"), budget, { recursive: false, only: /-disabled-name$/ });
      copyTree(join(p.stateHome, "omarchy", "workspace-layouts"), join(state, "workspace-layouts"), budget, { recursive: false, only: /\.lua$/ });
    } catch (e) {
      if (e instanceof TooLarge) return { ok: false, stage: "copy", reason: `the Hyprland config and the state it loads are over ${Math.round(limit / 1024 / 1024)} MB (at ${relative(p.home, e.message)}), so setup does not copy them to verify the key block` };
      throw e;
    }
    const runtime = join(root, "run");
    mkdirSync(runtime, { mode: 0o700 });
    const { WAYLAND_DISPLAY, HYPRLAND_INSTANCE_SIGNATURE, DISPLAY, ...rest } = env;
    const verifyEnv = {
      ...rest, HOME: home, XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
    };
    const check = () => {
      const r = run(hyprland, ["--verify-config", "-c", join(hypr, "hyprland.lua")], { env: verifyEnv, cwd: home, timeoutMs: 60_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      return r.ok && /^config ok$/m.test(out) ? null : firstLines(r.error ? `${r.error}\n${out}` : out) || `exit ${r.status}`;
    };
    // The unchanged copy first: a config that already fails is not the block's fault.
    const current = check();
    if (current) return { ok: false, stage: "current", reason: `your current Hyprland config does not verify, so setup does not add the key block:\n${current}` };
    writeFileSync(join(hypr, "bindings.lua"), candidate);
    const next = check();
    if (next) return { ok: false, stage: "candidate", reason: `Hyprland --verify-config refuses your config with the key block added, so setup writes nothing:\n${next}` };
    return { ok: true };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
