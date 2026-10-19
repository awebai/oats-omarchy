// The key binding, as a snippet in the user's config format: setup writes its
// Lua form into bindings.lua over Omarchy's stock SUPER + O (lib/bindings.mjs)
// and prints it otherwise. SUPER + O enters a submap where T opens the TUI, D
// the Desktop, and O again runs what SUPER + O ran before (Omarchy's "Pop
// window out").
import { hyprlangValue, luaString } from "./quote.mjs";

export const POP = { description: "Pop window out (float & pin)", command: "omarchy-hyprland-window-pop" };
export const OURS = "OATS";
// The bindings omarchy-menu-keybindings adds itself; without a running
// Hyprland they are all --print prints, and it still exits 0.
export const STATIC_ACTIONS = new Set(["Copy URL from Web App", "Download Video from Web App"]);
export const onlyStatic = (binds) => binds.every((b) => STATIC_ACTIONS.has(b.action));
const MOD_ORDER = ["SUPER", "SHIFT", "CTRL", "ALT"];

// "SUPER SHIFT + o" | "SUPER + SHIFT + O" → "SUPER + SHIFT + O".
export function normalizeCombo(text) {
  const parts = String(text).trim().split(/\s*\+\s*|\s+/).filter(Boolean).map((p) => p.toUpperCase());
  const key = parts.pop() || "";
  const mods = [...new Set(parts.map((m) => (m === "CONTROL" ? "CTRL" : m)))]
    .sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, key].join(" + ");
}

