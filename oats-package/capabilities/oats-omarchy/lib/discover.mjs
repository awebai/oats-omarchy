// Discovery: what setup finds on this machine, and where it found it. It
// never assumes a path, and it changes nothing (one exception, kept away from
// the user's files: `omarchy menu keybindings --print` writes a cache, so it
// runs with a temporary XDG_CACHE_HOME that is removed afterwards).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readDesktopEntry } from "./desktop-entry.mjs";
import { onlyStatic, parsePrint } from "./keys.mjs";
import { parseDesktopExec } from "./quote.mjs";
import { failureText, isExecutableFile, run, sessionEnvironment, which } from "./system.mjs";

export const DESKTOP_CLASS = "awebai-oats-desktop";
export const APPIMAGE = /oats[-_ ]?desktop.*\.appimage$/i;
export const MINIMAL_PATH = "/usr/local/bin:/usr/bin:/bin";
export const FEATURES = {
  apps: ["omarchy-launch-or-focus-tui", "omarchy-launch-or-focus", "uwsm-app"],
  hook: ["omarchy-hook"],
  menu: ["omarchy-menu-select", "omarchy-launch-floating-terminal-with-presentation"],
};
// `oats omarchy waiting` notifies with it when there is nothing to pick, and
// writes to stderr only without it: reported, not required.
export const NOTIFY = "omarchy-notification-send";
export const OMARCHY_PATH = "/usr/share/omarchy";

const absolute = (value) => (typeof value === "string" && isAbsolute(value) ? value : null);

