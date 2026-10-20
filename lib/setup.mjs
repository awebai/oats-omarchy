// `setup --plan | --apply | --remove | --check`, the plugin's one command
// (bin/setup.mjs, started by the `setup` launcher at the plugin's root).
//
// --plan says what --apply would write and what it found; --apply writes
// exactly that, atomically, recording each path's prior state; --remove puts
// every recorded path back as it was; --check reports drift and always exits
// 0. --apply and --remove ask first in a terminal (or take --yes). The key is
// written into bindings.lua as a managed block (lib/bindings.mjs) after
// Hyprland verifies a copy (lib/verify.mjs); otherwise it is printed for the
// person to add. Setup also records the default UI, the TUI or the Desktop,
// which the menu's root row "OATS" and a right click on the bar icon open.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as bindings from "./bindings.mjs";
import * as deployments from "./deployments.mjs";
import * as discover from "./discover.mjs";
import * as files from "./files.mjs";
import { actionsOf, luaSnippet, OURS, parsePrint, planKeys, POP } from "./keys.mjs";
import * as menu from "./menu.mjs";
import { assertSafePath } from "./quote.mjs";
import { STATE_SCHEMA, atomicWrite, digest, makeDirs, readFileState, readState, removeEmptyDirs } from "./state.mjs";
import { failureText, run, which } from "./system.mjs";
import { verifyBindings } from "./verify.mjs";
import { attachPrefix, hasDetachFeature, listOf } from "./waiting.mjs";

// The plugin's directory: the launchers, menu and hook setup writes point
// into it, so it is the resolved path, as `omarchy plugin add` cloned it.
export const PLUGIN_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
const ICON = join(PLUGIN_DIR, "assets", "oats-256.png");
// The node setup recorded, beside its state: the `setup` launcher runs it
// when there is no node on PATH. One line, the absolute path.
export const NODE_FILE = "node";
// The bar widget's commands (files.pluginFile), beside the state too: the
// widget reads it, and without it shows setup has not run.
export const PLUGIN_FILE = "plugin.json";

export class SetupError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

export const USAGE = `usage: setup [--plan | --apply | --remove | --check] [--dir <deployment>] [--desktop <abs path to AppImage>] [--ui tui|desktop] [--yes] [--json]

  --plan     say what --apply would write, and what was found (the default; writes nothing)
  --apply    write the launcher entries, icons, shim, post-update hook and the oats menu
  --remove   put back exactly what was there before --apply
  --check    report what drifted since --apply (always exits 0)

  --dir      the OATS deployment (the directory with oats-local.yaml); by default
             the one at or above the working directory, else the one setup is applied for.
             Not needed with an OATS CLI that keeps this computer's list of deployments
             (\`oats deployments\`): the TUI, the Desktop, the menu and the bar widget then
             use every listed deployment, and --dir only checks that one is listed
  --ui       the default UI, tui or desktop: what OATS in SUPER + SPACE and a right
             click on the bar icon open. With both found and no --ui, --apply asks
             in a terminal, and needs --ui without one; with one found, it is that one
  --yes      --apply and --remove without asking; they ask in a terminal, and
             refuse without one unless --yes is given
`;

export function parseArgs(argv) {
  const out = { mode: null, desktop: null, json: false, dir: null, ui: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const mode = { "--plan": "plan", "--apply": "apply", "--remove": "remove", "--check": "check" }[a];
    if (mode) {
      if (out.mode && out.mode !== mode) throw new SetupError("E_BAD_ARGS", `choose one of --plan, --apply, --remove, --check (got --${out.mode} and ${a})`);
      out.mode = mode;
    } else if (a === "--json") out.json = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--desktop" || a === "--dir" || a === "--ui") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new SetupError("E_BAD_ARGS", `${a} needs a value`);
      out[a.slice(2)] = value;
    } else if (a.startsWith("--desktop=") || a.startsWith("--dir=") || a.startsWith("--ui=")) {
      const [flag, ...rest] = a.slice(2).split("=");
      out[flag] = rest.join("=");
    } else throw new SetupError("E_BAD_ARGS", `unknown argument: ${a}`);
  }
  out.mode ??= "plan";
  if (out.desktop !== null && out.mode !== "plan" && out.mode !== "apply") throw new SetupError("E_BAD_ARGS", "--desktop goes with --plan or --apply");
  if (out.ui !== null && !UIS.includes(out.ui)) throw new SetupError("E_BAD_ARGS", `--ui is tui or desktop (got ${JSON.stringify(out.ui)})`);
  if (out.ui !== null && out.mode !== "plan" && out.mode !== "apply") throw new SetupError("E_BAD_ARGS", "--ui goes with --plan or --apply");
  return out;
}

// ---------------------------------------------------------------------------
// Discovery and the desired files.

// The launch PATH, the node and the OATS CLI: what decides whether setup
// uses this computer's list of deployments (the CLI lists `deployments-list`).
function probe(env) {
  const launch = discover.launchEnvironment(env);
  const node = discover.node(env);
  const kernel = discover.kernel(env, launch, node.node);
  return { launch, node, kernel, list: kernel.ok && deployments.listed(kernel.features) };
}

function gather(env, args, p, state, pre = probe(env)) {
  const { launch, node, kernel, list } = pre;
  const deployment = list ? readList(env, args, pre) : findDeployment(args, state);
  // Setup is for one deployment, or for the list: another single deployment
  // must be removed first; the list replaces a single one, and back.
  const other = !list && typeof state?.deployment === "string" && state.deployment !== deployment.path ? state.deployment : null;
  const found = discover.features(launch);
  const ours = new Set((state && !other ? state.files : []).map((f) => f.path));
  const desktop = discover.desktop(p, { flag: args.desktop, ours });
  return {
    env, deployment, other, node, kernel, ui: args.ui, plugin: discover.pluginDir(p, PLUGIN_DIR), launch, features: found,
    tmux: which("tmux", launch.path),
    fuse: discover.fuse(env),
    desktop,
    menuDefaults: discover.menuDefaults(launch),
    layout: discover.layout(p),
    print: discover.printBindings(env, launch),
    userText: discover.userHyprText(p),
  };
}

function findDeployment(args, state) {
  const d = discover.deployment({ dir: args.dir, recorded: state?.deployment || null });
  if (!d.ok) throw new SetupError("E_NO_DEPLOYMENT", `${d.reason}; ${d.fix}`, { fix: d.fix });
  return args.dirFrom ? { ...d, from: args.dirFrom } : d;
}

// With the list, setup is for no deployment of its own: `path` is null. It
// reads the list only to say what it holds (the kernel fills it; setup never
// writes it), and checks that --dir, when given, is a listed deployment.
// → { list: true, path: null, from, rows | reason, dir }.
function readList(env, args, pre) {
  let dir = null;
  if (args.dir !== null) {
    const d = discover.deployment({ dir: args.dir });
    if (!d.ok) throw new SetupError("E_NO_DEPLOYMENT", `${d.reason}; ${d.fix}`, { fix: d.fix });
    dir = d.path;
  }
  // As a launcher runs the CLI, and outside any instance home.
  const cliEnv = { HOME: env.HOME, PATH: pre.launch.path, ...(env.OATS_HOME_DIR ? { OATS_HOME_DIR: env.OATS_HOME_DIR } : {}) };
  const read = listOf(run(pre.node.node, [pre.kernel.cli, "deployments", "--json"], { env: cliEnv, cwd: env.HOME, timeoutMs: 15_000 }));
  return { list: true, path: null, from: "this computer's list of deployments", ...(read.ok ? { rows: read.rows } : { reason: read.reason }), dir };
}

// No deployment found, and a terminal (--plan or --apply): ask for its path.
// Nothing is offered or taken by default; Enter alone stops, and
// E_NO_DEPLOYMENT follows as without a terminal.
function askDeployment(args, state, p, out, io, pre) {
  if (args.dir !== null || (args.mode !== "plan" && args.mode !== "apply") || pre?.list) return;
  if (discover.deployment({ recorded: state?.deployment || null }).ok) return;
  if (args.json || !(io.interactive ?? Boolean(process.stdin.isTTY && out.isTTY))) return;
  out.write("No OATS deployment here: no oats-local.yaml at or above the working directory, and no --dir.\n");
  for (;;) {
    out.write("Type the path of the deployment, the directory that holds oats-local.yaml (Enter to stop): ");
    const answer = String((io.ask ?? askLine)()).trim();
    if (!answer) return;
    const typed = discover.typedDeployment(answer, { cwd: process.cwd(), home: p.home });
    if (typed.ok) { args.dir = typed.path; args.dirFrom = "your answer"; return; }
    out.write(`${typed.reason}\n`);
  }
}

