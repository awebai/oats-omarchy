// The oats menu block and the SUPER + O key block exactly as oats-omarchy
// v0.3.0 wrote them (lib/menu.mjs block, lib/keys.mjs luaSnippet for
// Omarchy's stock pop-out, at 6800dd95), so a test can start from a home
// v0.3.0 set up and upgrade it. Kept as it was: do not change it with the
// code.
import { blockText } from "../../../lib/bindings.mjs";
import { START, END } from "../../../lib/menu.mjs";
import { luaString } from "../../../lib/quote.mjs";

const GLYPH = { oats: "\u{F06A9}", tui: "\u{F489}", desktop: "\u{F0379}", waiting: "\u{F009A}", status: "\u{EA74}" };

export function menuBlock({ tui, desktop, waiting, status }) {
  const rows = [
    ["oats", { icon: GLYPH.oats, label: "OATS" }],
    tui && ["oats.tui", { icon: GLYPH.tui, label: "Open OATS TUI", action: tui }],
    desktop && ["oats.desktop", { icon: GLYPH.desktop, label: "Open OATS Desktop", action: desktop }],
    ["oats.waiting", { icon: GLYPH.waiting, label: "Waiting on you", action: waiting }],
    ["oats.status", { icon: GLYPH.status, label: "Status", action: status }],
  ].filter(Boolean);
  return START + rows.map(([id, value]) => `  ${JSON.stringify(id)}: ${JSON.stringify(value)},\n`).join("") + END;
}

// SUPER + O over Omarchy's stock "Pop window out", T and D.
export function keyBlock({ tui, desktop }) {
  const opens = [tui ? "T (TUI)" : null, desktop ? "D (Desktop)" : null].filter(Boolean).join(" or ");
  const lines = [`-- OATS: SUPER + O, then ${opens || "nothing (both parts are skipped)"}; O again pops the window out.`];
  lines.push(`hl.unbind(${luaString("SUPER + O")})`);
  lines.push(`o.bind(${luaString("SUPER + O")}, ${luaString("OATS")}, hl.dsp.submap(${luaString("oats")}))`);
  lines.push(`hl.define_submap(${luaString("oats")}, "reset", function()`);
  const binds = [];
  if (tui) binds.push(["T", "OATS TUI", tui], ["SUPER + T", "OATS TUI", tui]);
  if (desktop) binds.push(["D", "OATS Desktop", desktop], ["SUPER + D", "OATS Desktop", desktop]);
  binds.push(["O", "Pop window out", "omarchy-hyprland-window-pop"], ["SUPER + O", "Pop window out", "omarchy-hyprland-window-pop"]);
  for (const [keys, description, command] of binds) lines.push(`  o.bind(${luaString(keys)}, ${luaString(description)}, ${luaString(command)})`);
  lines.push(`  hl.bind("escape", hl.dsp.submap("reset"))`);
  lines.push(`  hl.bind("catchall", hl.dsp.submap("reset"))`);
  lines.push("end)");
  return blockText(`${lines.join("\n")}\n`);
}
