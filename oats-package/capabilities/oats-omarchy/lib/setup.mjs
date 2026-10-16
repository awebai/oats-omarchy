// `oats omarchy setup --plan | --apply | --remove | --check`.
//
// --plan says what --apply would write and what it found; --apply writes
// exactly that, atomically, recording each path's prior state; --remove puts
// every recorded path back as it was; --check reports drift and always exits
// 0. The key binding is printed, never written.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as discover from "./discover.mjs";
import * as files from "./files.mjs";
import { planKeys } from "./keys.mjs";
import { assertSafePath } from "./quote.mjs";
import { STATE_SCHEMA, atomicWrite, digest, makeDirs, readFileState, readState, removeEmptyDirs } from "./state.mjs";
import { failureText, run, which } from "./system.mjs";

const capabilityRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(capabilityRoot, "oats.json"), "utf8"));
const ICON = join(capabilityRoot, "assets", "oats-256.png");
const SOUL_NAME = /^[A-Za-z0-9._@:/-]+$/;

export class SetupError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

export const USAGE = `usage: oats omarchy setup [--plan | --apply | --remove | --check] [--desktop <abs path to AppImage>] [--json]

  --plan     say what --apply would write, and what was found (the default; writes nothing)
  --apply    write the launcher entries, icons, shim and post-update hook
  --remove   put back exactly what was there before --apply
  --check    report what drifted since --apply (always exits 0)
`;

export function parseArgs(argv) {
  const out = { mode: null, desktop: null, json: false, soul: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const mode = { "--plan": "plan", "--apply": "apply", "--remove": "remove", "--check": "check" }[a];
    if (mode) {
      if (out.mode && out.mode !== mode) throw new SetupError("E_BAD_ARGS", `choose one of --plan, --apply, --remove, --check (got --${out.mode} and ${a})`);
      out.mode = mode;
    } else if (a === "--json") out.json = true;
    else if (a === "--desktop" || a === "--soul") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new SetupError("E_BAD_ARGS", `${a} needs a value`);
      out[a.slice(2)] = value;
    } else if (a.startsWith("--desktop=") || a.startsWith("--soul=")) {
      const [flag, ...rest] = a.slice(2).split("=");
      out[flag] = rest.join("=");
    } else throw new SetupError("E_BAD_ARGS", `unknown argument: ${a}`);
  }
  out.mode ??= "plan";
  if (out.desktop !== null && out.mode !== "plan" && out.mode !== "apply") throw new SetupError("E_BAD_ARGS", "--desktop goes with --plan or --apply");
  return out;
}

// ---------------------------------------------------------------------------
// Discovery and the desired files.

function gather(env, args, p, state) {
  const deployment = discover.deployment(env);
  if (!deployment.ok) throw new SetupError("E_NO_DEPLOYMENT", deployment.reason);
  const soulId = env.OATS_SOUL_ID || null;
  const soul = discover.soulName(soulId);
  const launch = discover.launchEnvironment(env);
  const kernel = discover.kernel(env, launch);
  const found = discover.features(launch);
  const ours = new Set((state?.deployment === deployment.path ? state.files : []).map((f) => f.path));
  const desktop = discover.desktop(p, { flag: args.desktop, ours });
  return {
    deployment, soul, soulId, launch, kernel, features: found,
    tmux: which("tmux", launch.path),
    fuse: discover.fuse(env),
    desktop,
    layout: discover.layout(p),
    print: discover.printBindings(env, launch),
    userText: discover.userHyprText(p),
  };
}