// Each part → { part, status: "ready" | "skipped", reason?, files[] }.
// Every path setup writes, by role. --remove touches no other path.
export function managedPaths(p) {
  return {
    shim: p.shim,
    "tui-entry": join(p.applications, `${files.TUI_ID}.desktop`),
    "tui-icon": join(p.iconDir, `${files.TUI_ID}.png`),
    "desktop-entry": join(p.applications, `${files.DESKTOP_ID}.desktop`),
    "desktop-icon": join(p.iconDir, `${files.DESKTOP_ID}.png`),
    hook: join(p.hookDir, "oats-omarchy.hook"),
    menu: p.menuFile,
    keys: join(p.hyprDir, "bindings.lua"),
  };
}

function desiredParts(facts, p, state) {
  const parts = [];
  const at = managedPaths(p);
  const skip = (part, reason) => parts.push({ part, status: "skipped", reason, files: [] });
  const appsMissing = discover.missing(facts.features, discover.FEATURES.apps);
  const hookMissing = discover.missing(facts.features, discover.FEATURES.hook);

  let kernelReason = facts.kernel.ok ? null : `the OATS CLI cannot be used: ${facts.kernel.reason}`;
  let safe = {};
  if (!kernelReason) {
    try {
      safe = {
        node: assertSafePath("the node path", facts.node.node),
        cli: assertSafePath("the OATS CLI path", facts.kernel.cli),
        ...(facts.deployment.list ? {} : { deployment: assertSafePath("the deployment path", facts.deployment.path) }),
        shimPath: assertSafePath("the shim path", p.shim),
        pluginDir: assertSafePath("the plugin directory", facts.plugin.path),
      };
    } catch (e) { kernelReason = e.message; }
  }
  const spec = { shimPath: p.shim, deployment: facts.deployment.path };
  const recorded = { node: facts.node.node, pluginDir: facts.plugin.path, deployment: facts.deployment.path };
  const icon = readFileSync(ICON);

  // A: the TUI.
  if (kernelReason) skip("tui", kernelReason);
  else if (appsMissing.length) skip("tui", `not on ${facts.launch.featureSource}: ${appsMissing.join(", ")}`);
  else parts.push({ part: "tui", status: "ready", files: [
    { role: "tui-entry", path: at["tui-entry"], bytes: Buffer.from(files.tuiEntry(spec)), mode: 0o644 },
    { role: "tui-icon", path: at["tui-icon"], bytes: icon, mode: 0o644 },
  ] });

  // A: the Desktop.
  const d = facts.desktop;
  let desktopExec = null;
  if (appsMissing.length) skip("desktop", `not on ${facts.launch.featureSource}: ${appsMissing.join(", ")}`);
  else if (!d.source) skip("desktop", d.reason);
  else if (d.source === "entry") {
    desktopExec = d.appImage && !facts.fuse.ok ? discover.extractAndRun(d.exec, d.appImage) : d.exec;
    skip("desktop", `the existing launcher entry ${d.entry} provides it, so no entry is written; the key and the menu use its Exec${desktopExec !== d.exec ? " with --appimage-extract-and-run (libfuse2 is missing)" : ""}`);
  } else {
    let reason = null;
    try { assertSafePath("the AppImage path", d.appImage); if (!facts.deployment.list) assertSafePath("the deployment path", facts.deployment.path); } catch (e) { reason = e.message; }
    if (reason) skip("desktop", reason);
    else {
      desktopExec = [d.appImage, ...(facts.fuse.ok ? [] : ["--appimage-extract-and-run"]), ...(facts.deployment.list ? [] : ["--dir", facts.deployment.path])];
      parts.push({ part: "desktop", status: "ready", files: [
        { role: "desktop-entry", path: at["desktop-entry"], bytes: Buffer.from(files.desktopEntry({ execArgv: desktopExec })), mode: 0o644 },
        { role: "desktop-icon", path: at["desktop-icon"], bytes: icon, mode: 0o644 },
      ] });
    }
  }

  // The post-update hook.
  if (kernelReason) skip("hook", kernelReason);
  else if (hookMissing.length) skip("hook", `not on ${facts.launch.featureSource}: ${hookMissing.join(", ")}`);
  else parts.push({ part: "hook", status: "ready", files: [
    { role: "hook", path: at.hook, bytes: Buffer.from(files.hook(recorded)), mode: 0o755 },
  ] });

  // The default UI, then B: the oats submenu and the root row that opens it.
  const tuiReady = parts.some((x) => x.part === "tui" && x.status === "ready");
  const ui = chooseUi({ tui: tuiReady, desktop: Boolean(desktopExec), flag: facts.ui, recorded: state?.ui, reasons: parts });
  const blocks = blocksFor({ shimPath: p.shim, deployment: facts.deployment.path, node: facts.node.node, pluginDir: facts.plugin.path, tuiReady, desktopExec, ui: ui.ui });
  const menuMissing = discover.missing(facts.features, discover.FEATURES.menu);
  if (kernelReason) skip("menu", kernelReason);
  else if (!facts.menuDefaults.ok) skip("menu", `Omarchy's menu definition ${facts.menuDefaults.path} is not there`);
  else if (menuMissing.length) skip("menu", `not on ${facts.launch.featureSource}: ${menuMissing.join(", ")}`);
  else {
    const blockText = blocks.menu;
    const edit = menuEdit(p, state, blockText);
    if (edit.skip) skip("menu", edit.skip);
    else parts.push({ part: "menu", status: "ready", files: [{ role: "menu", kind: "block", path: at.menu, block: blockText, ...edit }] });
  }

  // C: the key, written into bindings.lua: SUPER + O into the oats submap.
  if (kernelReason) skip("keys", kernelReason);
  else {
    const blockText = blocks.keys;
    const edit = keysEdit(facts, p, state, blockText);
    if (edit.skip) skip("keys", edit.skip);
    else parts.push({ part: "keys", status: "ready", files: [{ role: "keys", kind: "append", path: at.keys, block: blockText, ...edit }] });
  }

  // The shim, when anything calls it (the key's T runs the TUI through it).
  if (parts.some((x) => x.status === "ready" && (x.part === "tui" || x.part === "hook" || x.part === "menu" || x.part === "keys"))) {
    parts.unshift({ part: "shim", status: "ready", files: [
      { role: "shim", path: at.shim, bytes: Buffer.from(files.shim(safe)), mode: 0o755 },
    ] });
  } else skip("shim", kernelReason || "no part that calls it is applied");

  // The bar widget's commands, when the shim they run through is applied.
  // The detach key goes in when the CLI setup checked lists the feature; a
  // re-apply picks up a CLI that gained it.
  const plugin = parts.some((x) => x.part === "shim" && x.status === "ready") ? files.pluginFile({
    deployment: facts.deployment.path,
    tui: tuiReady ? files.tuiArgv(spec) : null,
    desktop: desktopExec ? files.desktopArgv(desktopExec) : null,
    ui: ui.ui,
    waiting: menu.waitingArgv(recorded),
    attach: attachPrefix({ shim: p.shim, detachKey: hasDetachFeature(facts.kernel.features) }),
    setup: files.setupArgv(recorded),
  }) : null;

  return {
    parts: sortParts(parts),
    tui: blocks.tui,
    desktop: blocks.desktop,
    desktopExec,
    ui,
    plugin,
  };
}

// The menu and key blocks this version writes, from what they launch: setup
// plans them from what it found, and --check rebuilds them from what its
// state recorded, so a block another version wrote shows as drift.
export function blocksFor({ shimPath, deployment, node, pluginDir, tuiReady, desktopExec, ui }) {
  const spec = { shimPath, deployment };
  const tui = tuiReady ? files.tuiCommand(spec) : null;
  const desktop = desktopExec ? files.desktopCommand(desktopExec) : null;
  const recorded = { node, pluginDir, deployment };
  return {
    tui, desktop,
    menu: menu.block({ ui, tui, desktop, waiting: menu.waitingAction(recorded), status: menu.statusAction({ ...spec, node, pluginDir }) }),
    keys: bindings.blockText(luaSnippet({ entry: "SUPER + O", submap: "oats", pop: { kind: "default", description: POP.description, command: POP.command }, tui, desktop })),
  };
}

