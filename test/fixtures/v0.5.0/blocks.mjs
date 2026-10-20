// The oats menu block and the TUI's launcher entry exactly as oats-omarchy
// v0.5.0 wrote them (lib/menu.mjs block, lib/files.mjs tuiEntry, at
// 521606d7), so a test can start from a home v0.5.0 set up and upgrade it.
// Its key block is v0.3.0's (test/fixtures/v0.3.0). Kept as it was: do not
// change it with the code.
import { renderDesktopEntry } from "../../../lib/desktop-entry.mjs";
import { START, END } from "../../../lib/menu.mjs";
import { shellQuote, shellWord } from "../../../lib/quote.mjs";
import { TUI_COMMENT, TUI_ID, tuiArgv } from "../../../lib/files.mjs";
export { keyBlock } from "../v0.3.0/blocks.mjs";

const GLYPH = { ui: "\u{F06A9}", oats: "\u{F066F}", tui: "\u{F489}", desktop: "\u{F0379}", waiting: "\u{F009A}", status: "\u{EA74}" };
const popupAction = (fallback) => `[ "$(omarchy-shell shell summon ai.aweb.oats ${shellQuote("{}")} 2>/dev/null)" = ok ] || ${fallback}`;

// "Waiting on you" fell back to bin/waiting.mjs; "Status" ran the kernel's
// `oats status`, or bin/status.mjs with the list.
export const waitingAction = ({ node, pluginDir, deployment }) =>
  [node, `${pluginDir}/bin/waiting.mjs`, ...(deployment === null ? ["--list"] : ["--dir", deployment])]
    .map((word) => (word.startsWith("--") ? word : shellQuote(word))).join(" ");
export const statusAction = ({ deployment, shimPath, node, pluginDir }) =>
  `omarchy-launch-floating-terminal-with-presentation ${shellWord(deployment === null
    ? `${shellQuote(node)} ${shellQuote(`${pluginDir}/bin/status.mjs`)}`
    : `cd ${shellQuote(deployment)} && ${shellQuote(shimPath)} status`)}`;

export function menuBlock({ ui = null, tui, desktop, waiting, status }) {
  const open = ui === "desktop" ? desktop : ui === "tui" ? tui : null;
  const rows = [
    open && ["oats-ui", { icon: GLYPH.ui, label: "OATS", action: open }],
    ["oats", { icon: GLYPH.oats, label: "Agent team", aliases: ["oats"] }],
    tui && ["oats.tui", { icon: GLYPH.tui, label: "Open OATS TUI", action: tui }],
    desktop && ["oats.desktop", { icon: GLYPH.desktop, label: "Open OATS Desktop", action: desktop }],
    ["oats.waiting", { icon: GLYPH.waiting, label: "Waiting on you", action: popupAction(waiting) }],
    ["oats.status", { icon: GLYPH.status, label: "Status", action: status }],
  ].filter(Boolean);
  return START + rows.map(([id, value]) => `  ${JSON.stringify(id)}: ${JSON.stringify(value)},\n`).join("") + END;
}

// The TUI's launcher entry, named OATS: v0.3.0 and v0.4.0 wrote the same.
export const tuiEntry = (spec) => renderDesktopEntry([
  ["Version", "1.0"],
  ["Type", "Application"],
  ["Name", "OATS"],
  ["Comment", TUI_COMMENT],
  ["Exec", tuiArgv(spec)],
  ["Icon", TUI_ID],
  ["Terminal", "false"],
  ["Categories", "Development;"],
]);
