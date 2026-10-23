// The oats menu block and the TUI's launcher entry exactly as oats-omarchy
// v0.6.0 wrote them (lib/menu.mjs block, lib/files.mjs tuiEntry, at
// d0a4428), so a test can start from a home v0.6.0 set up and upgrade it.
// Its menu has the default UI's row alone (no Default Agent row), and its
// key block is v0.3.0's, byte for byte (test/fixtures/v0.3.0). Kept as it
// was: do not change it with the code.
import { renderDesktopEntry } from "../../../lib/desktop-entry.mjs";
import { START, END } from "../../../lib/menu.mjs";
import { TUI_COMMENT, TUI_ID, tuiArgv } from "../../../lib/files.mjs";
export { keyBlock } from "../v0.3.0/blocks.mjs";

const GLYPH = { ui: "\u{F06A9}" };

// The row that opens the default UI; none (no block) without one.
export function menuBlock({ ui = null, tui, desktop }) {
  const open = ui === "desktop" ? desktop : ui === "tui" ? tui : null;
  if (!open) return null;
  return START + `  ${JSON.stringify("oats-ui")}: ${JSON.stringify({ icon: GLYPH.ui, label: "OATS", action: open })},\n` + END;
}

// The TUI's launcher entry, named OATS TUI.
export const tuiEntry = (spec) => renderDesktopEntry([
  ["Version", "1.0"],
  ["Type", "Application"],
  ["Name", "OATS TUI"],
  ["Comment", TUI_COMMENT],
  ["Exec", tuiArgv(spec)],
  ["Icon", TUI_ID],
  ["Terminal", "false"],
  ["Categories", "Development;"],
]);