// Each part → { part, status: "ready" | "skipped", reason?, files[] }.
function desiredParts(facts, p) {
  const parts = [];
  const skip = (part, reason) => parts.push({ part, status: "skipped", reason, files: [] });
  const appsMissing = discover.missing(facts.features, discover.FEATURES.apps);
  const hookMissing = discover.missing(facts.features, discover.FEATURES.hook);

  let kernelReason = facts.kernel.ok ? null : `the kernel does not run from a launcher: ${facts.kernel.reason}`;
  let safe = {};
  if (!kernelReason) {
    try {
      safe = {
        node: assertSafePath("OATS_NODE_BIN", facts.kernel.node),
        cli: assertSafePath("OATS_CLI_BIN", facts.kernel.cli),
        deployment: assertSafePath("the deployment path", facts.deployment.path),
        shimPath: assertSafePath("the shim path", p.shim),
      };
    } catch (e) { kernelReason = e.message; }
  }
  const spec = { shimPath: p.shim, deployment: facts.deployment.path };
  const icon = readFileSync(ICON);

  // A: the TUI.
  if (kernelReason) skip("tui", kernelReason);
  else if (appsMissing.length) skip("tui", `not on ${facts.launch.featureSource}: ${appsMissing.join(", ")}`);
  else parts.push({ part: "tui", status: "ready", files: [
    { role: "tui-entry", path: join(p.applications, `${files.TUI_ID}.desktop`), bytes: Buffer.from(files.tuiEntry(spec)), mode: 0o644 },
    { role: "tui-icon", path: join(p.iconDir, `${files.TUI_ID}.png`), bytes: icon, mode: 0o644 },
  ] });

  // A: the Desktop.
  const d = facts.desktop;
  let desktopExec = null;
  if (appsMissing.length) skip("desktop", `not on ${facts.launch.featureSource}: ${appsMissing.join(", ")}`);
  else if (!d.source) skip("desktop", d.reason);
  else if (d.source === "entry") {
    desktopExec = d.exec;
    skip("desktop", `the existing launcher entry ${d.entry} provides it, so no entry is written; the key and the menu use its Exec`);
  } else {
    let reason = null;
    try { assertSafePath("the AppImage path", d.appImage); assertSafePath("the deployment path", facts.deployment.path); } catch (e) { reason = e.message; }
    if (reason) skip("desktop", reason);
    else {
      desktopExec = [d.appImage, ...(facts.fuse.ok ? [] : ["--appimage-extract-and-run"]), "--dir", facts.deployment.path];
      parts.push({ part: "desktop", status: "ready", files: [
        { role: "desktop-entry", path: join(p.applications, `${files.DESKTOP_ID}.desktop`), bytes: Buffer.from(files.desktopEntry({ execArgv: desktopExec })), mode: 0o644 },
        { role: "desktop-icon", path: join(p.iconDir, `${files.DESKTOP_ID}.png`), bytes: icon, mode: 0o644 },
      ] });
    }
  }

  // The post-update hook.
  if (kernelReason) skip("hook", kernelReason);
  else if (hookMissing.length) skip("hook", `not on ${facts.launch.featureSource}: ${hookMissing.join(", ")}`);
  else if (!facts.soul || !SOUL_NAME.test(facts.soul)) skip("hook", facts.soulId ? `the soul id ${facts.soulId} does not give a --soul name` : "OATS_SOUL_ID is not set (the kernel sets it for oats >= 0.43.3)");
  else parts.push({ part: "hook", status: "ready", files: [
    { role: "hook", path: join(p.hookDir, "oats-omarchy.hook"), bytes: Buffer.from(files.hook({ ...spec, soul: facts.soul })), mode: 0o755 },
  ] });

  // The shim, when anything calls it.
  if (parts.some((x) => x.status === "ready" && (x.part === "tui" || x.part === "hook"))) {
    parts.unshift({ part: "shim", status: "ready", files: [
      { role: "shim", path: p.shim, bytes: Buffer.from(files.shim(safe)), mode: 0o755 },
    ] });
  } else skip("shim", kernelReason || "no part that calls it is applied");

  return {
    parts: sortParts(parts),
    tui: parts.some((x) => x.part === "tui" && x.status === "ready") ? files.tuiCommand(spec) : null,
    desktop: desktopExec ? files.desktopCommand(desktopExec) : null,
    desktopExec,
  };
}

const PART_ORDER = ["shim", "tui", "desktop", "hook"];
const sortParts = (parts) => [...parts].sort((a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part));