// The directories setup works in, from HOME and the XDG variables. Omarchy's
// menu and hook runner read $HOME/.config and ignore XDG_CONFIG_HOME, so the
// Omarchy and Hyprland paths hang off HOME.
export function paths(env) {
  const home = absolute(env.HOME);
  if (!home) throw Object.assign(new Error("HOME is not set to an absolute path"), { code: "E_NO_HOME" });
  const dataHome = absolute(env.XDG_DATA_HOME) || join(home, ".local", "share");
  const stateHome = absolute(env.XDG_STATE_HOME) || join(home, ".local", "state");
  const dataDirs = String(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter((d) => absolute(d));
  return {
    home, dataHome, stateHome, dataDirs,
    applications: join(dataHome, "applications"),
    icons: join(dataHome, "icons", "hicolor"),
    iconDir: join(dataHome, "icons", "hicolor", "256x256", "apps"),
    shim: join(dataHome, "oats-omarchy", "oats"),
    stateDir: join(stateHome, "oats-omarchy"),
    hyprDir: join(home, ".config", "hypr"),
    hookDir: join(home, ".config", "omarchy", "hooks", "post-update.d"),
    menuFile: join(home, ".config", "omarchy", "extensions", "omarchy-menu.jsonc"),
  };
}

// The soul as `--soul` names it, from OATS_SOUL_ID: `<repoKey>#<soul>` is
// the member soul `<repoKey>/<soul>`, `package:<id>#<soul>` the package soul
// `<id>/<soul>`. Both forms name exactly one soul.
export function soulName(soulId) {
  const id = String(soulId || "");
  const m = id.startsWith("package:") ? /^package:([^#]+)#([^#/]+)$/.exec(id) : /^([^#]+)#([^#/]+)$/.exec(id);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function deployment(env) {
  const scope = env.OATS_TEAM_SCOPE;
  if (!scope) return { ok: false, reason: "OATS_TEAM_SCOPE is not set: run this as `oats omarchy setup`, from an instance home or from the deployment with --soul" };
  if (!isAbsolute(scope)) return { ok: false, reason: `OATS_TEAM_SCOPE is not absolute: ${scope}` };
  try { if (!statSync(scope).isDirectory()) throw new Error("not a directory"); }
  catch { return { ok: false, path: scope, reason: `the deployment directory ${scope} does not exist` }; }
  return { ok: true, path: scope };
}

// The PATH a launch from the desktop gets: the running user session's, when
// it can be read, else a minimal one. Features are looked up on the session
// PATH when there is one, else on this command's own PATH.
export function launchEnvironment(env) {
  const session = sessionEnvironment(env.PATH, env);
  if (session.ok && session.env.PATH) {
    return {
      source: "session", path: session.env.PATH, featurePath: session.env.PATH, featureSource: "the user session's PATH (systemctl --user show-environment)",
      omarchyPath: absolute(session.env.OMARCHY_PATH) || absolute(env.OMARCHY_PATH) || OMARCHY_PATH,
    };
  }
  return {
    source: "minimal", path: MINIMAL_PATH, featurePath: env.PATH || MINIMAL_PATH,
    omarchyPath: absolute(env.OMARCHY_PATH) || OMARCHY_PATH,
    featureSource: "this command's PATH (no user session environment: " + (session.reason || "no PATH in it") + ")",
    reason: session.reason,
  };
}

// The kernel the generated launchers run: OATS_NODE_BIN + OATS_CLI_BIN, both
// absolute and existing, and able to answer --version in a launch-like
// environment (env -i HOME PATH).
export function kernel(env, launch) {
  const node = env.OATS_NODE_BIN;
  const cli = env.OATS_CLI_BIN;
  const base = { node: node || null, cli: cli || null, checkedWith: launch.source === "session" ? "the user session's PATH" : `the minimal PATH ${MINIMAL_PATH}` };
  for (const [name, value] of [["OATS_NODE_BIN", node], ["OATS_CLI_BIN", cli]]) {
    if (!value) return { ...base, ok: false, reason: `${name} is not set (the kernel sets it for oats >= 0.53.0)` };
    if (!isAbsolute(value)) return { ...base, ok: false, reason: `${name} is not absolute: ${value}` };
    if (!existsSync(value)) return { ...base, ok: false, reason: `${name} does not exist: ${value}` };
  }
  const r = run(node, [cli, "--version"], { env: { HOME: env.HOME, PATH: launch.path }, cwd: env.HOME, timeoutMs: 15_000 });
  if (!r.ok) return { ...base, ok: false, reason: `\`${node} ${cli} --version\` failed with ${base.checkedWith}: ${failureText(r)}` };
  return { ...base, ok: true, version: r.stdout.trim().split("\n")[0] };
}

export function features(launch) {
  const found = {};
  for (const name of [...FEATURES.apps, ...FEATURES.hook, ...FEATURES.menu, NOTIFY]) {
    found[name] = which(name, launch.featurePath);
  }
  return found;
}

export const missing = (found, names) => names.filter((name) => !found[name]);

// Omarchy's own menu definition, which the user's extension file extends:
// the menu feature is there only when it is.
export function menuDefaults(launch) {
  const path = join(launch.omarchyPath, "default", "omarchy", "omarchy-menu.jsonc");
  return { path, ok: existsSync(path) };
}

// libfuse2, which an AppImage needs to mount itself.
export function fuse(env) {
  const ldconfig = which("ldconfig", `${env.PATH || ""}:/usr/bin:/sbin:/usr/sbin`);
  if (ldconfig) {
    const r = run(ldconfig, ["-p"], { env, timeoutMs: 5_000 });
    if (r.ok && /\blibfuse\.so\.2\b/.test(r.stdout)) return { ok: true, via: "ldconfig -p" };
    if (r.ok) return { ok: false, via: "ldconfig -p" };
  }
  for (const dir of ["/usr/lib", "/usr/lib64", "/lib", "/lib64", "/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu"]) {
    if (existsSync(join(dir, "libfuse.so.2"))) return { ok: true, via: join(dir, "libfuse.so.2") };
  }
  return { ok: false, via: "the usual library directories" };
}

// An existing launcher entry for the Desktop: $XDG_DATA_HOME/applications,
// then each $XDG_DATA_DIRS/*/applications. `ours` lists entries setup wrote,
// which are not "existing".
// An entry's desktop file ID is its name; the first directory that has an
// ID decides it, so a user's Hidden=true copy hides the system's.
export function desktopEntries(p, ours = new Set()) {
  const found = [];
  const seen = new Set();
  for (const dir of [p.applications, ...p.dataDirs.map((d) => join(d, "applications"))]) {
    let names;
    try { names = readdirSync(dir).filter((n) => n.endsWith(".desktop")).sort(); } catch { continue; }
    for (const name of names) {
      const path = join(dir, name);
      if (seen.has(name)) continue;
      seen.add(name);
      if (ours.has(path)) continue;
      let keys;
      try { keys = readDesktopEntry(readFileSync(path, "utf8")); } catch { continue; }
      if (keys.Hidden === "true" || !keys.Exec) continue;
      const argv = parseDesktopExec(keys.Exec);
      const program = argv[0] === "env" ? argv.find((a, i) => i > 0 && !a.includes("=")) : argv[0];
      if (keys.StartupWMClass === DESKTOP_CLASS || (program && APPIMAGE.test(program))) found.push({ path, exec: argv, program: program || null });
    }
  }
  return found;
}

// AppImages in the usual places, depth <= 2. ~/.local/opt/oats-desktop is
// where the Desktop's own install puts it (OATS-Desktop.AppImage).
export function appImages(p) {
  const roots = [join(p.home, ".local", "opt", "oats-desktop"), join(p.home, "Applications"), join(p.home, ".local", "bin"), join(p.home, "Downloads"), "/opt"];
  const hits = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 2) visit(path, depth + 1); continue; }
      if (entry.name.endsWith(".bak") || !APPIMAGE.test(entry.name)) continue;
      try {
        const stat = statSync(path);
        if (stat.isFile()) hits.push({ path, mtimeMs: stat.mtimeMs, executable: isExecutableFile(path) });
      } catch { /* a dangling link is no candidate */ }
    }
  };
  for (const root of roots) visit(root, 1);
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

