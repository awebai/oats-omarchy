// Everything the OATS picker (OatsPicker.qml) decides, kept apart from the
// QML so a node test can run it: the reading of `agents --json`
// (bin/agents.mjs), its three sections as rows, the filter, and the section
// it opens on. The QML only lays these out, and runs what widget.mjs builds.
import { card } from "./widget.mjs"

export var SECTIONS = ["waiting", "agents", "souls"]
export var TITLES = { waiting: "Waiting on you", agents: "Agents", souls: "Souls" }

// The picker's read: its program, as argv (no shell). Setup's plugin.json
// from before 0.4.0 has none: then the picker offers setup only.
export function readArgv(plugin) {
  return plugin && plugin.agents ? plugin.agents.concat(["--json"]) : null
}

// How long a read may take before it is stopped and counts as failed: the
// reader answers within 110 s whatever it reads (lib/agents.mjs).
export var READ_TIMEOUT_MS = 120000

// The payload `omarchy-shell shell toggle ai.aweb.oats '<json>'` gives →
// the section it asks for, or "" (then the picker picks, once it has read).
export function requestedSection(payloadJson) {
  var p
  try { p = JSON.parse(String(payloadJson || "{}")) } catch (e) { return "" }
  return p && SECTIONS.indexOf(p.section) >= 0 ? p.section : ""
}

// The section to show once the read answered, when none was asked for:
// "waiting" when an agent says it waits on you, else "agents".
export function defaultSection(view) {
  return view && view.known && view.waiting.length > 0 ? "waiting" : "agents"
}

// Tab and Shift+Tab: the next section, or the one before, round.
export function nextSection(section, delta) {
  var i = SECTIONS.indexOf(section)
  return SECTIONS[((i < 0 ? 0 : i) + delta + SECTIONS.length) % SECTIONS.length]
}

var str = function(v) { return typeof v === "string" ? v : "" }

// What `agents --json` printed → the picker's view: { known: false, reason }
// or { known: true, waiting, agents, souls, notes, waitingReported }, the
// three sections as rows. `now` (ms) is when it answered: a card's age is
// worked out then, once.
export function parseAgents(text, now) {
  var r
  try { r = JSON.parse(String(text)) } catch (e) { return { known: false, reason: "agents --json printed no result" } }
  if (!r || r.ok !== true || !Array.isArray(r.deployments)) return { known: false, reason: r && typeof r.reason === "string" ? r.reason : "agents --json printed no result" }
  var features = r.features || {}
  var listed = r.deployments.filter(function(d) { return d && typeof d.path === "string" && typeof d.name === "string" })
  var many = listed.length > 1
  var view = { known: true, waiting: [], agents: [], souls: [], notes: [], soulNotes: [], waitingReported: features.waitingOnYou === true }
  if (typeof r.note === "string" && r.note) view.notes.push(r.note)
  listed.forEach(function(d) {
    // A group is a workspace, or a deployment that could not be read (it
    // has no workspace), by its name; titled only when more than one
    // deployment is listed.
    var group = many ? (d.ok && str(d.workspace) ? d.workspace : d.name) : ""
    if (!d.ok) { view.notes.push(d.name + ": " + (str(d.reason) || "could not be read")); return }
    var rows = (Array.isArray(d.agents) ? d.agents : []).filter(function(a) { return a && str(a.instance) && str(a.home) })
    var names = rows.map(function(a) { return a.instance })
    rows.forEach(function(a) {
      // The name, and the deployment's when two in one group share it.
      var label = names.indexOf(a.instance) !== names.lastIndexOf(a.instance) || sameInGroup(listed, d, group, a.instance) ? a.instance + " (" + d.name + ")" : a.instance
      var w = view.waitingReported ? a.waitingOnYou : null
      var row = {
        kind: "agent", group: group, label: label, subtitle: str(a.agent), home: a.home, deployment: d.path, key: "",
        running: a.running === true ? "running" : a.running === false ? "stopped" : "unknown",
        waiting: !!w, message: "", meta: "", since: "", act: true,
      }
      if (w) {
        var c = card(label, w, now)
        row.message = c.message
        row.meta = c.meta
        row.since = c.since
        view.waiting.push(withSearch({ kind: "waiting", group: group, label: label, subtitle: row.subtitle, home: a.home, deployment: d.path, key: "", running: row.running, waiting: true, message: c.message, meta: c.meta, since: c.since, act: true }))
      }
      view.agents.push(withSearch(row))
    })
    if (!Array.isArray(d.souls)) { view.soulNotes.push(d.name + ": " + (str(d.soulsReason) || "its souls could not be read")); return }
    d.souls.forEach(function(s) {
      if (!s || !str(s.key)) return
      var problem = s.problem && str(s.problem.message) ? s.problem.message : ""
      var count = typeof s.instances === "number" ? (s.instances === 1 ? "1 instance" : s.instances + " instances") : ""
      view.souls.push(withSearch({
        kind: "soul", group: group, label: s.key, subtitle: str(s.description), home: "", deployment: d.path, key: s.key,
        running: "", waiting: false, message: s.spawnable ? "" : problem, meta: count, since: "", act: s.spawnable === true,
      }))
    })
  })
  return view
}

// Whether another deployment of the same group lists an instance of this
// name (two deployments of one workspace).
function sameInGroup(listed, d, group, instance) {
  if (!group) return false
  return listed.some(function(o) {
    return o !== d && o.ok && (str(o.workspace) ? o.workspace : o.name) === group
      && Array.isArray(o.agents) && o.agents.some(function(a) { return a && a.instance === instance })
  })
}

function withSearch(row) {
  row.search = [row.label, row.subtitle, row.group, row.message, row.meta, row.key].join(" ").toLowerCase()
  return row
}

// The rows of `section` that hold every word typed, in any case.
export function filterRows(view, section, text) {
  if (!view || !view.known) return []
  var rows = view[section] || []
  var terms = String(text || "").toLowerCase().split(/\s+/).filter(function(t) { return !!t })
  if (!terms.length) return rows
  return rows.filter(function(row) { return terms.every(function(t) { return row.search.indexOf(t) >= 0 }) })
}

// The tab's title: the section's name, and how many agents wait on you.
export function sectionTitle(view, section) {
  if (section === "waiting" && view && view.known && view.waitingReported && view.waiting.length) return TITLES.waiting + " (" + view.waiting.length + ")"
  return TITLES[section]
}

// What the section says when it lists nothing. A null `waitingOnYou` makes
// no claim, so no agent is ever said not to be waiting.
export function emptyText(view, section, filter) {
  if (filter) return "No matches for “" + filter + "”"
  if (section === "waiting") return view && view.known && !view.waitingReported
    ? "This OATS CLI does not report who is waiting on you (it lacks the feature waiting-on-you)"
    : "No agent has said it is waiting on you"
  if (section === "agents") return "No agent instances"
  return "No souls"
}

// The lines above a section's rows: the deployments that could not be read,
// what to do when the list is empty, and, under Souls, the deployments whose
// souls could not be read.
export function notes(view, section) {
  if (!view || !view.known) return []
  return section === "souls" ? view.notes.concat(view.soulNotes) : view.notes
}