// The default UI, "tui" or "desktop": what the menu's root row and a right
// click on the bar icon open. Only one found: that one. Both: --ui, else
// the one recorded, else none is chosen yet (`pending`; the TUI stands in
// until then), and --apply asks in a terminal and refuses without one.
// Neither: none. → { ui, from, found, pending }.
export const UIS = ["tui", "desktop"];
export const UI_NAMES = { tui: "the TUI", desktop: "the Desktop" };
export const UI_QUESTION = "Open which OATS first: TUI or Desktop? [TUI/desktop] ";
function chooseUi({ tui, desktop, flag, recorded, reasons }) {
  const found = UIS.filter((ui) => (ui === "tui" ? tui : desktop));
  if (flag && !found.includes(flag)) {
    const why = reasons.find((x) => x.part === flag && x.status === "skipped")?.reason;
    throw new SetupError("E_UI", `--ui ${flag}: setup has no OATS ${flag === "tui" ? "TUI" : "Desktop"} to open${why ? ` (${why})` : ""}${found.length ? `; pass --ui ${found[0]}` : ""}`, { found });
  }
  if (!found.length) return { ui: null, from: "neither the TUI nor the Desktop is set up", found, pending: false };
  if (found.length === 1) return { ui: found[0], from: "the only one set up", found, pending: false };
  if (flag) return { ui: flag, from: "--ui", found, pending: false };
  if (UIS.includes(recorded)) return { ui: recorded, from: "chosen at an earlier --apply", found, pending: false };
  return { ui: "tui", from: "not chosen yet", found, pending: true };
}

const PART_ORDER = ["shim", "tui", "desktop", "hook", "menu", "keys"];

// A file an edit is planned on, with the file a write goes to (`target`):
// applyFiles writes it only while it is still exactly this.
function readPlanned(path) {
  const disk = readFileState(path);
  if (disk) disk.target = editTarget(path, disk);
  return disk;
}

// The key block in bindings.lua → { action, bytes, mode, disk, edit } with
// action "write" | "current" | "modified", or { skip: reason }. Written only
// for the Lua layout, only over Omarchy's stock SUPER + O, and only after
// Hyprland verifies a copy of the config with the block added.
const PASTE = "paste the snippet below yourself";
function keysEdit(facts, p, state, blockText) {
  const path = managedPaths(p).keys;
  const rec = (state?.files || []).find((f) => f.kind === "append" && f.path === path);
  if (facts.layout.kind !== "lua") return { skip: `your bindings are in ${facts.layout.file} (the hyprlang layout), and setup writes the key only into bindings.lua: ${PASTE}` };
  let disk;
  try { disk = readPlanned(path); } catch (e) { return { skip: e.message }; }
  if (!disk) return rec ? { action: "modified", disk } : { skip: `${path} is not there: ${PASTE}` };
  const text = disk.bytes.toString("utf8");
  if (!Buffer.from(text).equals(disk.bytes)) return { skip: `${path} is not UTF-8 text` };
  let next;
  let separator;
  // Whether --remove may put the backup back whole: only while the file is
  // what setup wrote over it, its block alone added.
  let restorable = true;
  if (rec) {
    if (bindings.findBlock(text, rec.block) === null) return { action: "modified", disk };
    if (rec.block === blockText) return { action: "current", disk };
    const refused = keysRefusal(facts, p, bindings.outside(text, rec), { own: true });
    if (refused) return { skip: refused };
    next = bindings.replaceBlock(text, rec, blockText);
    separator = rec.separator;
    // Once the user has edited the file, the new block goes in beside those
    // edits, and the backup would take them out again.
    restorable = rec.restorable === true && digest(disk.bytes) === rec.digest;
  } else {
    if (text.includes(bindings.START.trim())) return { skip: `${path} already holds an oats-omarchy key block that setup has no record of: delete it, then run setup again` };
    const refused = keysRefusal(facts, p, text);
    if (refused) return { skip: refused };
    ({ text: next, separator } = bindings.appendBlock(text, blockText));
  }
  const hyprland = which("Hyprland", facts.env.PATH) || which("Hyprland", facts.launch.featurePath);
  if (!hyprland) return { skip: `Hyprland is not on PATH, so setup cannot verify the key block before writing it: ${PASTE}` };
  if (facts.preview) facts.keysVerifyPending = true;
  else {
    facts.keysVerifyRan = true;
    const verified = verifyBindings({ hyprland, p, env: facts.env, candidate: next });
    if (!verified.ok) return { skip: verified.reason };
  }
  return { action: "write", disk, bytes: Buffer.from(next), mode: disk.mode, edit: { block: blockText, separator, restorable } };
}

// Why setup leaves SUPER + O to the person, or null. Nothing is shadowed
// silently: every effective SUPER + O action must be Omarchy's stock pop-out
// (or, when setup updates its own block, the OATS entry that block binds),
// the user's bindings.lua outside setup's block must not bind it, and no
// user submap may be named oats. `text` is bindings.lua without setup's block.
function keysRefusal(facts, p, text, { own: update = false } = {}) {
  if (!facts.print.ok) return `setup could not read what SUPER + O does now (${facts.print.reason}), so it does not write the key: ${PASTE}`;
  const actions = [...new Set(actionsOf(parsePrint(facts.print.text), "SUPER + O"))];
  const allowed = update ? [POP.description, OURS] : [POP.description];
  const others = actions.filter((a) => !allowed.includes(a));
  if (!actions.length || others.length) {
    const now = !actions.length ? "is not bound," : `runs ${others.map((a) => `"${a}"`).join(" and ")}${actions.includes(POP.description) ? " as well as" : ", not"}`;
    return `SUPER + O ${now} Omarchy's stock "${POP.description}" (${POP.command}); setup does not replace it, so it does not write the key: adapt the snippet below`;
  }
  const own = bindings.bindsSuperO(text);
  if (own) return `your bindings.lua binds SUPER + O itself (${own}…); setup does not replace it, so it does not write the key: adapt the snippet below`;
  let names = [];
  try { names = readdirSync(p.hyprDir).filter((n) => n.endsWith(".lua")).sort(); } catch { /* no directory */ }
  for (const name of names) {
    let lua;
    try { lua = name === "bindings.lua" ? text : readFileSync(join(p.hyprDir, name), "utf8"); } catch { continue; }
    if (bindings.definesOats(lua)) return `your Hyprland config defines a submap named oats (in ${join(p.hyprDir, name)}); setup does not replace it, so it does not write the key: adapt the snippet below`;
  }
  return null;
}

// The menu file is edited, not replaced: setup adds its block and keeps the
// rest of the user's bytes. → { action, bytes, mode, disk, edit } with
// action "write" | "current" | "modified", or { skip: reason }. `edit` is
// what the state records to take the block out again.
function menuEdit(p, state, blockText) {
  const rec = (state?.files || []).find((f) => f.kind === "block" && f.path === p.menuFile);
  let disk;
  try { disk = readPlanned(p.menuFile); } catch (e) { return { skip: e.message }; }
  const text = disk ? disk.bytes.toString("utf8") : null;
  if (disk && !Buffer.from(text).equals(disk.bytes)) return { skip: `${p.menuFile} is not UTF-8 text` };
  if (rec) {
    if (text === null || menu.findInserted(text, rec.inserted) === null) return { action: "modified", disk };
    if (rec.block === blockText) return { action: "current", disk };
    const replaced = menu.replaceBlock(text, rec, blockText);
    const problem = menu.verifyEdit(menu.removeBlock(text, rec), replaced.text, blockText);
    if (problem) return { skip: problem };
    return { action: "write", disk, bytes: Buffer.from(replaced.text), mode: disk.mode, edit: { ...pickEdit(rec), inserted: replaced.inserted } };
  }
  if (text !== null && text.includes(menu.START.trim())) return { skip: `${p.menuFile} already holds an oats-omarchy block that setup has no record of: delete it, then run setup again` };
  const parsed = text === null ? { ok: true } : menu.omarchyParse(text);
  if (!parsed.ok) return { skip: `Omarchy cannot read ${p.menuFile} as it is (${parsed.reason}), so setup leaves it alone; fix it, then run setup again` };
  const clash = text === null ? [] : menu.conflicts(text);
  if (clash.length) return { skip: `${p.menuFile} has its own ${clash.join(", ")}, which the oats block would override` };
  const ins = menu.insertBlock(text ?? "", blockText);
  if (!ins) return { skip: `setup cannot place the oats block in ${p.menuFile} as it is written; it leaves the file alone` };
  const problem = menu.verifyEdit(text ?? "", ins.text, blockText);
  if (problem) return { skip: problem };
  const prior = text === null ? { state: "absent" } : ins.created ? { state: "text", text } : null;
  return { action: "write", disk, bytes: Buffer.from(ins.text), mode: disk ? disk.mode : 0o644, edit: { inserted: ins.inserted, comma: ins.comma, created: ins.created, ...(ins.created ? { skeleton: ins.skeleton } : {}), prior } };
}