// Compares each desired file with what is on disk and in the state.
// → per file: "current" (already applied), "write" (absent, ours to update,
// or not ours: backed up first), or "modified" (ours, changed since).
function classify(parts, state) {
  const recorded = new Map((state?.files || []).map((f) => [f.path, f]));
  for (const part of parts) {
    for (const file of part.files) {
      const disk = readFileState(file.path);
      const rec = recorded.get(file.path);
      file.recorded = rec || null;
      if (rec && (!disk || digest(disk.bytes) !== rec.digest)) file.action = "modified";
      else if (rec && disk.bytes.equals(file.bytes) && disk.mode === file.mode) file.action = "current";
      else file.action = "write";
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
  if (!facts.fuse.ok && (facts.desktop.source === "appimage" || facts.desktop.source === "flag")) {
    out.push({ fix: "sudo pacman -S fuse2", why: "libfuse2 is missing, so the Desktop entry starts the AppImage with --appimage-extract-and-run (slower: it unpacks at every start). With fuse2 installed, run --apply again." });
  }
  if (!facts.tmux) out.push({ fix: "sudo pacman -S tmux", why: `tmux is not on ${facts.launch.source === "session" ? "the user session's PATH" : "the launch PATH"}: the TUI and session attach need it.` });
  if (facts.desktop.fix) out.push({ fix: facts.desktop.fix, why: "to set up OATS Desktop too" });
  return out;
}

function found(facts) {
  const d = facts.desktop;
  return {
    deployment: { path: facts.deployment.path, from: "OATS_TEAM_SCOPE" },
    soul: { name: facts.soul, from: facts.soulId ? `OATS_SOUL_ID ${facts.soulId}` : "not set" },
    launchPath: { source: facts.launch.source, path: facts.launch.path, ...(facts.launch.reason ? { reason: facts.launch.reason } : {}) },
    kernel: facts.kernel,
    features: { on: facts.launch.featureSource, found: facts.features },
    tmux: facts.tmux,
    desktop: { source: d.source, ...(d.entry ? { entry: d.entry } : {}), ...(d.appImage ? { appImage: d.appImage } : {}), ...(d.others?.length ? { others: d.others } : {}), ...(d.reason ? { reason: d.reason } : {}) },
    libfuse2: facts.fuse,
    bindings: { format: facts.layout.kind, file: facts.layout.file, exists: facts.layout.exists, ...(facts.layout.both ? { note: "both bindings.lua and bindings.conf exist; Lua wins" } : {}) },
    keyCheck: facts.print.ok ? { ok: true } : { ok: false, reason: facts.print.reason },
  };
}

const publicParts = (parts) => parts.map(({ part, status, reason, files: fs }) => ({ part, status, ...(reason ? { reason } : {}), paths: fs.map((f) => f.path) }));

function planOrApply(env, args, p, state) {
  const facts = gather(env, args, p, state);
  const other = state && state.deployment !== facts.deployment.path ? state.deployment : null;
  const desired = desiredParts(facts, p);
  classify(desired.parts, state);
  const keys = keysFor(facts, desired, desired.parts);
  const notes = [];
  if (facts.desktop.others?.length) notes.push(`More than one OATS Desktop AppImage was found; the newest, ${facts.desktop.appImage}, is used. Others: ${facts.desktop.others.join(", ")}. Pass --desktop <path> to choose.`);
  if (desired.desktopExec && facts.desktop.source !== "entry") notes.push("A Desktop that is already running is focused, not switched to this deployment.");
  if (other) notes.push(`Setup is applied for another deployment, ${other}: --apply refuses until \`oats omarchy setup --remove\` runs there.`);
  const result = {
    mode: args.mode, deployment: facts.deployment.path, soul: facts.soul,
    parts: publicParts(desired.parts), found: found(facts), keys, fixes: fixes(facts), notes,
  };
  if (args.mode === "plan") return result;

  if (other) throw new SetupError("E_OTHER_DEPLOYMENT", `setup is applied for another deployment, ${other}; run \`oats omarchy setup --remove\` there first`, { deployment: other });
  const modified = desired.parts.flatMap((x) => x.files).filter((f) => f.action === "modified");
  if (modified.length) throw new SetupError("E_MODIFIED", `changed since setup wrote ${modified.length === 1 ? "it" : "them"}: ${modified.map((f) => f.path).join(", ")}; --apply leaves ${modified.length === 1 ? "it" : "them"} alone (--remove restores the rest)`, { paths: modified.map((f) => f.path) });
  const toWrite = desired.parts.flatMap((x) => x.files).filter((f) => f.action === "write");
  if (!toWrite.length) return { ...result, written: [] };
  const written = applyFiles(toWrite, state, facts, desired, p);
  const warnings = refreshCaches(p, env);
  return {
    ...result,
    parts: publicParts(desired.parts).map((x) => ({ ...x, status: x.status === "will apply" ? "applied" : x.status })),
    written, warnings,
  };
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
      package: manifest.capability, version: manifest.version,
      deployment: facts.deployment.path, soul: facts.soul,
      node: facts.kernel.node, cli: facts.kernel.cli,
      desktop: facts.desktop.source ? { source: facts.desktop.source, ...(facts.desktop.entry ? { entry: facts.desktop.entry } : {}), ...(facts.desktop.program ? { program: facts.desktop.program } : {}), ...(facts.desktop.appImage ? { appImage: facts.desktop.appImage } : {}), exec: desired.desktopExec } : null,
      parts: desired.parts.filter((x) => x.files.length).map((x) => x.part),
      files: [...records.values()],
      dirs: [...new Set([...(previous.dirs || []), ...createdDirs])],
      stateDirs: [...new Set([...(previous.stateDirs || []), ...createdStateDirs])],
    };
    atomicWrite(stateFile, Buffer.from(`${JSON.stringify(next, null, 2)}\n`), 0o600);
    return toWrite.map((f) => f.path);
  } catch (e) {
    const rollbackErrors = [];
    for (const step of done.reverse()) { try { step.undo(); } catch (u) { rollbackErrors.push(u.message); } }
    removeEmptyDirs([...createdDirs, ...createdStateDirs]);
    throw new SetupError("E_APPLY_FAILED", `--apply failed and was rolled back: ${e.message}${rollbackErrors.length ? `; rollback also failed: ${rollbackErrors.join("; ")}` : ""}`, { written: [] });
  }
}

