// Quoting for every layer a command string passes through on Omarchy.
//
// A launch command written by setup is read up to three times:
//   1. by its outer reader: `sh -c` (a Hyprland exec, a menu action), a
//      desktop entry's Exec (parsed by GLib's gtk-launch), or Lua/hyprlang
//      source (the printed key snippet);
//   2. by omarchy-launch-or-focus, which runs `eval exec setsid <command>`;
//      omarchy-launch-or-focus-tui first joins its own arguments with spaces
//      into that one eval'd string.
// So an argument that reaches an Omarchy launcher is quoted for eval first
// (evalWord), and the result is quoted again for the outer reader.

export class UnsafeValueError extends Error {
  constructor(what, value, why) {
    super(`${what} ${JSON.stringify(value)} cannot be quoted safely: ${why}`);
    this.code = "E_UNSAFE_PATH";
    this.details = { what, value, why };
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;

// A path written into a generated file (the shim, the hook, a launcher): no
// single quote, no newline or other control character.
export function assertSafePath(what, value) {
  if (typeof value !== "string" || !value) throw new UnsafeValueError(what, value, "empty");
  if (CONTROL.test(value)) throw new UnsafeValueError(what, value, "it contains a newline or another control character");
  if (value.includes("'")) throw new UnsafeValueError(what, value, "it contains a single quote");
  return value;
}

// POSIX single quotes: the one form whose content the shell never reads.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

// One word for `sh -c` (and so for eval): bare when it needs no quoting,
// else double quotes when nothing inside them is special, else single quotes.
export function shellWord(value) {
  const text = String(value);
  if (BARE.test(text)) return text;
  if (!/["$`\\!\n\r]/.test(text)) return `"${text}"`;
  return shellQuote(text);
}

// A word for omarchy-launch-or-focus, which runs `eval exec setsid
// $LAUNCH_COMMAND` with the variable unquoted: before the eval, bash splits
// the command at whitespace, joins the pieces again with single spaces, and
// may glob them. So the word is single-quoted, and inside the quotes every
// character those steps would change (a run of spaces, any other whitespace,
// * ? [) is written as bash's $'\ooo' instead. A single space survives as is.
export function evalWord(value) {
  const text = String(value);
  if (BARE.test(text)) return text;
  const octal = (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`;
  const quoted = text.replace(/'/g, `'\\''`)
    .replace(/(?: {2,}|[\t\n\r\v\f*?[])+/g, (run) => `'$'${[...run].map(octal).join("")}''`);
  return `'${quoted}'`.replace(/^''(?=\$)|(?<=')''$/g, "");
}

// A command line from argv words, each already in final form.
export const joinWords = (words) => words.join(" ");

// Desktop Entry Exec (Desktop Entry Specification, "The Exec key"): an
// argument with a reserved character is double-quoted, and inside the quotes
// `"`, `` ` ``, `$` and `\` are backslash-escaped. A literal `%` is `%%`.
// The whole value is then a string value, whose own `\` escape doubles every
// backslash.
const DESKTOP_RESERVED = /[ \t\n"'\\><~|&;$*?#()`]/;
export function desktopExecArg(value) {
  const text = String(value);
  if (CONTROL.test(text)) throw new UnsafeValueError("Exec argument", text, "it contains a control character");
  const percent = text.replace(/%/g, "%%");
  if (!DESKTOP_RESERVED.test(percent)) return percent;
  return `"${percent.replace(/(["`$\\])/g, "\\$1")}"`;
}
export function desktopExec(argv) {
  return argv.map(desktopExecArg).join(" ").replace(/\\/g, "\\\\");
}

// Parses a Desktop Entry Exec value back to argv: the string-value escapes,
// then the quoting rules above. Field codes (%f %F %u %U %i %c %k and the
// deprecated ones) are removed; %% is a literal %.
export function parseDesktopExec(raw) {
  // GLib expands % codes over the whole value, quoted arguments included,
  // before it splits the arguments; so does this. A field code expands to
  // nothing; %% is a literal %, kept as a marker until the quotes are read.
  const PERCENT = "\u0000";
  const value = unescapeDesktopString(raw).replace(/%(.)/g, (_, c) => (c === "%" ? PERCENT : ""));
  const argv = [];
  let word = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === " " || c === "\t") {
      if (word !== null) { argv.push(word); word = null; }
      continue;
    }
    if (c === '"') {
      word ??= "";
      for (i++; i < value.length && value[i] !== '"'; i++) {
        if (value[i] === "\\" && i + 1 < value.length && /["`$\\]/.test(value[i + 1])) i++;
        word += value[i];
      }
      continue;
    }
    word = (word ?? "") + c;
  }
  if (word !== null) argv.push(word);
  return argv.map((a) => a.replaceAll(PERCENT, "%"));
}

// Desktop Entry string values: \s \n \t \r \\.
export function unescapeDesktopString(raw) {
  return String(raw).replace(/\\([sntr\\])/g, (_, c) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[c]);
}

// A Lua string literal (double-quoted, every byte that needs it escaped).
export function luaString(value) {
  return `"${String(value).replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, (c) => `\\${String(c.charCodeAt(0)).padStart(3, "0")}`)}"`;
}

// The last field of a hyprlang `bind` line: `#` starts a comment, so it is
// written `##`.
export function hyprlangValue(value) {
  if (/[\n\r]/.test(value)) throw new UnsafeValueError("hyprlang value", value, "it contains a newline");
  return String(value).replace(/#/g, "##");
}
