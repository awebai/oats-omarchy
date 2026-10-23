// The key block, appended to the end of the user's ~/.config/hypr/bindings.lua
// between two marker comments, after a separator (a blank line). It has up to
// two sections, each written only when its own checks pass: the SUPER + O
// submap, then the agent key (SUPER + SHIFT + CTRL + A), whose first line is
// AGENT_START. --remove puts back the whole file only when it is exactly as
// --apply wrote it; otherwise it takes out the block's bytes alone and leaves
// every other byte, the separator included.
import { definesSubmap, normalizeCombo } from "./keys.mjs";

export const START = "-- >>> oats-omarchy (managed by setup; remove with setup --remove) >>>\n";
export const END = "-- <<< oats-omarchy <<<\n";

export const blockText = (snippet) => `${START}${snippet}${END}`;
export const AGENT_START = "-- OATS: SUPER + SHIFT + CTRL + A ";

// The block from its sections, the submap first; null when both are empty.
export const composeBlock = ({ submap = "", agentKey = "" }) => (submap || agentKey ? blockText(submap + agentKey) : null);

// A recorded block's sections: everything from the agent key's first line
// on is that section, the rest the submap's (another version's included).
// → { submap, agentKey } ("" for one that is not there), or null for text
// that is not a block.
export function sections(block) {
  if (typeof block !== "string" || !block.startsWith(START) || !block.endsWith(END) || block.length < START.length + END.length) return null;
  const body = block.slice(START.length, block.length - END.length);
  const at = body.startsWith(AGENT_START) ? 0 : body.indexOf(`\n${AGENT_START}`) + 1;
  if (at === 0 && !body.startsWith(AGENT_START)) return { submap: body, agentKey: "" };
  return { submap: body.slice(0, at), agentKey: body.slice(at) };
}

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

// The same on the file's bytes, which need not all be UTF-8: every byte
// outside the block stays as it is. → null when the block was changed.
export function removeBlockBytes(bytes, { block }) {
  const needle = Buffer.from(block);
  const at = bytes.indexOf(needle);
  if (at < 0 || bytes.indexOf(needle, at + 1) >= 0) return null;
  return Buffer.concat([bytes.subarray(0, at), bytes.subarray(at + needle.length)]);
}

// The user's own text: the file without setup's block, when it is there.
export const outside = (text, rec) => (rec && findBlock(text, rec.block) !== null ? removeBlock(text, rec) : text);

// A bind or unbind of `combo` ("SUPER + O") in the user's Lua (any spelling
// of it). → the call as written, or null.
export function bindsCombo(text, combo) {
  const call = /\b(?:o|hl)\s*\.\s*(?:bind|unbind)\s*\(\s*(["'])([^"'\n]*)\1/g;
  for (const m of String(text).matchAll(call)) {
    if (normalizeCombo(m[2]) === combo) return m[0];
  }
  return null;
}

export const definesOats = (text) => definesSubmap(text, "oats");