const pickEdit = ({ inserted, comma, created, skeleton, prior }) => ({ inserted, comma, created, ...(skeleton !== undefined ? { skeleton } : {}), prior });

// The file a block edit writes: through a symlink to its target, so a
// dotfile manager's link stays a link.
const editTarget = (path, disk) => (disk?.link ? realpathSync(path) : path);
const sortParts = (parts) => [...parts].sort((a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part));

// Compares each desired file with what is on disk and in the state.
// → per file: "current" (already applied), "write" (absent, ours to update,
// or not ours: backed up first, and `replaces` says what it was), or
// "modified" (ours, changed since).
function classify(parts, state) {
  const recorded = new Map((state?.files || []).map((f) => [f.path, f]));
  for (const part of parts) {
    for (const file of part.files) {
      if (file.kind === "block" || file.kind === "append") continue;
      const disk = readFileState(file.path);
      const rec = recorded.get(file.path);
      file.recorded = rec || null;
      if (rec && (!disk || digest(disk.bytes) !== rec.digest)) file.action = "modified";
      else if (rec && disk.bytes.equals(file.bytes) && disk.mode === file.mode) file.action = "current";
      else file.action = "write";
      if (file.action === "write" && !rec && disk) file.replaces = disk.link ? "link" : "file";
      file.disk = disk;
    }
    if (part.status === "ready") {
      const actions = part.files.map((f) => f.action);
      part.status = actions.includes("modified") ? "modified" : actions.every((a) => a === "current") ? "already applied" : "will apply";
    }
  }
}

// ---------------------------------------------------------------------------
// The modes.

function keysFor(facts, desired, parts) {
  const desktopPart = parts.find((x) => x.part === "desktop");
  return planKeys({
    layout: facts.layout, print: facts.print, userText: facts.userText,
    tui: desired.tui, desktop: desired.desktop,
    desktopSkipped: desired.desktop ? null : desktopPart?.reason,
    isCommand: (text) => Boolean(which(text.split(/\s+/)[0], facts.launch.featurePath)),
  });
}

function fixes(facts) {
  const out = [];
  if (!facts.fuse.ok && facts.desktop.appImage && !facts.desktop.extracted) {
    const starts = facts.desktop.source === "entry"
      ? `the key and the menu start the AppImage your launcher entry ${facts.desktop.entry} runs with --appimage-extract-and-run (your entry is left as it is, and needs fuse2 to start)`
      : "the Desktop entry starts the AppImage with --appimage-extract-and-run";
    out.push({ fix: "sudo pacman -S fuse2", why: `libfuse2 is missing, so ${starts} (slower: it unpacks at every start). With fuse2 installed, run --apply again.` });
  }
  if (!facts.tmux) out.push({ fix: "sudo pacman -S tmux", why: `tmux is not on ${facts.launch.source === "session" ? "the user session's PATH" : "the launch PATH"}: the TUI and session attach need it.` });
  if (facts.desktop.fix) out.push({ fix: facts.desktop.fix, why: "to set up OATS Desktop too" });
  if (!facts.kernel.ok && facts.kernel.fix) out.push({ fix: facts.kernel.fix, why: facts.kernel.reason });
  return out;
}

function found(facts) {
  const d = facts.desktop;
  return {
    deployment: facts.deployment.list
      ? { list: true, from: facts.deployment.from, ...(facts.deployment.reason ? { reason: facts.deployment.reason } : { listed: facts.deployment.rows }) }
      : { path: facts.deployment.path, from: facts.deployment.from },
    node: { path: facts.node.node, ...(facts.node.warning ? { warning: facts.node.warning } : {}) },
    plugin: { dir: facts.plugin.path, inPlugins: facts.plugin.inPlugins },
    launchPath: { source: facts.launch.source, path: facts.launch.path, ...(facts.launch.reason ? { reason: facts.launch.reason } : {}) },
    kernel: facts.kernel,
    features: { on: facts.launch.featureSource, found: facts.features },
    tmux: facts.tmux,
    desktop: { source: d.source, ...(d.entry ? { entry: d.entry } : {}), ...(d.appImage ? { appImage: d.appImage } : {}), ...(d.others?.length ? { others: d.others } : {}), ...(d.reason ? { reason: d.reason } : {}) },
    libfuse2: facts.fuse,
    bindings: { format: facts.layout.kind, file: facts.layout.file, exists: facts.layout.exists, ...(facts.layout.both ? { note: "both bindings.lua and bindings.conf exist; Lua wins" } : {}) },
    keyCheck: facts.print.ok ? { ok: true } : { ok: false, reason: facts.print.reason },
    menu: { defaults: facts.menuDefaults.path, defaultsFound: facts.menuDefaults.ok },
  };
}

const publicUi = ({ ui, from, found, pending }) => ({ ui, from, found, ...(pending ? { pending: true } : {}) });

const publicParts = (parts) => parts.map(({ part, status, reason, files: fs }) => {
  const replaces = fs.filter((f) => f.replaces).map((f) => ({ path: f.path, existing: f.replaces }));
  return { part, status, ...(reason ? { reason } : {}), paths: fs.map((f) => f.path), ...(replaces.length ? { replaces } : {}) };
});

// `preview` is the plan an interactive --apply shows before it asks: the key
// block is not verified there but once, after the answer, right before it is
// written. A verification made before the question could not vouch for what
// Hyprland reads by the time it is written: the config may load files from
// anywhere, and its io.popen calls may run anything.
function planOrApply(env, args, p, state, { preview = false, pre } = {}) {
  const facts = gather(env, args, p, state, pre);
  facts.preview = preview;
  const { other } = facts;
  const desired = desiredParts(facts, p, state);
  classify(desired.parts, state);
  const keys = keysFor(facts, desired, desired.parts);
  const notes = [];
  if (facts.desktop.others?.length) notes.push(`More than one OATS Desktop AppImage was found; the newest, ${facts.desktop.appImage}, is used. Others: ${facts.desktop.others.join(", ")}. Pass --desktop <path> to choose.`);
  if (desired.desktopExec && facts.desktop.source !== "entry" && !facts.deployment.list) notes.push("A Desktop that is already running is focused, not switched to this deployment.");
  notes.push(...listNotes(facts, state));
  if (!facts.fuse.ok && facts.desktop.extracted) notes.push(`The launcher entry ${facts.desktop.entry} already runs the AppImage extracted (--appimage-extract-and-run), so it needs no libfuse2.`);
  if (other) notes.push(`Setup is applied for another deployment, ${other}: --apply refuses until \`setup --remove\` runs there.`);
  if (facts.node.warning) notes.push(`Node: ${facts.node.warning}.`);
  if (!facts.plugin.inPlugins) notes.push(`Setup runs from ${facts.plugin.path}, not from ~/.config/omarchy/plugins/: the menu and the hook it writes point at this clone, so keep it there.`);
  if (facts.keysVerifyPending) notes.push("Once you confirm, and before it writes the key block, setup runs Hyprland --verify-config on a temporary copy of your Hyprland config with the block; that runs the config's own commands (its io.popen calls), on the copy. If Hyprland refuses it, the key is not written and the rest is.");
  if (facts.keysVerifyRan) notes.push("To check the key block, setup ran Hyprland --verify-config on a temporary copy of your Hyprland config; that runs the config's own commands (its io.popen calls), on the copy.");
  if (desired.parts.some((x) => x.part === "keys" && x.status !== "skipped")) {
    notes.push("SUPER+O becomes a prefix; pop-out moves to SUPER+O, O.");
    notes.push("--remove deletes only the marked block; it restores the backup only if the file is byte-identical to what apply wrote.");
  }
  const result = {
    mode: args.mode, deployment: facts.deployment.path,
    parts: publicParts(desired.parts), ui: publicUi(desired.ui), found: found(facts), keys, fixes: fixes(facts), notes,
  };
  if (args.mode === "plan") return result;

  if (other) throw new SetupError("E_OTHER_DEPLOYMENT", `setup is applied for another deployment, ${other}; run \`setup --remove\` first`, { deployment: other });
  if (desired.ui.pending) throw new SetupError("E_UI_REQUIRED", "both the OATS TUI and OATS Desktop are set up, and setup cannot ask which opens first here: run setup --apply --ui tui|desktop", { found: desired.ui.found });
  const modified = desired.parts.flatMap((x) => x.files).filter((f) => f.action === "modified");
  if (modified.length) throw new SetupError("E_MODIFIED", `changed since setup wrote ${modified.length === 1 ? "it" : "them"}: ${modified.map((f) => f.path).join(", ")}; --apply leaves ${modified.length === 1 ? "it" : "them"} alone (--remove restores the rest)`, { paths: modified.map((f) => f.path) });
  const toWrite = desired.parts.flatMap((x) => x.files).filter((f) => f.action === "write");
  const pluginCurrent = !desired.plugin || Boolean(readFileState(join(p.stateDir, PLUGIN_FILE))?.bytes.equals(Buffer.from(desired.plugin)));
  if (!toWrite.length && pluginCurrent) return { ...result, written: [] };
  const written = applyFiles(toWrite, state, facts, desired, p);
  const warnings = refreshCaches(p, env);
  return {
    ...result,
    parts: publicParts(desired.parts).map((x) => ({ ...x, status: x.status === "will apply" ? "applied" : x.status })),
    written, warnings,
  };
}