function restorePrior(path, prior, stateDir) {
  if (prior.state === "absent") { try { unlinkSync(path); } catch (e) { if (e.code !== "ENOENT") throw e; } return; }
  makeDirs(dirname(path));
  if (prior.state === "link") {
    // A new link beside the path, renamed over it: the path is never missing.
    const tmp = join(dirname(path), `.${basename(path)}.oats-omarchy-${randomBytes(6).toString("hex")}`);
    symlinkSync(prior.target, tmp);
    try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
    return;
  }
  const bytes = prior.state === "bytes" ? prior.bytes : readFileSync(join(stateDir, prior.backup));
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

function remove(env, p, state) {
  if (!state) return { mode: "remove", restored: [], message: "nothing to remove: setup is not applied" };
  const stateFile = join(p.stateDir, "state.json");
  const restored = [];
  const left = [];
  const ordered = [...state.files.filter((f) => f.role !== "shim").reverse(), ...state.files.filter((f) => f.role === "shim")];
  for (const file of ordered) {
    if (file.role === "shim" && left.length) { left.push({ ...file, why: "kept until everything else is restored" }); continue; }
    const disk = readFileState(file.path);
    if (disk && digest(disk.bytes) !== file.digest) { left.push({ ...file, why: "changed since setup wrote it" }); continue; }
    if (!disk && file.prior.state === "absent") { restored.push(file.path); continue; }
    restorePrior(file.path, file.prior, p.stateDir);
    restored.push(file.path);
  }
  removeEmptyDirs(state.dirs || []);
  // The backups of what was restored; a file left in place keeps its own.
  // Only backups setup recorded are deleted: anything else in the state
  // directory is left as it is.
  for (const file of state.files) {
    if (!file.prior?.backup || !restored.includes(file.path)) continue;
    try { unlinkSync(join(p.stateDir, file.prior.backup)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  const warnings = refreshCaches(p, env);
  if (left.length) {
    const kept = { ...state, files: state.files.filter((f) => left.some((l) => l.path === f.path)) };
    atomicWrite(stateFile, Buffer.from(`${JSON.stringify(kept, null, 2)}\n`), 0o600);
    const changed = left.filter((l) => l.why.startsWith("changed"));
    throw new SetupError("E_MODIFIED", `left in place because ${changed.length === 1 ? "it was" : "they were"} changed since setup wrote ${changed.length === 1 ? "it" : "them"}: ${changed.map((l) => l.path).join(", ")}. Everything else was restored. Restore or delete ${changed.length === 1 ? "it" : "them"} by hand, then run --remove again.`, { restored, left: left.map(({ path, why }) => ({ path, why })) });
  }
  unlinkSync(stateFile);
  removeEmptyDirs(state.stateDirs || []);
  return { mode: "remove", restored, warnings };
}

function check(env, p, state) {
  if (!state) return { mode: "check", applied: false, drift: [] };
  const drift = [];
  for (const file of state.files) {
    let disk;
    try { disk = readFileState(file.path); } catch (e) { drift.push(`${file.path}: ${e.message}`); continue; }
    if (!disk) drift.push(`${file.path} is missing`);
    else if (digest(disk.bytes) !== file.digest) drift.push(`${file.path} changed since setup wrote it`);
  }
  if (!existsSync(state.deployment)) drift.push(`the deployment ${state.deployment} is gone`);
  for (const [what, path] of [["node", state.node], ["the OATS CLI", state.cli]]) if (path && !existsSync(path)) drift.push(`${what} ${path} is gone`);
  if (state.desktop?.appImage && !existsSync(state.desktop.appImage)) drift.push(`the Desktop AppImage ${state.desktop.appImage} is gone`);
  if (state.desktop?.entry && !existsSync(state.desktop.entry)) drift.push(`the Desktop's launcher entry ${state.desktop.entry} is gone`);
  const launch = discover.launchEnvironment(env);
  // The program a found entry runs: a path, or a name on the launch PATH.
  const program = state.desktop?.program;
  if (program && !(isAbsolute(program) ? existsSync(program) : which(program, launch.featurePath))) drift.push(`the Desktop program ${program}, which the launcher entry ${state.desktop.entry} runs, is gone`);
  const found = discover.features(launch);
  const need = [...((state.parts || []).some((x) => x === "tui" || x === "desktop") ? discover.FEATURES.apps : []), ...((state.parts || []).includes("hook") ? discover.FEATURES.hook : [])];
  const gone = discover.missing(found, need);
  if (gone.length) drift.push(`Omarchy no longer offers ${gone.join(", ")} (on ${launch.featureSource})`);
  if (env.OATS_TEAM_SCOPE && env.OATS_TEAM_SCOPE !== state.deployment) drift.push(`setup is applied for the deployment ${state.deployment}, not ${env.OATS_TEAM_SCOPE}`);
  const soul = discover.soulName(env.OATS_SOUL_ID);
  if (soul && state.soul && soul !== state.soul) drift.push(`setup is applied for soul ${state.soul}, not ${soul}`);
  return { mode: "check", applied: true, deployment: state.deployment, soul: state.soul, drift };
}

// ---------------------------------------------------------------------------
// Entry point and output.

export function setup(argv, env = process.env, out = process.stdout, err = process.stderr) {
  let args;
  try { args = parseArgs(argv); }
  catch (e) { return fail(e, { json: argv.includes("--json") }, out, err, 2); }
  try {
    const p = discover.paths(env);
    const state = readState(join(p.stateDir, "state.json"));
    let result;
    if (args.mode === "remove") result = remove(env, p, state);
    else if (args.mode === "check") result = check(env, p, state);
    else result = planOrApply(env, args, p, state);
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

function fail(e, args, out, err, code) {
  const known = e instanceof SetupError || (typeof e.code === "string" && e.code.startsWith("E_"));
  const error = { code: known ? e.code : "E_INTERNAL", message: e.message, details: e.details || {} };
  if (args.json) out.write(`${JSON.stringify({ ok: false, error })}\n`);
  else err.write(`oats omarchy setup: ${e.message}\n${code === 2 ? USAGE : ""}`);
  return code;
}

// ---------------------------------------------------------------------------
// Text output, for people.

function render(r) {
  if (r.mode === "check") return r.drift.map((d) => `oats-omarchy: ${d}\n`).join("");
  if (r.mode === "remove") {
    if (!r.restored.length && r.message) return `${r.message}\n`;
    return [`Removed. Restored ${r.restored.length} path(s) to what they were before --apply:`, ...r.restored.map((x) => `  ${x}`), ...(r.warnings || []).map((w) => `warning: ${w}`)].join("\n") + "\n";
  }
  const lines = [];
  lines.push(r.mode === "plan" ? "oats omarchy setup --plan (nothing was written)" : `oats omarchy setup --apply: ${r.written.length ? `wrote ${r.written.length} file(s)` : "already applied, nothing written"}`);
  lines.push("", "Parts");
  for (const x of r.parts) {
    lines.push(`  ${x.part.padEnd(8)} ${x.status}${x.reason ? `: ${x.reason}` : ""}`);
    for (const path of x.paths) lines.push(`           ${path}`);
  }
  const f = r.found;
  if (r.mode === "plan") {
  lines.push("", "Found");
  lines.push(`  deployment  ${f.deployment.path} (from ${f.deployment.from})`);
  lines.push(`  soul        ${f.soul.name || "unknown"} (from ${f.soul.from})`);
  lines.push(`  kernel      ${f.kernel.ok ? `${f.kernel.node} ${f.kernel.cli}: ${f.kernel.version} (runs with ${f.kernel.checkedWith})` : `refused: ${f.kernel.reason}`}`);
  lines.push(`  launchers   on ${f.features.on}`);
  for (const [name, path] of Object.entries(f.features.found)) lines.push(`              ${name}: ${path || "missing"}`);
  lines.push(`  tmux        ${f.tmux || "missing"}`);
  lines.push(`  desktop     ${f.desktop.source ? discover.describeDesktopSource(f.desktop) : f.desktop.reason}`);
  lines.push(`  libfuse2    ${f.libfuse2.ok ? `found (${f.libfuse2.via})` : `missing (${f.libfuse2.via})`}`);
  lines.push(`  bindings    ${f.bindings.file} (${f.bindings.format === "lua" ? "Lua" : "hyprlang"}${f.bindings.exists ? "" : ", not there yet"})${f.bindings.note ? `; ${f.bindings.note}` : ""}`);
  lines.push(`  key check   ${f.keyCheck.ok ? "omarchy menu keybindings --print" : `could not run: ${f.keyCheck.reason}`}`);
  }
  const k = r.keys;
  lines.push("", `Keys (shown, never written)`);
  for (const note of k.notes) lines.push(`  ${note}`);
  if (k.snippet) {
    lines.push(`  Paste this at the end of ${k.file}; Hyprland reloads it on save:`, "");
    lines.push(...k.snippet.trimEnd().split("\n").map((l) => `    ${l}`));
    if (k.fillIn) lines.push("", `  ${k.fillIn}`);
  }
  if (r.notes.length) { lines.push("", "Notes"); for (const n of r.notes) lines.push(`  ${n}`); }
  if (r.fixes.length) { lines.push("", "Fixes you can take"); for (const x of r.fixes) lines.push(`  ${x.fix}`, `    ${x.why}`); }
  if (r.warnings?.length) { lines.push("", "Warnings"); for (const w of r.warnings) lines.push(`  ${w}`); }
  if (r.mode === "plan") lines.push("", "Run `oats omarchy setup --apply` to write the parts marked \"will apply\"; `--remove` undoes it.");
  return `${lines.join("\n")}\n`;
}

