// The key block: setup's SUPER + O submap, appended to the end of the user's
// ~/.config/hypr/bindings.lua between two marker comments, after a separator
// (a blank line). --remove puts back the whole file only when it is exactly
// as --apply wrote it; otherwise it takes out the block's bytes alone and
// leaves every other byte, the separator included.
import { definesSubmap, normalizeCombo } from "./keys.mjs";

export const START = "-- >>> oats-omarchy (managed by setup; remove with setup --remove) >>>\n";
export const END = "-- <<< oats-omarchy <<<\n";

export const blockText = (snippet) => `${START}${snippet}${END}`;

// A blank line before the block; a file without a final newline gets one.
export function appendBlock(text, block) {
  const separator = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${text}${separator}${block}`, separator };
}

// Where the recorded block sits, byte for byte, once: its index, else null.
export function findBlock(text, block) {
  const at = text.indexOf(block);
  return at < 0 || text.indexOf(block, at + 1) >= 0 ? null : at;
}

// The text without the block. → null when the block was changed.
export function removeBlock(text, { block }) {
  const at = findBlock(text, block);
  return at === null ? null : text.slice(0, at) + text.slice(at + block.length);
}

// The block replaced by a new one, in place. → null when it was changed.
export function replaceBlock(text, { block }, next) {
  const at = findBlock(text, block);
  return at === null ? null : text.slice(0, at) + next + text.slice(at + block.length);
}

// The user's own text: the file without setup's block, when it is there.
export const outside = (text, rec) => (rec && findBlock(text, rec.block) !== null ? removeBlock(text, rec) : text);

// A bind or unbind of SUPER + O in the user's Lua (any spelling of the
// combo). → the call as written, or null.
export function bindsSuperO(text) {
  const call = /\b(?:o|hl)\s*\.\s*(?:bind|unbind)\s*\(\s*(["'])([^"'\n]*)\1/g;
  for (const m of String(text).matchAll(call)) {
    if (normalizeCombo(m[2]) === "SUPER + O") return m[0];
  }
  return null;
}

export const definesOats = (text) => definesSubmap(text, "oats");