// What the plan says about this computer's list of deployments.
function listNotes(facts, state) {
  const d = facts.deployment;
  const notes = [];
  if (!d.list) {
    if (state && state.deployment === null) notes.push(`Setup is applied for this computer's list of deployments, which this OATS CLI no longer keeps (it lacks the feature ${deployments.FEATURE}); --apply switches it to ${d.path} alone.`);
    return notes;
  }
  if (typeof state?.deployment === "string") notes.push(`Setup is applied for the deployment ${state.deployment} alone; --apply switches it to this computer's list of deployments.`);
  if (d.reason) notes.push(`This computer's list of deployments could not be read: ${d.reason}.`);
  else if (!d.rows.some((row) => row.state === "ok")) notes.push(`This computer's list holds no deployment yet: ${deployments.HOW_TO_LIST}.`);
  if (d.dir && !d.reason && !d.rows.some((row) => row.state === "ok" && row.path === d.dir)) notes.push(`${d.dir} is not in this computer's list of deployments: run \`oats deployments add ${d.dir}\`, or any oats command in it.`);
  return notes;
}

// A backup name nothing else uses: setup never overwrites a file it did not
// write, even in its own state directory.
function backupName(backupDir, role) {
  for (;;) {
    const name = `${role}-${randomBytes(6).toString("hex")}`;
    if (!existsSync(join(backupDir, name))) return name;
  }
}

// Writes the files, then the state. Every step that changes the disk
// registers its undo before the next step can fail; a failure rolls back what
// this run did, in reverse, and removes the directories it created.
function applyFiles(toWrite, state, facts, desired, p) {
  const stateFile = join(p.stateDir, "state.json");
  const backupDir = join(p.stateDir, "backup");
  const done = [];
  const createdStateDirs = [];
  const createdDirs = [];
  const records = new Map((state?.files || []).map((f) => [f.path, f]));
  try {
    makeDirs(backupDir, createdStateDirs);
    for (const file of toWrite) {
      if (file.kind === "append") {
        assertUnchanged(file);
        // Backed up as a whole, like every file setup writes; written
        // through a link to its target, like the menu file.
        const target = editTarget(file.path, file.disk);
        let prior = records.get(file.path)?.prior;
        if (!prior) {
          const name = backupName(backupDir, file.role);
          const backup = join(backupDir, name);
          atomicWrite(backup, file.disk.bytes, 0o600);
          done.push({ undo: () => unlinkSync(backup) });
          prior = { state: "file", backup: `backup/${name}`, mode: file.disk.mode, digest: digest(file.disk.bytes) };
        }
        const before = file.disk;
        atomicWrite(target, file.bytes, file.mode);
        done.push({ undo: () => atomicWrite(target, before.bytes, before.mode) });
        records.set(file.path, { path: file.path, role: file.role, kind: "append", block: file.edit.block, separator: file.edit.separator, restorable: file.edit.restorable, digest: digest(file.bytes), prior });
        continue;
      }
      if (file.kind === "block") {
        assertUnchanged(file);
        const target = editTarget(file.path, file.disk);
        const before = file.disk;
        makeDirs(dirname(target), createdDirs);
        atomicWrite(target, file.bytes, file.mode);
        done.push({ undo: () => (before ? atomicWrite(target, before.bytes, before.mode) : unlinkSync(target)) });
        records.set(file.path, { path: file.path, role: file.role, kind: "block", block: file.block, ...file.edit });
        continue;
      }
      let prior = file.recorded?.prior;
      if (!prior) {
        prior = { state: "absent" };
        if (file.disk?.link) prior = { state: "link", target: readlinkSync(file.path), digest: digest(file.disk.bytes) };
        else if (file.disk) {
          const name = backupName(backupDir, file.role);
          const backup = join(backupDir, name);
          atomicWrite(backup, file.disk.bytes, 0o600);
          done.push({ undo: () => unlinkSync(backup) });
          prior = { state: "file", backup: `backup/${name}`, mode: file.disk.mode, digest: digest(file.disk.bytes) };
        }
      }
      makeDirs(dirname(file.path), createdDirs);
      const before = file.disk;
      const beforeLink = before?.link ? readlinkSync(file.path) : null;
      // The rename in atomicWrite replaces a link itself; until it has
      // succeeded the path is untouched.
      atomicWrite(file.path, file.bytes, file.mode);
      done.push({ undo: () => restorePrior(file.path, before ? (beforeLink ? { state: "link", target: beforeLink } : { state: "bytes", bytes: before.bytes, mode: before.mode }) : { state: "absent" }) });
      records.set(file.path, { path: file.path, role: file.role, digest: digest(file.bytes), mode: file.mode, prior });
    }
    const previous = state || {};
    const next = {
      schemaVersion: STATE_SCHEMA,
      package: "oats-omarchy", version: pkg.version,
      deployment: facts.deployment.path,
      node: facts.node.node, cli: facts.kernel.cli, pluginDir: facts.plugin.path,
      desktop: facts.desktop.source ? { source: facts.desktop.source, ...(facts.desktop.entry ? { entry: facts.desktop.entry } : {}), ...(facts.desktop.program ? { program: facts.desktop.program } : {}), ...(facts.desktop.appImage ? { appImage: facts.desktop.appImage } : {}), exec: desired.desktopExec } : null,
      parts: desired.parts.filter((x) => x.files.length).map((x) => x.part),
      ui: desired.ui.ui,
      files: [...records.values()],
      dirs: [...new Set([...(previous.dirs || []), ...createdDirs])],
      stateDirs: [...new Set([...(previous.stateDirs || []), ...createdStateDirs])],
      // Backups a partial --remove kept for files it already restored: they
      // are deleted only when a --remove completes.
      ...(previous.backups?.length ? { backups: previous.backups } : {}),
    };
    const nodeFile = join(p.stateDir, NODE_FILE);
    const nodeBefore = readFileState(nodeFile);
    atomicWrite(nodeFile, Buffer.from(`${facts.node.node}\n`), 0o644);
    done.push({ undo: () => (nodeBefore ? atomicWrite(nodeFile, nodeBefore.bytes, nodeBefore.mode) : unlinkSync(nodeFile)) });
    if (desired.plugin) {
      const pluginFile = join(p.stateDir, PLUGIN_FILE);
      const pluginBefore = readFileState(pluginFile);
      atomicWrite(pluginFile, Buffer.from(desired.plugin), 0o644);
      done.push({ undo: () => (pluginBefore ? atomicWrite(pluginFile, pluginBefore.bytes, pluginBefore.mode) : unlinkSync(pluginFile)) });
    }
    atomicWrite(stateFile, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), 0o600);
    return toWrite.map((f) => f.path);
  } catch (e) {
    const rollbackErrors = [];
    for (const step of done.reverse()) { try { step.undo(); } catch (u) { rollbackErrors.push(u.message); } }
    removeEmptyDirs([...createdDirs, ...createdStateDirs]);
    throw new SetupError("E_APPLY_FAILED", `--apply failed and was rolled back: ${e.message}${rollbackErrors.length ? `; rollback also failed: ${rollbackErrors.join("; ")}` : ""}`, { written: [] });
  }
}

// An edited file is written only while it is exactly as it was planned on:
// a save made meanwhile (verifying the key block can take minutes) is
// neither overwritten nor missing from the backup.
function assertUnchanged(file) {
  const now = readPlanned(file.path);
  const was = file.disk;
  const same = !now ? !was : Boolean(was) && now.bytes.equals(was.bytes) && now.mode === was.mode && Boolean(now.link) === Boolean(was.link) && now.target === was.target;
  if (!same) throw new Error(`${file.path} changed while setup checked it, so setup leaves it alone: run setup --apply again`);
}

