// The `oats` submenu: a delimited block in the user's Omarchy menu extension,
// ~/.config/omarchy/extensions/omarchy-menu.jsonc.
//
// The block is inserted before the closing `}` of the object Omarchy reads
// items from, and only the block's bytes (plus a separating comma, when the
// user's last entry had none) are ever added or removed: the rest of the
// user's file is never rewritten. Omarchy's menu runs each action as
// `bash -lc <action>`.
import { shellQuote, shellWord } from "./quote.mjs";

export const START = "  // >>> oats-omarchy (managed by `oats omarchy setup`; remove with --remove) >>>\n";
export const END = "  // <<< oats-omarchy <<<\n";
// The file setup creates when the user has none, around the block.
export const SKELETON = "{\n}\n";
export const IDS = ["oats", "oats.tui", "oats.desktop", "oats.waiting", "oats.status"];

// Glyphs from Omarchy's own menu: Agent, Terminal, Monitors, a bell (the
// notifications toggle uses the crossed-out one) and About.
const GLYPH = { oats: "\u{F06A9}", tui: "\u{F489}", desktop: "\u{F0379}", waiting: "\u{F009A}", status: "\u{EA74}" };

// Every path here has passed assertSafePath.
export const waitingAction = ({ deployment, shimPath, soul }) =>
  `cd ${shellQuote(deployment)} && ${shellQuote(shimPath)} omarchy waiting --soul ${shellQuote(soul)}`;

// The kernel's own `oats status`, in Omarchy's floating terminal, which
// joins its arguments and runs them with `bash -c`.
export const statusAction = ({ deployment, shimPath }) =>
  `omarchy-launch-floating-terminal-with-presentation ${shellWord(`cd ${shellQuote(deployment)} && ${shellQuote(shimPath)} status`)}`;

// The block's text. `tui` and `desktop` are launch commands, or null when
// that part is not applied.
export function block({ tui, desktop, waiting, status }) {
  const rows = [
    ["oats", { icon: GLYPH.oats, label: "OATS" }],
    tui && ["oats.tui", { icon: GLYPH.tui, label: "Open OATS TUI", action: tui }],
    desktop && ["oats.desktop", { icon: GLYPH.desktop, label: "Open OATS Desktop", action: desktop }],
    ["oats.waiting", { icon: GLYPH.waiting, label: "Waiting on you", action: waiting }],
    ["oats.status", { icon: GLYPH.status, label: "Status", action: status }],
  ].filter(Boolean);
  return START + rows.map(([id, value]) => `  ${JSON.stringify(id)}: ${JSON.stringify(value)},\n`).join("") + END;
}

// ---------------------------------------------------------------------------
// Omarchy's reading of the file: MenuModel.js `stripJsonc` and
// `parseMenuJsonc` (Omarchy 4.0.4, shell/plugins/menu/MenuModel.js). It drops
// whole-line `//` comments and trailing commas, then JSON.parse; any other
// comment makes the whole file unreadable, and Omarchy then shows none of it.
// Items come from `items` when that is an object, else from the top level.

