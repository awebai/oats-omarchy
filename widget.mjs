// Everything the bar widget builds or reads, kept apart from the QML so a
// node test can run it: the command lines it hands to the bar's `run` (which
// runs `bash -lc <line>`), the argv of its count read, and the reading of
// setup's plugin.json and of `waiting --json`. The QML only displays what
// these return.
//
// The commands come from plugin.json, which setup writes on --apply: the
// argv the key and the menu run, from the same code. Without it, setup has
// not run, and the only command is setup itself.

// One shell word: single quotes, and a quote inside closed, escaped, reopened.
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// The path of a file:// URL (Qt.resolvedUrl gives one for a plugin file).
export function urlPath(url) {
  return decodeURIComponent(String(url).replace(/^file:\/\//, ""))
}

// argv as one command line, every word quoted.
export function commandLine(argv) {
  return argv.map(shellQuote).join(" ")
}

// A command line in Omarchy's floating terminal, which joins its arguments
// and runs them with `bash -c`: the line is quoted again for the bar's line.
export function inTerminal(line) {
  return "exec omarchy-launch-floating-terminal-with-presentation " + shellQuote(line)
}

// Where setup writes plugin.json: its state directory, as setup finds it
// ($XDG_STATE_HOME when it is absolute, else ~/.local/state).
export function pluginFilePath(home, xdgStateHome) {
  var state = /^\//.test(String(xdgStateHome || "")) ? String(xdgStateHome) : String(home) + "/.local/state"
  return state + "/oats-omarchy/plugin.json"
}

function isArgv(value) {
  return Array.isArray(value) && value.length > 0 && value.every(function(w) { return typeof w === "string" })
}

// plugin.json's text → its commands, or null when it is absent or not what
// setup writes (then the widget offers setup only).
export function parsePlugin(text) {
  var p
  try { p = JSON.parse(String(text)) } catch (e) { return null }
  if (!p || typeof p.deployment !== "string") return null
  if (!isArgv(p.waiting) || !isArgv(p.attach) || !isArgv(p.setup)) return null
  if (p.tui !== null && !isArgv(p.tui)) return null
  if (p.desktop !== null && !isArgv(p.desktop)) return null
  return { deployment: p.deployment, tui: p.tui, desktop: p.desktop, waiting: p.waiting, attach: p.attach, setup: p.setup }
}

// The count read: `waiting --json`, run as argv (no shell).
export function readArgv(plugin) {
  return plugin.waiting.concat(["--json"])
}

// How long a read may take before it is stopped and counts as failed.
export var READ_TIMEOUT_MS = 30000
export var READ_TIMEOUT_REASON = "waiting --json did not answer within 30 s"

// What `waiting --json` printed → { known: true, count, rows } or
// { known: false, reason }. Only a failed read is unknown: a row the kernel
// makes no claim about is simply not counted.
export function parseWaiting(text) {
  var r
  try { r = JSON.parse(String(text)) } catch (e) { return { known: false, reason: "waiting --json printed no result" } }
  if (r && r.ok === true && typeof r.count === "number" && Array.isArray(r.rows)) {
    var rows = r.rows.filter(function(x) { return x && typeof x.instance === "string" && typeof x.home === "string" })
    return { known: true, count: r.count, rows: rows }
  }
  return { known: false, reason: r && typeof r.reason === "string" ? r.reason : "waiting --json printed no result" }
}

// Beside the icon: the count when some row waits on you, "?" when the read
// failed, else nothing (never a claim that nobody is waiting).
export function badge(result) {
  if (!result) return ""
  if (!result.known) return "?"
  return result.count > 0 ? String(result.count) : ""
}

// The count read's state, one per reader. A read is pending from the moment
// it is asked for until its output is parsed or its deadline passes, whether
// or not its process ever started: Quickshell reports nothing for a program
// that cannot start, so only the deadline settles that read. While one is
// pending no other starts, and a refresh does not move its deadline.
export function newReadState() {
  return { pending: false, attempt: 0 }
}

// → the number of the read to start, or 0 while one is pending.
export function beginRead(state) {
  if (state.pending) return 0
  state.pending = true
  state.attempt += 1
  return state.attempt
}

// The output of read `attempt` → what to show, or null when that read is
// no longer the pending one (it was stopped at its deadline).
export function finishRead(state, attempt, text) {
  if (!state.pending || attempt !== state.attempt) return null
  state.pending = false
  return parseWaiting(text)
}

// Read `attempt`'s deadline → what to show (it failed), or null when it had
// already finished.
export function expireRead(state, attempt) {
  if (!state.pending || attempt !== state.attempt) return null
  state.pending = false
  return { known: false, reason: READ_TIMEOUT_REASON }
}

// The refresh interval from the widget's setting, in ms: 15 s to an hour.
export function refreshMs(seconds) {
  var s = Number(seconds)
  if (!(s > 0)) s = 60
  return Math.round(Math.min(3600, Math.max(15, s)) * 1000)
}

// One reader for all the widget's bars: the first of the peers the bar
// lists, or this one when the bar lists none or not this one.
export function isReader(peers, self) {
  if (!peers || !peers.length || peers.indexOf(self) < 0) return true
  return peers[0] === self
}

// The panel's commands, each a line for the bar's `run`.
export function tuiCommand(plugin) {
  return plugin && plugin.tui ? "exec " + commandLine(plugin.tui) : ""
}

export function desktopCommand(plugin) {
  return plugin && plugin.desktop ? "exec " + commandLine(plugin.desktop) : ""
}

// The session of a row waiting on you, in the floating terminal.
export function attachCommand(plugin, home) {
  return inTerminal(commandLine(plugin.attach.concat([home])))
}

// Whether the viewer the panel opens takes the detach key (Alt+O).
export function detachKey(plugin) {
  return !!plugin && plugin.attach.indexOf("--detach-key") >= 0
}

// setup --apply in the floating terminal: it shows the plan and asks. For
// the deployment setup is applied for, else (setup has not run) it asks for
// the deployment first.
export function setupCommand(plugin, setupPath) {
  if (plugin) return inTerminal(commandLine(plugin.setup.concat(["--apply"])))
  return inTerminal(shellQuote(setupPath) + " --apply")
}

// The icon's right click: the TUI, else setup.
export function quickCommand(plugin, setupPath) {
  return tuiCommand(plugin) || setupCommand(plugin, setupPath)
}

// What a click on the icon does: { toggle: true } (the panel) or { line }.
// Before setup has run (no plugin.json) either click runs the whole setup;
// after, a left click toggles the panel and a right click opens the TUI.
export function clickAction(plugin, setupPath, right) {
  if (!plugin) return { line: setupCommand(null, setupPath) }
  return right ? { line: quickCommand(plugin, setupPath) } : { toggle: true }
}

export function tooltip(plugin) {
  return plugin ? "OATS" : "OATS: click to set up"
}