// The Desktop's standard install on Linux: the AppImage, executable, at
// ~/.local/opt/oats-desktop/OATS-Desktop.AppImage.
export const GET_DESKTOP = "Get OATS Desktop from https://github.com/awebai/oats/releases (oats-desktop-<version>-linux-x86_64.AppImage) and install it the standard way: save it as ~/.local/opt/oats-desktop/OATS-Desktop.AppImage, make it executable (chmod +x), and run setup again; or pass --desktop <path>.";

// The Desktop, in order: an existing entry, an AppImage in the usual places,
// or --desktop (which overrides both).
export function desktop(p, { flag, ours } = {}) {
  if (flag) {
    if (!isAbsolute(flag)) return { source: null, reason: `--desktop must be an absolute path: ${flag}` };
    if (!isExecutableFile(flag)) return { source: null, reason: `--desktop ${flag} is not an existing executable file` };
    return { source: "flag", appImage: flag, others: [] };
  }
  const entries = desktopEntries(p, ours);
  if (entries.length) {
    const [first, ...rest] = entries;
    // An entry that runs an AppImage (the Desktop's own install writes one)
    // is an AppImage too: it needs libfuse2 like any other.
    const appImage = first.program && isAbsolute(first.program) && APPIMAGE.test(first.program) ? first.program : null;
    // Without FUSE the user may have added --appimage-extract-and-run to
    // the entry's Exec already.
    const extracted = Boolean(appImage) && first.exec.includes("--appimage-extract-and-run");
    return { source: "entry", entry: first.path, exec: first.exec, program: first.program, ...(appImage ? { appImage, extracted } : {}), others: rest.map((e) => e.path) };
  }
  const images = appImages(p);
  if (!images.length) return { source: null, reason: `no OATS Desktop found (no launcher entry with StartupWMClass=${DESKTOP_CLASS} or an Exec that runs an OATS Desktop AppImage, no AppImage in ~/.local/opt/oats-desktop (the standard install, OATS-Desktop.AppImage), ~/Applications, ~/.local/bin, ~/Downloads or /opt)`, fix: GET_DESKTOP };
  const [newest, ...others] = images;
  if (!newest.executable) return { source: null, reason: `${newest.path} is not executable`, fix: `chmod +x '${newest.path}', then run setup again`, others: others.map((i) => i.path) };
  return { source: "appimage", appImage: newest.path, others: others.map((i) => i.path) };
}

// Which bindings file the user's Hyprland config uses.
export function layout(p) {
  const lua = join(p.hyprDir, "bindings.lua");
  const conf = join(p.hyprDir, "bindings.conf");
  const hasLua = existsSync(lua);
  const hasConf = existsSync(conf);
  if (hasLua) return { kind: "lua", file: lua, exists: true, both: hasConf };
  if (hasConf) return { kind: "conf", file: conf, exists: true, both: false };
  return { kind: "lua", file: lua, exists: false, both: false };
}

// The text of the user's own Hyprland files, to look for a submap of ours.
export function userHyprText(p) {
  return ["hyprland.lua", "bindings.lua", "hyprland.conf", "bindings.conf"]
    .map((name) => { try { return readFileSync(join(p.hyprDir, name), "utf8"); } catch { return ""; } })
    .join("\n");
}

// `omarchy menu keybindings --print`, which needs a running Hyprland.
export function printBindings(env, launch) {
  const omarchy = which("omarchy", launch.featurePath) || which("omarchy", env.PATH);
  if (!omarchy) return { ok: false, reason: "the omarchy command was not found" };
  const cache = mkdtempSync(join(tmpdir(), "oats-omarchy-print-"));
  try {
    const r = run(omarchy, ["menu", "keybindings", "--print"], { env: { ...env, XDG_CACHE_HOME: cache }, timeoutMs: 20_000 });
    if (!r.ok) return { ok: false, reason: `omarchy menu keybindings --print: ${failureText(r)}` };
    if (onlyStatic(parsePrint(r.stdout))) return { ok: false, reason: "no running Hyprland answered: omarchy menu keybindings --print showed only its own two web-app bindings" };
    return { ok: true, text: r.stdout };
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

// A found entry's argv with --appimage-extract-and-run right after the
// AppImage it runs (after an `env` prefix too), for a machine without
// libfuse2. The entry itself is never changed.
export function extractAndRun(argv, appImage) {
  const at = argv.indexOf(appImage);
  if (at < 0 || argv.includes("--appimage-extract-and-run")) return argv;
  return [...argv.slice(0, at + 1), "--appimage-extract-and-run", ...argv.slice(at + 1)];
}

export const describeDesktopSource = (d) => d.source === "entry" ? `the launcher entry ${d.entry}`
  : d.source === "appimage" ? `the AppImage ${d.appImage}` : d.source === "flag" ? `--desktop ${d.appImage}` : "none";