export function stripJsonc(raw) {
  return String(raw || "").replace(/^\s*\/\/[^\n]*(\n|$)/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

// → { ok: true, empty, items: { id: value }, wrapped } or { ok: false, reason }.
export function omarchyParse(text) {
  const stripped = stripJsonc(text);
  if (!stripped.trim()) return { ok: true, empty: true, items: {}, wrapped: false };
  let parsed;
  try { parsed = JSON.parse(stripped); } catch (e) { return { ok: false, reason: `Omarchy cannot read it (${e.message})` }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "it is not a JSON object" };
  const wrapped = Boolean(parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items));
  const source = wrapped ? parsed.items : parsed;
  const items = {};
  for (const [id, entry] of Object.entries(source)) if (entry && typeof entry === "object" && !Array.isArray(entry)) items[id] = entry;
  return { ok: true, empty: false, items, wrapped };
}

// ---------------------------------------------------------------------------
// Where the block goes. Only files that pass omarchyParse get here, so the
// only comments are whole lines; strings are skipped as tokens.

function tokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out.push({ type: "string", start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if ("{}[]:,".includes(c)) { out.push({ type: c, start: i, end: i + 1 }); i++; continue; }
    let j = i + 1;
    while (j < text.length && !/[\s{}[\]:,"]/.test(text[j])) j++;
    out.push({ type: "value", start: i, end: j });
    i = j;
  }
  return out;
}

// The object the items live in: its closing brace, and the token before it.
function target(text, wrapped) {
  const t = tokens(text);
  const close = new Map();
  const stack = [];
  t.forEach((tok, k) => {
    if (tok.type === "{" || tok.type === "[") stack.push(k);
    else if (tok.type === "}" || tok.type === "]") close.set(stack.pop(), k);
  });
  let open = 0;
  if (wrapped) {
    // The last top-level "items" key whose value is an object (JSON.parse
    // keeps the last of duplicate keys).
    for (let k = 1; k < close.get(0);) {
      if (t[k].type === "string" && t[k + 1]?.type === ":") {
        const v = k + 2;
        if (t[v].type === "{" && JSON.parse(text.slice(t[k].start, t[k].end)) === "items") open = v;
        k = (close.has(v) ? close.get(v) : v) + 1;
      } else k++;
    }
  }
  const end = close.get(open);
  return { closeAt: t[end].start, prev: t[end - 1] };
}

// → { text, inserted, comma } with the block added, or null when the file's
// shape is not one setup can edit.
export function insertBlock(text, blockText) {
  const parsed = omarchyParse(text);
  if (!parsed.ok) return null;
  if (parsed.empty) return { text: `{\n${blockText}}\n`, inserted: blockText, comma: false, created: true };
  const { closeAt, prev } = target(text, parsed.wrapped);
  // At the start of the closing brace's line when it stands alone there,
  // else just before the brace, on a line of its own.
  const lineStart = text.lastIndexOf("\n", closeAt - 1) + 1;
  const alone = lineStart > prev.end && /^[ \t]*$/.test(text.slice(lineStart, closeAt));
  const at = alone ? lineStart : closeAt;
  const inserted = alone ? blockText : `\n${blockText}`;
  let out = text.slice(0, at) + inserted + text.slice(at);
  const comma = prev.type !== "," && prev.type !== "{";
  if (comma) out = `${out.slice(0, prev.end)},${out.slice(prev.end)}`;
  return { text: out, inserted, comma, created: false };
}

// The block's exact bytes as they stand in `text`, or null when they are not
// there exactly once.
export function findInserted(text, inserted) {
  const at = text.indexOf(inserted);
  return at >= 0 && text.indexOf(inserted, at + 1) < 0 ? at : null;
}

// → the text without the block (and without the comma setup added, when the
// block is still the last entry), or null when the block was changed.
export function removeBlock(text, record) {
  const at = findInserted(text, record.inserted);
  if (at === null) return null;
  let out = text.slice(0, at) + text.slice(at + record.inserted.length);
  if (record.comma) {
    const t = tokens(out);
    const next = t.find((tok) => tok.start >= at);
    const prev = t.filter((tok) => tok.end <= at).pop();
    if (next?.type === "}" && prev?.type === ",") out = out.slice(0, prev.start) + out.slice(prev.end);
  }
  return out;
}

// The block in `text` replaced by a new one, keeping where it stands.
export function replaceBlock(text, record, blockText) {
  const at = findInserted(text, record.inserted);
  if (at === null) return null;
  const inserted = record.inserted.replace(record.block, () => blockText);
  return { text: text.slice(0, at) + inserted + text.slice(at + record.inserted.length), inserted };
}

// The block's rows as written: plain JSON, one row per line (JSON.stringify
// leaves no newline in a value), not Omarchy's reading of them.
export function blockRows(blockText) {
  const rows = blockText.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  return JSON.parse(`{${rows.map((l) => l.replace(/,$/, "")).join(",")}}`);
}

// The user's own items that use an id of ours: the block would override
// them, so setup leaves the file alone. `userText` is the file without the
// block.
export function conflicts(userText) {
  const parsed = omarchyParse(userText);
  return parsed.ok ? IDS.filter((id) => Object.hasOwn(parsed.items, id)) : [];
}

// After an edit, Omarchy must read the same user items and every row of the
// block exactly as written. `userText` is the file without the block.
// → null, or what is wrong.
export function verifyEdit(userText, after, blockText) {
  const a = omarchyParse(userText);
  const b = omarchyParse(after);
  if (!b.ok) return `the edited file would not be readable by Omarchy: ${b.reason}`;
  const ours = blockRows(blockText);
  for (const [id, value] of Object.entries(a.ok ? a.items : {})) {
    if (JSON.stringify(b.items[id]) !== JSON.stringify(value)) return `the edit would change the menu item ${id}`;
  }
  for (const [id, value] of Object.entries(ours)) {
    if (JSON.stringify(b.items[id]) !== JSON.stringify(value)) return `Omarchy would not read the menu item ${id} as written`;
  }
  return null;
}
