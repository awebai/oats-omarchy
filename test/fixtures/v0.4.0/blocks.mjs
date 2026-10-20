// The oats menu block and the SUPER + O key block exactly as oats-omarchy
// v0.4.0 wrote them (lib/menu.mjs block, lib/keys.mjs luaSnippet for
// Omarchy's stock pop-out, at 1b8168d4), and its plugin.json's picker
// commands, so a test can start from a home v0.4.0 set up and upgrade it.
// Kept as it was: do not change it with the code.
import { blockText } from "../../../lib/bindings.mjs";
import { START, END } from "../../../lib/menu.mjs";
import { luaString, shellQuote } from "../../../lib/quote.mjs";

const GLYPH = { oats: "\u{F06A9}", open: "\u{F06A9}", agents: "\u{F066F}", souls: "\u{F005}", tui: "\u{F489}", desktop: "\u{F0379}", waiting: "\u{F009A}", status: "\u{EA74}" };
const ALIASES = {
  oats: ["oats", "agents", "instances", "souls", "waiting"],
  open: ["oats", "agents", "instances", "souls", "waiting"],
  waiting: ["oats", "waiting", "agents"],
  agents: ["oats", "agents", "instances"],
  souls: ["oats", "souls", "agents"],
  tui: ["oats", "agents", "instances"],
  desktop: ["oats", "agents", "instances"],
  status: ["oats", "agents", "instances"],
};
const PLUGIN_ID = "ai.aweb.oats";
const payload = (section) => JSON.stringify(section ? { section } : {});
export const pickerToggle = () => `omarchy-shell shell toggle ${PLUGIN_ID} ${shellQuote(payload(null))}`;
const pickerSummon = (section) => `omarchy-shell shell summon ${PLUGIN_ID} ${shellQuote(payload(section))}`;
const PICKER_UNAVAILABLE = "the OATS picker could not open: is the OATS plugin enabled (its icon in the bar)?";
const pickerAction = (section, fallback = null) =>
  `[ "$(${pickerSummon(section)} 2>/dev/null)" = ok ] || ${fallback ?? `omarchy-notification-send OATS ${shellQuote(PICKER_UNAVAILABLE)}`}`;

export function menuBlock({ tui, desktop, waiting, status }) {
  const rows = [
    ["oats", { icon: GLYPH.oats, label: "OATS", aliases: ALIASES.oats }],
    ["oats.open", { icon: GLYPH.open, label: "Open OATS", aliases: ALIASES.open, action: pickerAction(null) }],
    ["oats.waiting", { icon: GLYPH.waiting, label: "Waiting on you", aliases: ALIASES.waiting, action: pickerAction("waiting", waiting) }],
    ["oats.agents", { icon: GLYPH.agents, label: "Agents", aliases: ALIASES.agents, action: pickerAction("agents") }],
    ["oats.souls", { icon: GLYPH.souls, label: "Souls", aliases: ALIASES.souls, action: pickerAction("souls") }],
    tui && ["oats.tui", { icon: GLYPH.tui, label: "Open OATS TUI", aliases: ALIASES.tui, action: tui }],
    desktop && ["oats.desktop", { icon: GLYPH.desktop, label: "Open OATS Desktop", aliases: ALIASES.desktop, action: desktop }],
    ["oats.status", { icon: GLYPH.status, label: "Status", aliases: ALIASES.status, action: status }],
  ].filter(Boolean);
  return START + rows.map(([id, value]) => `  ${JSON.stringify(id)}: ${JSON.stringify(value)},\n`).join("") + END;
}

// SUPER + O over Omarchy's stock "Pop window out": Space (the picker), T, D.
export function keyBlock({ tui, desktop }) {
  const picker = pickerToggle();
  const keys = ["Space (OATS)", tui ? "T (TUI)" : null, desktop ? "D (Desktop)" : null].filter(Boolean);
  const opens = keys.length > 1 ? `${keys.slice(0, -1).join(", ")} or ${keys.at(-1)}` : keys[0];
  const lines = [`-- OATS: SUPER + O, then ${opens}; O again pops the window out.`];
  lines.push(`hl.unbind(${luaString("SUPER + O")})`);
  lines.push(`o.bind(${luaString("SUPER + O")}, ${luaString("OATS")}, hl.dsp.submap(${luaString("oats")}))`);
  lines.push(`hl.define_submap(${luaString("oats")}, "reset", function()`);
  const binds = [["SPACE", "Open OATS", picker], ["SUPER + SPACE", "Open OATS", picker]];
  if (tui) binds.push(["T", "OATS TUI", tui], ["SUPER + T", "OATS TUI", tui]);
  if (desktop) binds.push(["D", "OATS Desktop", desktop], ["SUPER + D", "OATS Desktop", desktop]);
  binds.push(["O", "Pop window out", "omarchy-hyprland-window-pop"], ["SUPER + O", "Pop window out", "omarchy-hyprland-window-pop"]);
  for (const [k, description, command] of binds) lines.push(`  o.bind(${luaString(k)}, ${luaString(description)}, ${luaString(command)})`);
  lines.push(`  hl.bind("escape", hl.dsp.submap("reset"))`);
  lines.push(`  hl.bind("catchall", hl.dsp.submap("reset"))`);
  lines.push("end)");
  return blockText(`${lines.join("\n")}\n`);
}

// plugin.json's two picker commands, which v0.4.0 added after `setup`.
export const pickerCommands = ({ node, pluginDir, deployment }) => ({
  agents: [node, `${pluginDir}/bin/agents.mjs`, ...(deployment === null ? ["--list"] : ["--dir", deployment])],
  spawn: [node, `${pluginDir}/bin/spawn.mjs`],
});
