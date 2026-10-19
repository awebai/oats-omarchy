// Everything the bar widget builds or reads, kept apart from the QML so a
// node test can run it: the command lines it hands to the bar's `run` (which
// runs `bash -lc <line>`), the argv of its read, and the reading of
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
// setup writes (then the widget offers setup only). `deployment` is null
// when setup uses this computer's list of deployments. `agents` and `spawn`
// are the picker's, null in a file an older setup wrote (then the picker
// offers setup only).
export function parsePlugin(text) {
  var p
  try { p = JSON.parse(String(text)) } catch (e) { return null }
  if (!p || (typeof p.deployment !== "string" && p.deployment !== null)) return null
  if (!isArgv(p.waiting) || !isArgv(p.attach) || !isArgv(p.setup)) return null
  if (p.tui !== null && !isArgv(p.tui)) return null
  if (p.desktop !== null && !isArgv(p.desktop)) return null
  var picker = isArgv(p.agents) && isArgv(p.spawn)
  return { deployment: p.deployment, tui: p.tui, desktop: p.desktop, waiting: p.waiting, attach: p.attach, setup: p.setup, agents: picker ? p.agents : null, spawn: picker ? p.spawn : null }
}

// The read when the panel opens: `waiting --json`, run as argv (no shell).
export function readArgv(plugin) {
  return plugin.waiting.concat(["--json"])
}

// Whether setup uses this computer's list of deployments: then the read is
// `waiting --list --json`, every listed deployment one after another.
export function isList(plugin) {
  return !!plugin && plugin.deployment === null
}

// How long a read may take before it is stopped and counts as failed: a
// list read reads each deployment in turn, within 110 s of its own.
export var READ_TIMEOUT_MS = 30000
export var READ_TIMEOUT_REASON = "waiting --json did not answer within 30 s"
export var LIST_READ_TIMEOUT_MS = 120000

export function readTimeoutMs(plugin) {
  return isList(plugin) ? LIST_READ_TIMEOUT_MS : READ_TIMEOUT_MS
}

// What `waiting --json` printed → { known: true, count, rows, groups, note }
// or { known: false, reason }. Only a failed read is unknown: a row the
// kernel makes no claim about is simply not counted. With the list, a
// deployment that could not be read is unknown on its own, in its group.
export function parseWaiting(text) {
  var r
  try { r = JSON.parse(String(text)) } catch (e) { return { known: false, reason: "waiting --json printed no result" } }
  if (r && r.ok === true && typeof r.count === "number" && Array.isArray(r.rows)) {
    var rows = r.rows.filter(function(x) { return x && typeof x.instance === "string" && typeof x.home === "string" })
    var listed = Array.isArray(r.deployments) ? r.deployments.filter(function(d) { return d && typeof d.path === "string" && typeof d.name === "string" }) : null
    return { known: true, count: r.count, rows: rows, groups: groups(rows, listed), note: typeof r.note === "string" ? r.note : "" }
  }
  return { known: false, reason: r && typeof r.reason === "string" ? r.reason : "waiting --json printed no result" }
}

// The panel's rows by workspace, in the list's order: [{ title, rows:
// [{ instance, home, label, waitingOnYou }], unknown: [text] }]. A group is a workspace,
// or, for a deployment that could not be read (it has no workspace), that
// deployment alone, by its path; its title is the workspace key or the
// deployment's name. One deployment (or a read of one deployment, `listed`
// null) is one group with no title; nothing to show is no group. A row names
// its deployment when its group has more than one, and its path when even
// that would not tell two rows apart.
export function groups(rows, listed) {
  if (!listed) return rows.length ? [{ title: "", rows: rows.map(function(x) { return { instance: x.instance, home: x.home, label: x.instance, waitingOnYou: claim(x.waitingOnYou) } }), unknown: [] }] : []
  var out = []
  var keyOf = function(d) { return d.ok && d.workspace ? "workspace " + d.workspace : "deployment " + d.path }
  var find = function(key) { for (var i = 0; i < out.length; i++) if (out[i].key === key) return out[i]; return null }
  listed.forEach(function(d) {
    var key = keyOf(d)
    var g = find(key)
    if (!g) { g = { key: key, title: d.ok && d.workspace ? d.workspace : d.name, rows: [], unknown: [], count: 0 }; out.push(g) }
    g.count += 1
    if (!d.ok) g.unknown.push(d.name + ": " + (typeof d.reason === "string" ? d.reason : "could not be read"))
  })
  rows.forEach(function(x) {
    var d = listed.filter(function(y) { return y.path === x.deployment })[0]
    var g = d ? find(keyOf(d)) : null
    if (g) g.rows.push({ instance: x.instance, home: x.home, name: d.name, path: d.path, waitingOnYou: claim(x.waitingOnYou) })
  })
  var shown = out.filter(function(g) { return g.rows.length || g.unknown.length })
  return shown.map(function(g) {
    var first = g.rows.map(function(x) { return g.count > 1 ? x.instance + " (" + x.name + ")" : x.instance })
    return {
      title: shown.length > 1 ? g.title : "",
      rows: g.rows.map(function(x, i) {
        var clash = first.indexOf(first[i]) !== first.lastIndexOf(first[i])
        return { instance: x.instance, home: x.home, label: clash ? x.instance + " (" + x.path + ")" : first[i], waitingOnYou: x.waitingOnYou }
      }),
      unknown: g.unknown,
    }
  })
}