// `backup` is the checked backup file of a "file" prior.
function restorePrior(path, prior, backup) {
  if (prior.state === "absent") { try { unlinkSync(path); } catch (e) { if (e.code !== "ENOENT") throw e; } return; }
  makeDirs(dirname(path));
  if (prior.state === "link") {
    // A new link beside the path, renamed over it: the path is never missing.
    const tmp = join(dirname(path), `.${basename(path)}.oats-omarchy-${randomBytes(6).toString("hex")}`);
    symlinkSync(prior.target, tmp);
    try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
    return;
  }
  const bytes = prior.state === "bytes" ? prior.bytes : readFileSync(backup);
  atomicWrite(path, bytes, prior.mode);
}

// update-desktop-database and gtk-update-icon-cache, only where the user's
// cache file already exists (they create it otherwise, and --remove could
// then not restore the tree exactly). Failures only warn.
function refreshCaches(p, env) {
  const warnings = [];
  const tools = [
    ["update-desktop-database", p.applications, "mimeinfo.cache", []],
    ["gtk-update-icon-cache", p.icons, "icon-theme.cache", ["-q", "-t"]],
  ];
  for (const [tool, dir, cache, flags] of tools) {
    if (!existsSync(join(dir, cache))) continue;
    const bin = which(tool, env.PATH);
    if (!bin) { warnings.push(`${tool} not found: ${join(dir, cache)} was not refreshed`); continue; }
    const r = run(bin, [...flags, dir], { env, timeoutMs: 30_000 });
    if (!r.ok) warnings.push(`${tool} ${dir}: ${failureText(r)}`);
  }
  return warnings;
}