// `omarchy menu keybindings --print` lines ("SUPER SHIFT + F    → File manager")
// → [{ combo, action }], each combo and action once (it prints some twice).
export function parsePrint(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text).split("\n")) {
    const arrow = line.indexOf("→");
    if (arrow < 0) continue;
    const combo = line.slice(0, arrow).trim();
    const action = line.slice(arrow + 1).trim();
    if (!combo || !action) continue;
    const normalized = normalizeCombo(combo);
    const id = `${normalized}\u0000${action}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ combo: normalized, action });
  }
  return out;
}

const actionsOf = (binds, combo) => binds.filter((b) => b.combo === combo).map((b) => b.action);

// A submap named `name` in the user's own Hyprland files (Lua or hyprlang).
export function definesSubmap(text, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`define_submap\\s*\\(\\s*["']${n}["']|^\\s*submap\\s*=\\s*${n}\\s*(,|$)`, "m").test(String(text));
}

// What SUPER + O does now, from --print. `isCommand(text)` tells a command
// (shown when a bind has no description) from a description.
export function currentPop(binds, isCommand) {
  const actions = actionsOf(binds, "SUPER + O");
  if (!actions.length) return { kind: "unbound" };
  if (actions.includes(OURS)) return { kind: "ours" };
  if (actions.includes(POP.description)) return { kind: "default", description: POP.description, command: POP.command };
  const action = actions[0];
  return isCommand(action) ? { kind: "command", description: action, command: action } : { kind: "description", description: action };
}

// The entry key when SUPER + O cannot be used: SUPER + SHIFT + O if free,
// else the first free SUPER + <letter>.
export function nextFreeKey(binds) {
  const taken = new Set(binds.map((b) => b.combo));
  if (!taken.has("SUPER + SHIFT + O")) return "SUPER + SHIFT + O";
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!taken.has(`SUPER + ${letter}`)) return `SUPER + ${letter}`;
  return null;
}

// → { status, entry, submap, pop, notes[], fillIn, snippet, format, file }
//   status: "suggested" | "in-place" (the user's config already has our
//   binding) | "unchecked" (--print could not run; the default is suggested).
export function planKeys({ layout, print, userText = "", tui, desktop, desktopSkipped, isCommand = () => false }) {
  const notes = [];
  let entry = "SUPER + O";
  let submap = "oats";
  let pop = { kind: "default", description: POP.description, command: POP.command };
  let status = "suggested";

  if (!print?.ok) {
    status = "unchecked";
    notes.push(`The key check could not run (${print?.reason || "no --print output"}); this is the default snippet, for Omarchy's default bindings.`);
  } else {
    const binds = parsePrint(print.text);
    pop = currentPop(binds, isCommand);
    if (pop.kind === "ours") {
      return { status: "in-place", entry, submap, pop, notes: ["SUPER + O already opens the OATS submap (\"OATS\" in omarchy menu keybindings): the key is in place."], snippet: null, format: layout.kind, file: layout.file };
    }
    if (definesSubmap(userText, "oats")) {
      submap = "oats-omarchy";
      const free = nextFreeKey(binds);
      if (!free) return { status: "no-key", entry: null, submap, pop, notes: ["Your Hyprland config already defines a submap named oats, and no SUPER + <letter> is free: no key is suggested."], snippet: null, format: layout.kind, file: layout.file };
      entry = free;
      pop = { kind: "kept" };
      notes.push(`Your Hyprland config already defines a submap named oats, so SUPER + O is left alone: the suggested entry key is ${entry}, the next free one, into a submap named ${submap}.`);
    } else if (pop.kind === "unbound") {
      notes.push("SUPER + O is not bound, so there is no double-tap action.");
    } else if (pop.kind === "command") {
      notes.push(`SUPER + O runs \`${pop.command}\` (not Omarchy's default "${POP.description}"). The submap keeps it: SUPER + O, then O runs it.`);
    } else if (pop.kind === "description") {
      notes.push(`SUPER + O runs "${pop.description}" (not Omarchy's default "${POP.description}"). --print shows its description, not its command, so the double-tap lines are commented out: put the command SUPER + O runs into them and uncomment them, or pressing SUPER + O twice does nothing.`);
    }
  }

  if (!tui) notes.push("The TUI part is skipped, so the T lines are left out.");
  if (!desktop) notes.push(`The D lines are left out: ${desktopSkipped || "the Desktop part is skipped"}.`);
  if (entry === "SUPER + O" && (pop.kind === "default" || pop.kind === "command" || pop.kind === "description")) {
    notes.push("The cost: popping a window out becomes two taps, SUPER + O then O (or SUPER + O twice).");
  }

  const spec = { entry, submap, pop, tui, desktop };
  const snippet = layout.kind === "conf" ? confSnippet(spec) : luaSnippet(spec);
  return { status, entry, submap, pop, notes, snippet, format: layout.kind, file: layout.file, fillIn: pop.kind === "description" ? `Fill in the command SUPER + O runs ("${pop.description}") in the two commented double-tap lines, then uncomment them.` : null };
}

const PLACEHOLDER = "<the command SUPER + O ran>";
const keyLetter = (combo) => combo.split(" + ").pop();
const comboParts = (combo) => {
  const parts = combo.split(" + ");
  const key = parts.pop();
  return { mods: parts.join(" "), key };
};

function headline({ entry, pop, tui, desktop }) {
  const opens = [tui ? "T (TUI)" : null, desktop ? "D (Desktop)" : null].filter(Boolean).join(" or ");
  const again = entry === "SUPER + O" && (pop.kind === "default" || pop.kind === "command") ? `; ${keyLetter(entry)} again ${pop.kind === "default" ? "pops the window out" : "runs what SUPER + O ran"}` : "";
  return `OATS: ${entry}, then ${opens || "nothing (both parts are skipped)"}${again}.`;
}

function popLines(spec) {
  if (spec.entry !== "SUPER + O") return [];
  const { pop } = spec;
  if (pop.kind === "default" || pop.kind === "command") {
    const name = pop.kind === "default" ? "Pop window out" : pop.description;
    return [["O", name, pop.command, false], ["SUPER + O", name, pop.command, false]];
  }
  if (pop.kind === "description") return [["O", pop.description, PLACEHOLDER, true], ["SUPER + O", pop.description, PLACEHOLDER, true]];
  return [];
}

function innerBinds(spec) {
  const binds = [];
  if (spec.tui) binds.push(["T", "OATS TUI", spec.tui, false], ["SUPER + T", "OATS TUI", spec.tui, false]);
  if (spec.desktop) binds.push(["D", "OATS Desktop", spec.desktop, false], ["SUPER + D", "OATS Desktop", spec.desktop, false]);
  return [...binds, ...popLines(spec)];
}

export function luaSnippet(spec) {
  const lines = [`-- ${headline(spec)}`];
  if (spec.entry === "SUPER + O" && spec.pop.kind !== "unbound") lines.push(`hl.unbind(${luaString("SUPER + O")})`);
  lines.push(`o.bind(${luaString(spec.entry)}, ${luaString(OURS)}, hl.dsp.submap(${luaString(spec.submap)}))`);
  lines.push(`hl.define_submap(${luaString(spec.submap)}, "reset", function()`);
  const inner = innerBinds(spec);
  if (spec.pop.kind === "description") lines.push(`  -- SUPER + O ran "${spec.pop.description.replace(/\n/g, " ")}": put its command in the next two lines and uncomment them.`);
  for (const [keys, description, command, commented] of inner) {
    lines.push(`  ${commented ? "-- " : ""}o.bind(${luaString(keys)}, ${luaString(description)}, ${luaString(command)})`);
  }
  lines.push(`  hl.bind("escape", hl.dsp.submap("reset"))`);
  lines.push(`  hl.bind("catchall", hl.dsp.submap("reset"))`);
  lines.push("end)");
  return `${lines.join("\n")}\n`;
}

export function confSnippet(spec) {
  const e = comboParts(spec.entry);
  const lines = [`# ${headline(spec)}`];
  if (spec.entry === "SUPER + O" && spec.pop.kind !== "unbound") lines.push("unbind = SUPER, O");
  lines.push(`bindd = ${e.mods}, ${e.key}, ${OURS}, submap, ${spec.submap}`);
  lines.push(`submap = ${spec.submap}, reset`);
  if (spec.pop.kind === "description") lines.push(`# SUPER + O ran "${spec.pop.description.replace(/\n/g, " ")}": put its command in the next two lines and uncomment them.`);
  for (const [keys, description, command, commented] of innerBinds(spec)) {
    const k = comboParts(keys);
    lines.push(`${commented ? "# " : ""}bindd = ${k.mods}, ${k.key}, ${description.replace(/[,#\n]/g, " ")}, exec, ${hyprlangValue(command)}`);
  }
  lines.push("bind = , escape, submap, reset");
  lines.push("bind = , catchall, submap, reset");
  lines.push("submap = reset");
  return `${lines.join("\n")}\n`;
}