// The read's state, one per reader. A read is pending from the moment
// it is asked for until its output is parsed or its deadline passes, whether
// or not its process ever started: Quickshell reports nothing for a program
// that cannot start, so only the deadline settles that read. While one is
// pending no other starts, and opening the panel again does not move its
// deadline.
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
  return settleRead(state, attempt) ? parseWaiting(text) : null
}

// Read `attempt` answered: → true when it was the pending one, which it
// settles (the picker parses its own answer), false when it was not.
export function settleRead(state, attempt) {
  if (!state.pending || attempt !== state.attempt) return false
  state.pending = false
  return true
}

// Read `attempt`'s deadline (`ms`, READ_TIMEOUT_MS by default) → what to
// show (it failed), or null when it had already finished. `what` names the
// read ("waiting --json" by default).
export function expireRead(state, attempt, ms, what) {
  if (!state.pending || attempt !== state.attempt) return null
  state.pending = false
  var limit = ms || READ_TIMEOUT_MS
  return { known: false, reason: limit === READ_TIMEOUT_MS && !what ? READ_TIMEOUT_REASON : (what || "waiting --json") + " did not answer within " + Math.round(limit / 1000) + " s" }
}

// One reader for all the widget's bars: the first of the peers the bar
// lists, or this one when the bar lists none or not this one.
export function isReader(peers, self) {
  if (!peers || !peers.length || peers.indexOf(self) < 0) return true
  return peers[0] === self
}

// A `waitingOnYou` as the kernel gave it ({ since, producer, reason,
// message }, each a string or null), or null.
export function claim(w) {
  if (!w || typeof w !== "object") return null
  var field = function(v) { return typeof v === "string" ? v : null }
  return { since: field(w.since), producer: field(w.producer), reason: field(w.reason), message: field(w.message) }
}

// How long ago `since` was, at `now` (ms): "<1 min", "3 min", "2 h", "4 d";
// "" when `since` is not a time. It is worked out once, when the read
// answers: nothing ticks.
export function age(since, now) {
  var at = Date.parse(String(since || ""))
  if (isNaN(at)) return ""
  var min = Math.floor(Math.max(0, now - at) / 60000)
  if (min < 1) return "<1 min"
  if (min < 60) return min + " min"
  if (min < 48 * 60) return Math.floor(min / 60) + " h"
  return Math.floor(min / (24 * 60)) + " d"
}

// One card per agent waiting on you, the same in the panel and the picker:
// its name (the label that tells it apart), the kernel's message as given
// when it has one, then its reason, its producer and how long it has
// waited, each as given, and the exact `since` (the panel's tooltip). The
// plugin words nothing of its own.
export function card(label, w, now) {
  var c = claim(w) || { since: null, producer: null, reason: null, message: null }
  var meta = [c.reason, c.producer, age(c.since, now)].filter(function(x) { return !!x }).join(" \u00b7 ")
  return { title: label, message: c.message || "", meta: meta, since: c.since || "" }
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

// The OATS picker (the plugin's overlay), through the running shell.
export var PLUGIN_ID = "ai.aweb.oats"
export function pickerCommand() {
  return "exec omarchy-shell shell summon " + PLUGIN_ID + " " + shellQuote("{}")
}

// The picker's commands, each an argv it runs with no shell (Omarchy's
// Util.execArgv): an agent's session in the floating terminal, and the spawn
// from a soul, for the deployment that listed it.
export function attachArgv(plugin, home) {
  return ["omarchy-launch-floating-terminal-with-presentation", commandLine(plugin.attach.concat([home]))]
}

export function spawnArgv(plugin, deployment, soul) {
  return plugin.spawn.concat(["--dir", deployment, soul])
}

// setup --apply in the floating terminal: it shows the plan and asks. For
// the deployment setup is applied for, else (setup has not run) it asks for
// the deployment first.
export function setupCommand(plugin, setupPath) {
  return inTerminal(setupLine(plugin, setupPath))
}

function setupLine(plugin, setupPath) {
  return plugin ? commandLine(plugin.setup.concat(["--apply"])) : shellQuote(setupPath) + " --apply"
}

// The same as the picker's argv.
export function setupArgv(plugin, setupPath) {
  return ["omarchy-launch-floating-terminal-with-presentation", setupLine(plugin, setupPath)]
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