// Setup's backup directory, when it is a directory in the state directory
// and not a link out of it. → its path, or null.
function backupDir(p) {
  const dir = join(p.stateDir, "backup");
  try { return lstatSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

// A backup as setup records it, `backup/<name>`, and nothing else. → the
// file in `dir`, which is the path --remove reads and deletes; or null.
function backupPath(backup, dir) {
  const m = typeof backup === "string" ? /^backup\/([^/]+)$/.exec(backup) : null;
  return m && dir && m[1] !== "." && m[1] !== ".." ? join(dir, m[1]) : null;
}

// Why --remove refuses a recorded file, or null. The state file sits in the
// user's state directory and may have been edited: --remove restores only
// the paths setup manages, from backups in its own backup directory.
function refusal(file, p, dir) {
  const managed = managedPaths(p);
  if (!file || typeof file.path !== "string" || managed[file.role] !== file.path) return `not a path setup manages${file?.role ? ` as ${file.role}` : ""}`;
  const prior = file.prior;
  if ((file.kind === "block") !== (file.role === "menu") || (file.kind === "append") !== (file.role === "keys")) return "not an entry setup records";
  if (file.role === "keys" && (typeof file.block !== "string" || !file.block.startsWith(bindings.START) || !file.block.endsWith(bindings.END) || !["", "\n", "\n\n"].includes(file.separator) || typeof file.restorable !== "boolean" || typeof file.digest !== "string" || prior?.state !== "file")) return "not a key block setup records";
  if (file.role === "menu") return (prior == null || prior.state === "absent" || (prior.state === "text" && typeof prior.text === "string")) ? null : "not a menu edit setup records";
  if (prior?.state === "absent" || (prior?.state === "link" && typeof prior.target === "string")) return null;
  if (prior?.state !== "file") return "its prior state is not one setup records";
  if (!dir) return `setup's backup directory ${join(p.stateDir, "backup")} is missing or is not a directory`;
  const backup = backupPath(prior.backup, dir);
  if (!backup) return `its backup ${JSON.stringify(prior.backup)} is not in ${dir}`;
  let st;
  try { st = lstatSync(backup); } catch { return `its backup ${backup} is missing`; }
  return st.isFile() ? null : `its backup ${backup} is not a regular file`;
}

function remove(env, args, p, state) {
  if (!state) return { mode: "remove", restored: [], message: "nothing to remove: setup is not applied" };
  // The deployment named here (--dir, or found from the working directory)
  // must be the one setup is applied for. With neither, --remove works on
  // the recorded one, even when that deployment is gone.
  // With the list, setup is for no deployment of its own.
  const here = typeof state.deployment === "string" ? discover.deployment({ dir: args.dir }) : { ok: false };
  if (args.dir !== null && typeof state.deployment === "string" && !here.ok) throw new SetupError("E_NO_DEPLOYMENT", `${here.reason}; ${here.fix}`, { fix: here.fix });
  if (here.ok && here.path !== state.deployment) {
    throw new SetupError("E_OTHER_DEPLOYMENT", `setup is applied for the deployment ${state.deployment}, not ${here.path} (from ${here.from}); nothing was removed. Run setup --remove --dir ${state.deployment}, or from outside ${here.path}`, { deployment: state.deployment });
  }
  const stateFile = join(p.stateDir, "state.json");
  const restored = [];
  const left = [];
  // Every entry is checked before anything is restored or deleted.
  const dir = backupDir(p);
  const refused = new Map(state.files.map((f) => [f, refusal(f, p, dir)]).filter(([, why]) => why));
  const backupsRefused = (state.backups || []).filter((b) => !backupPath(b, join(p.stateDir, "backup")));
  const ordered = [...state.files.filter((f) => f?.role !== "shim").reverse(), ...state.files.filter((f) => f?.role === "shim")];
  for (const file of ordered) {
    if (refused.has(file)) { left.push({ file, path: String(file?.path), why: refused.get(file), refused: true }); continue; }
    if (file.role === "shim" && (left.length || backupsRefused.length)) { left.push({ file, path: file.path, why: "kept until everything else is restored" }); continue; }
    if (file.kind === "block" || file.kind === "append") {
      if (file.kind === "block" ? removeEdit(file) : removeAppend(file, dir)) restored.push(file.path);
      else left.push({ file, path: file.path, why: "changed since setup wrote it", changed: true });
      continue;
    }
    const disk = readFileState(file.path);
    if (disk && digest(disk.bytes) !== file.digest) { left.push({ file, path: file.path, why: "changed since setup wrote it", changed: true }); continue; }
    if (!disk && file.prior.state === "absent") { restored.push(file.path); continue; }
    restorePrior(file.path, file.prior, file.prior.state === "file" ? backupPath(file.prior.backup, dir) : null);
    restored.push(file.path);
  }
  removeEmptyDirs(state.dirs || []);
  // Every backup setup made, including those of files a partial --remove
  // already restored: they are deleted only when everything is restored.
  const backups = [...new Set([...(state.backups || []), ...state.files.filter((f) => !refused.has(f) && f.prior?.state === "file").map((f) => f.prior.backup)])];
  const warnings = refreshCaches(p, env);
  if (left.length || backupsRefused.length) {
    const kept = { ...state, files: state.files.filter((f) => left.some((l) => l.file === f)), backups };
    atomicWrite(stateFile, Buffer.from(`${JSON.stringify(kept, null, 2)}\n`), 0o600);
    const details = { restored, left: left.map(({ path, why }) => ({ path, why })) };
    const changed = left.filter((l) => l.changed);
    const changedText = changed.length ? `left in place because ${changed.length === 1 ? "it was" : "they were"} changed since setup wrote ${changed.length === 1 ? "it" : "them"}: ${changed.map((l) => l.path).join(", ")}` : "";
    const bad = [...left.filter((l) => l.refused).map((l) => `${l.path}: ${l.why}`), ...backupsRefused.map((b) => `the backup ${JSON.stringify(b)}: not in ${join(p.stateDir, "backup")}`)];
    if (bad.length) {
      throw new SetupError("E_STATE_REFUSED", `${stateFile} has ${bad.length === 1 ? "an entry" : "entries"} --remove refuses, and nothing was restored or deleted for ${bad.length === 1 ? "it" : "them"}: ${bad.join("; ")}.${changedText ? ` Also ${changedText}.` : ""} Everything else was restored. Check ${stateFile}, then run --remove again.`, { ...details, refused: bad });
    }
    throw new SetupError("E_MODIFIED", `${changedText}. Everything else was restored. Restore or delete ${changed.length === 1 ? "it" : "them"} by hand, then run --remove again.`, details);
  }
  // Last, and only now: the backups setup recorded (anything else in the
  // state directory stays), the state, and the state directories it made.
  // Nothing is deleted through a backup directory that is not setup's own.
  for (const backup of dir ? backups : []) {
    try { unlinkSync(backupPath(backup, dir)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  for (const name of [NODE_FILE, PLUGIN_FILE]) {
    try { unlinkSync(join(p.stateDir, name)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  unlinkSync(stateFile);
  removeEmptyDirs(state.stateDirs || []);
  return { mode: "remove", restored, warnings };
}

// Takes the key block out of bindings.lua. A file exactly as --apply wrote it
// gets its backup back, mode included, unless the user's own edits were in
// the file when setup last rewrote its block (`restorable` false); otherwise
// only the block's bytes go, and every other byte stays, the separator setup
// added included. A file the user has since deleted has nothing of ours
// left. → false when the block was changed.
function removeAppend(file, dir) {
  const disk = readFileState(file.path);
  if (!disk) return true;
  const target = editTarget(file.path, disk);
  if (file.restorable && digest(disk.bytes) === file.digest) {
    atomicWrite(target, readFileSync(backupPath(file.prior.backup, dir)), file.prior.mode);
    return true;
  }
  const out = bindings.removeBlockBytes(disk.bytes, file);
  if (out === null) return false;
  atomicWrite(target, out, disk.mode);
  return true;
}

// Takes setup's block out of the menu file, leaving every other byte. The
// object setup added around the block goes too when nothing else is left in
// it (and the file, when setup created it); a file the user has since
// deleted has nothing of ours left. → false when the block was changed.
function removeEdit(file) {
  const disk = readFileState(file.path);
  if (!disk) return true;
  const out = menu.removeBlock(disk.bytes.toString("utf8"), file);
  if (out === null) return false;
  const target = editTarget(file.path, disk);
  if (file.created && out === (file.skeleton ?? menu.SKELETON)) {
    if (file.prior?.state === "text") atomicWrite(target, Buffer.from(file.prior.text), disk.mode);
    else unlinkSync(target);
  } else atomicWrite(target, Buffer.from(out), disk.mode);
  return true;
}

function check(env, args, p, state) {
  if (!state) return { mode: "check", applied: false, drift: [] };
  const drift = [];
  const again = "run setup --apply again";
  const has = (part) => (state.parts || []).includes(part);
  // The default UI as recorded; a state from before 0.5.0 has none, and
  // reads as the TUI, or the Desktop when only it is set up.
  const desktopExec = state.desktop?.exec ?? null;
  const both = has("tui") && Boolean(desktopExec);
  const ui = UIS.includes(state.ui) ? state.ui : has("tui") ? "tui" : desktopExec ? "desktop" : null;
  // The blocks this version would write for what setup recorded.
  let rebuilt = null;
  try {
    if (state.node && state.pluginDir) rebuilt = blocksFor({ shimPath: p.shim, deployment: state.deployment, node: state.node, pluginDir: state.pluginDir, tuiReady: has("tui"), desktopExec, ui });
  } catch { /* a state setup did not write: reported below */ }
  for (const file of state.files) {
    let disk;
    try { disk = readFileState(file.path); } catch (e) { drift.push(`${file.path}: ${e.message}`); continue; }
    if (file.kind === "append") {
      const text = disk ? disk.bytes.toString("utf8") : "";
      if (!disk) drift.push(`${file.path}, which holds the oats key block, is missing`);
      else if (bindings.removeBlockBytes(disk.bytes, file) !== null) { if (rebuilt && file.block !== rebuilt.keys) drift.push(`the oats key block in ${file.path} is from another version of setup: ${again}`); continue; }
      else if (!text.includes(bindings.START.trim())) drift.push(`the oats key block is missing from ${file.path}`);
      else drift.push(`the oats key block in ${file.path} changed since setup wrote it`);
      continue;
    }
    if (file.kind === "block") {
      if (!disk) drift.push(`${file.path}, which holds the oats menu, is missing`);
      else if (menu.findInserted(disk.bytes.toString("utf8"), file.inserted) === null) drift.push(`the oats block in ${file.path} changed since setup wrote it`);
      else if (rebuilt && file.block !== rebuilt.menu) drift.push(`the oats menu in ${file.path} is from another version of setup: ${again}`);
      continue;
    }
    if (!disk) drift.push(`${file.path} is missing`);
    else if (digest(disk.bytes) !== file.digest) drift.push(`${file.path} changed since setup wrote it`);
  }
  const single = typeof state.deployment === "string";
  if (single && !existsSync(state.deployment)) drift.push(`the deployment ${state.deployment} is gone`);
  const launch = discover.launchEnvironment(env);
  if (both && !UIS.includes(state.ui)) drift.push("default UI not chosen: run setup --apply --ui tui|desktop");
  // What the menu, the hook and the shim run: recorded at --apply, absolute.
  const nodeThere = Boolean(state.node) && existsSync(state.node);
  if (!nodeThere) drift.push(`the node setup recorded, ${state.node}, is gone: ${again}`);
  if (!state.cli || !existsSync(state.cli)) drift.push(`the OATS CLI setup recorded, ${state.cli}, is gone: ${again}`);
  else if (nodeThere) {
    const answer = discover.cliAnswer(state.node, state.cli, env, launch);
    if (!answer.ok) drift.push(`${answer.reason}: ${again}`);
    // The list arrived with an update of the CLI, or went with a downgrade.
    else if (single && deployments.listed(answer.features)) drift.push(`the OATS CLI now keeps this computer's list of deployments: run setup --apply again to use every listed deployment, not ${state.deployment} alone`);
    else if (!single && !deployments.listed(answer.features)) drift.push(`the OATS CLI no longer keeps this computer's list of deployments, which setup is applied for: run setup --apply --dir <deployment> again`);
  }
  const pluginFile = join(p.stateDir, PLUGIN_FILE);
  if (state.files.some((f) => f.role === "shim") && !existsSync(pluginFile)) drift.push(`the bar widget's ${pluginFile} is missing: ${again}`);
  if (!state.pluginDir) drift.push(`setup's state records no plugin directory: ${again}`);
  else if (!existsSync(join(state.pluginDir, "bin", "setup.mjs"))) drift.push(`the plugin directory setup recorded, ${state.pluginDir}, is gone: ${again}`);
  else if (state.pluginDir !== PLUGIN_DIR) drift.push(`setup is applied from the plugin directory ${state.pluginDir}, and this setup runs from ${PLUGIN_DIR}: ${again}`);
  // A path, or a name a found entry runs from the launch PATH.
  const present = (x) => (isAbsolute(x) ? existsSync(x) : Boolean(which(x, launch.featurePath)));
  const onPath = (x) => (isAbsolute(x) ? "" : ` from ${launch.featureSource}`);
  if (state.desktop?.appImage && !present(state.desktop.appImage)) drift.push(`the Desktop AppImage ${state.desktop.appImage} is gone${onPath(state.desktop.appImage)}`);
  if (state.desktop?.entry && !existsSync(state.desktop.entry)) drift.push(`the Desktop's launcher entry ${state.desktop.entry} is gone`);
  // The program a found entry runs, when it is not an AppImage (checked
  // above, as for every source).
  const program = state.desktop?.program;
  if (program && program !== state.desktop.appImage && !present(program)) drift.push(`the Desktop program ${program}, which the launcher entry ${state.desktop.entry} runs, is gone`);
  const found = discover.features(launch);
  const need = [...(has("tui") || has("desktop") ? discover.FEATURES.apps : []), ...(has("hook") ? discover.FEATURES.hook : []), ...(has("menu") ? discover.FEATURES.menu : [])];
  const gone = discover.missing(found, need);
  if (gone.length) drift.push(`Omarchy no longer offers ${gone.join(", ")} (on ${launch.featureSource})`);
  if (has("menu")) {
    const defaults = discover.menuDefaults(launch);
    if (!defaults.ok) drift.push(`Omarchy's menu definition ${defaults.path} is gone`);
  }
  // The deployment named here (--dir, or found from the working directory),
  // when there is one: setup is for one deployment at a time.
  const here = discover.deployment({ dir: args.dir });
  if (single && here.ok && here.path !== state.deployment) drift.push(`setup is applied for the deployment ${state.deployment}, not ${here.path}`);
  else if (!here.ok && args.dir !== null) drift.push(here.reason);
  return { mode: "check", applied: true, deployment: single ? state.deployment : null, drift };
}

// ---------------------------------------------------------------------------
// Entry point and output.

// `io` is for tests: { interactive, ask } stand in for the terminal.
export function setup(argv, env = process.env, out = process.stdout, err = process.stderr, io = {}) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { return fail(e, { json: argv.includes("--json") }, out, err, 2); }
  try {
    const p = discover.paths(env);
    const state = readState(join(p.stateDir, "state.json"));
    const pre = args.mode === "plan" || args.mode === "apply" ? probe(env) : null;
    askDeployment(args, state, p, out, io, pre);
    if ((args.mode === "apply" || (args.mode === "remove" && state)) && !args.yes) confirm(env, args, p, state, out, io, pre);
    let result;
    if (args.mode === "remove") result = remove(env, args, p, state);
    else if (args.mode === "check") result = check(env, args, p, state);
    else result = planOrApply(env, args, p, state, { pre });
    if (args.json) out.write(`${JSON.stringify({ ok: true, schemaVersion: 1, result })}\n`);
    else out.write(render(result));
    return 0;
  } catch (e) {
    if (args.mode === "check") {
      // The hook is advisory: --check reports and exits 0 whatever happened.
      if (args.json) out.write(`${JSON.stringify({ ok: true, schemaVersion: 1, result: { mode: "check", applied: null, drift: [`could not check: ${e.message}`] } })}\n`);
      else out.write(`oats-omarchy: could not check the setup: ${e.message}\n`);
      return 0;
    }
    return fail(e, args, out, err, 1);
  }
}

// --apply and --remove change files in the person's home: in a terminal they
// show what they will do and ask; without one (or with --json) they refuse
// unless --yes is given, as `omarchy plugin add` does.
function confirm(env, args, p, state, out, io, pre) {
  const interactive = io.interactive ?? (!args.json && Boolean(process.stdin.isTTY && out.isTTY));
  if (!interactive) throw new SetupError("E_CONFIRM", `refusing to --${args.mode} without confirmation: run it in a terminal, or pass --yes`);
  if (args.mode === "apply") {
    let plan = planOrApply(env, { ...args, mode: "plan" }, p, state, { preview: true, pre });
    if (plan.ui.pending) {
      args.ui = askUi(out, io);
      plan = planOrApply(env, { ...args, mode: "plan" }, p, state, { preview: true, pre });
    }
    out.write(render(plan));
  }
  else out.write(`setup --remove puts back what --apply changed, as it was before:\n${state.files.map((f) => `  ${f.path}${f.kind ? " (setup's block only)" : ""}\n`).join("")}`);
  out.write(`\n${args.mode === "apply" ? "Apply" : "Remove"} it? [y/N] `);
  const answer = (io.ask ?? askLine)();
  if (!/^y(es)?$/i.test(String(answer).trim())) throw new SetupError("E_CONFIRM", "aborted: nothing was changed");
}

// Both UIs set up and none chosen: which one opens first. Enter is the TUI.
function askUi(out, io) {
  for (;;) {
    out.write(UI_QUESTION);
    const answer = String((io.ask ?? askLine)()).trim().toLowerCase();
    if (answer === "" || answer === "t" || answer === "tui") return "tui";
    if (answer === "d" || answer === "desktop") return "desktop";
    out.write("Answer TUI or Desktop (Enter is TUI).\n");
  }
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

// One line from the terminal.
function askLine() {
  const bytes = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n;
    try { n = readSync(0, one, 0, 1, null); } catch (e) {
      // A non-blocking stdin with nothing typed yet: wait a little, don't spin.
      if (e.code === "EAGAIN") { Atomics.wait(PAUSE, 0, 0, 50); continue; }
      throw e;
    }
    if (n === 0 || one[0] === 0x0a) break;
    bytes.push(one[0]);
  }
  return Buffer.from(bytes).toString("utf8");
}

function fail(e, args, out, err, code) {
  const known = e instanceof SetupError || (typeof e.code === "string" && e.code.startsWith("E_"));
  const error = { code: known ? e.code : "E_INTERNAL", message: e.message, details: e.details || {} };
  if (args.json) out.write(`${JSON.stringify({ ok: false, error })}\n`);
  else err.write(`setup: ${e.message}\n${code === 2 ? USAGE : ""}`);
  return code;
}

// ---------------------------------------------------------------------------
// Text output, for people.

function listLine(d) {
  if (d.reason) return `${d.from}, which could not be read`;
  const ok = d.listed.filter((row) => row.state === "ok").length;
  return `${d.from} (\`oats deployments\`): ${d.listed.length} listed, ${ok} to read`;
}

function render(r) {
  if (r.mode === "check") return r.drift.map((d) => `oats-omarchy: ${d}\n`).join("");
  if (r.mode === "remove") {
    if (!r.restored.length && r.message) return `${r.message}\n`;
    return [`Removed. Restored ${r.restored.length} path(s) to what they were before --apply:`, ...r.restored.map((x) => `  ${x}`), ...(r.warnings || []).map((w) => `warning: ${w}`)].join("\n") + "\n";
  }
  const lines = [];
  lines.push(r.mode === "plan" ? "setup --plan (nothing was written)" : `setup --apply: ${r.written.length ? `wrote ${r.written.length} file(s)` : "already applied, nothing written"}`);
  lines.push("", "Parts");
  for (const x of r.parts) {
    lines.push(`  ${x.part.padEnd(8)} ${x.status}${x.reason ? `: ${x.reason}` : ""}`);
    for (const path of x.paths) {
      const existing = x.replaces?.find((r) => r.path === path)?.existing;
      lines.push(`           ${path}${existing === "file" ? " (replaces an existing file, backed up; --remove restores it)" : existing === "link" ? " (replaces an existing link; --remove restores it)" : ""}`);
    }
  }
  lines.push("", "Default UI");
  lines.push(r.ui.ui
    ? `  ${UI_NAMES[r.ui.ui]} (${r.ui.from}): OATS in SUPER + SPACE and a right click on the bar icon open it`
    : `  none (${r.ui.from})`);
  if (r.ui.pending) lines.push("  --apply asks which opens first, TUI unless you answer Desktop; or pass --ui tui|desktop");
  const f = r.found;
  if (r.mode === "plan") {
  lines.push("", "Found");
  lines.push(`  deployment  ${f.deployment.list ? listLine(f.deployment) : `${f.deployment.path} (from ${f.deployment.from})`}`);
  lines.push(`  plugin      ${f.plugin.dir}${f.plugin.inPlugins ? "" : " (a clone, not in ~/.config/omarchy/plugins)"}`);
  lines.push(`  node        ${f.node.path}${f.node.warning ? " (not a stable path: see Notes)" : ""}`);
  lines.push(`  oats CLI    ${f.kernel.ok ? `${f.kernel.cli}: ${f.kernel.version} (\`oats\` on PATH${f.kernel.via ? `, through ${f.kernel.via}` : ""}; runs with ${f.kernel.checkedWith})` : `refused: ${f.kernel.reason}`}`);
  lines.push(`  launchers   on ${f.features.on}`);
  for (const [name, path] of Object.entries(f.features.found)) lines.push(`              ${name}: ${path || "missing"}`);
  lines.push(`  tmux        ${f.tmux || "missing"}`);
  lines.push(`  desktop     ${f.desktop.source ? discover.describeDesktopSource(f.desktop) : f.desktop.reason}`);
  lines.push(`  libfuse2    ${f.libfuse2.ok ? `found (${f.libfuse2.via})` : `missing (${f.libfuse2.via})`}`);
  lines.push(`  bindings    ${f.bindings.file} (${f.bindings.format === "lua" ? "Lua" : "hyprlang"}${f.bindings.exists ? "" : ", not there yet"})${f.bindings.note ? `; ${f.bindings.note}` : ""}`);
  lines.push(`  key check   ${f.keyCheck.ok ? "omarchy menu keybindings --print" : `could not run: ${f.keyCheck.reason}`}`);
  lines.push(`  menu        ${f.menu.defaultsFound ? `Omarchy's menu definition ${f.menu.defaults}` : `no menu definition at ${f.menu.defaults}`}`);
  }
  const k = r.keys;
  const written = ["will apply", "applied", "already applied"].includes(r.parts.find((x) => x.part === "keys")?.status);
  lines.push("", "Keys");
  for (const note of k.notes) lines.push(`  ${note}`);
  if (k.snippet) {
    lines.push(written
      ? `  Setup writes this block at the end of ${k.file}, between the oats-omarchy markers; Hyprland reloads it on save:`
      : `  Paste this at the end of ${k.file}; Hyprland reloads it on save:`, "");
    lines.push(...k.snippet.trimEnd().split("\n").map((l) => `    ${l}`));
    if (k.fillIn) lines.push("", `  ${k.fillIn}`);
  }
  if (r.notes.length) { lines.push("", "Notes"); for (const n of r.notes) lines.push(`  ${n}`); }
  if (r.fixes.length) { lines.push("", "Fixes you can take"); for (const x of r.fixes) lines.push(`  ${x.fix}`, `    ${x.why}`); }
  if (r.warnings?.length) { lines.push("", "Warnings"); for (const w of r.warnings) lines.push(`  ${w}`); }
  if (r.mode === "plan") lines.push("", "Run `setup --apply` to write the parts marked \"will apply\"; `setup --remove` undoes it.");
  return `${lines.join("\n")}\n`;
}

