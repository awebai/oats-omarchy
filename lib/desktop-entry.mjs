// Reading and writing freedesktop desktop entries (.desktop files).
import { desktopExec, unescapeDesktopString } from "./quote.mjs";

// The [Desktop Entry] group's keys (raw values; localized keys left out).
export function readDesktopEntry(text) {
  const keys = {};
  let inGroup = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const group = /^\[(.+)\]\s*$/.exec(line);
    if (group) { inGroup = group[1] === "Desktop Entry"; continue; }
    if (!inGroup) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes("[")) continue;
    if (!(key in keys)) keys[key] = line.slice(eq + 1).trimStart();
  }
  return keys;
}

const escapeValue = (value) => String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");

// A desktop entry: `fields` in order, Exec given as argv.
export function renderDesktopEntry(fields) {
  const lines = ["[Desktop Entry]"];
  for (const [key, value] of fields) {
    lines.push(`${key}=${key === "Exec" ? desktopExec(value) : escapeValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

export const stringValue = unescapeDesktopString;
