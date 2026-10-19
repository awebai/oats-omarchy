import Quickshell
import Quickshell.Io
import QtQuick
import qs.Commons
import qs.Ui
import "widget.mjs" as Widget
import "picker.mjs" as Picker

// The OATS picker: the plugin's overlay, in the shape of Omarchy's own
// pickers (omarchy.clipboard, omarchy.emojis) and with the shell's theme.
// Three sections: the agents waiting on you (one card each, as in the bar
// panel), every agent instance by workspace, and the souls each workspace
// offers. Typing filters; Up/Down or Ctrl+J/K move; Tab and Shift+Tab switch
// section; Enter opens the agent's session in Omarchy's floating terminal,
// or, on a soul, asks for a task and starts an agent from it; Esc clears the
// filter, then closes.
//
// It is opened with `omarchy-shell shell toggle ai.aweb.oats '<json>'`, the
// payload's `section` (waiting, agents or souls) choosing where it opens;
// without one it opens on the agents waiting on you when there are any, else
// on Agents. It reads only when it opens, fresh each time, after setup's
// plugin.json is read again: `agents --json` (bin/agents.mjs), with no
// timer and nothing in the background. It says it is reading until the read
// answers; one that has not answered by its deadline is stopped and says
// why. Everything it shows and runs is decided by picker.mjs and widget.mjs;
// it runs commands as argv, with no shell, and writes nothing.
Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  property bool opened: false
  property string filterText: ""
  property int selectedIndex: 0
  property bool cursorActive: false
  property string section: "agents"
  // The section the payload asked for, or the person chose: then the read
  // does not choose one.
  property bool sectionChosen: false

  // setup's commands, or null; this opening's view, or null until it
  // answers; and whether it is being read.
  property var plugin: null
  property var view: null
  property bool reading: false
  property bool loaded: false
  readonly property bool failed: !!view && !view.known
  readonly property bool needsSetup: loaded && !reading && (!plugin || !plugin.agents)
  property var readState: Widget.newReadState()
  property int readAttempt: 0
  property bool readAfterLoad: false

  readonly property string setupPath: Widget.urlPath(Qt.resolvedUrl("setup"))
  readonly property string pluginPath: Widget.pluginFilePath(Quickshell.env("HOME"), Quickshell.env("XDG_STATE_HOME"))
  // How a command runs: Omarchy's argv runner (no shell reads the words).
  property var execArgv: function(argv) { Util.execArgv(argv) }

  // The [menu] surface tokens, as omarchy.clipboard and omarchy.emojis use
  // them: a theme that styles the menu styles this too.
  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  property color scrim: Color.menu.scrim
  property color selectedBackground: Color.menu.selectedBackground
  property color selectedText: Color.menu.selectedText
  // Secondary text: the theme's text, faded as the shell's own pickers fade it.
  readonly property real dimOpacity: 0.7
  readonly property int cornerRadius: Style.cornerRadius
  property string fontFamily: Style.font.menuFamily
  property int contentMargin: Style.spacing.panelPadding
  property int headerHeight: Math.max(Style.space(34), Style.font.title + Style.spacing.controlPaddingY * 2)
  property int contentSpacing: Style.spacing.md
  property int cardWidth: Math.min(Style.space(720), panel.width - Style.gapsOut * 2)
  property int cardHeight: Math.min(Style.space(600), panel.height - Style.gapsOut * 2)

  function open(payloadJson) {
    var asked = Picker.requestedSection(payloadJson)
    root.sectionChosen = asked !== ""
    root.section = asked || (root.section || "agents")
    root.opened = true
    root.filterText = ""
    root.selectedIndex = 0
    root.cursorActive = true
    root.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    root.opened = false
  }

  function dismiss() {
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || Widget.PLUGIN_ID)
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  // Read plugin.json again, then the view, fresh.
  function refresh() {
    root.view = null
    root.reading = true
    root.readAfterLoad = true
    root.rebuildDisplay()
    pluginFile.reload()
  }

  function pluginLoaded(parsed) {
    root.plugin = parsed
    root.loaded = true
    if (root.readAfterLoad) {
      root.readAfterLoad = false
      root.startRead()
    }
  }

  function startRead() {
    var argv = Picker.readArgv(root.plugin)
    if (!argv) { root.reading = false; root.rebuildDisplay(); return }
    if (reader.running) return
    var attempt = Widget.beginRead(root.readState)
    if (!attempt) return
    root.readAttempt = attempt
    reader.command = argv
    reader.running = true
    readTimeout.restart()
  }

  function answered(view) {
    root.view = view
    root.reading = false
    if (!root.sectionChosen) root.section = Picker.defaultSection(view)
    root.rebuildDisplay()
  }

  function setSection(next) {
    root.section = next
    root.sectionChosen = true
    root.selectedIndex = 0
    root.cursorActive = true
    root.rebuildDisplay()
  }

  function setFilter(next) {
    root.filterText = next
    root.selectedIndex = 0
    root.cursorActive = true
    root.rebuildDisplay()
  }

  function rebuildDisplay() {
    var rows = Picker.filterRows(root.view, root.section, root.filterText)
    displayModel.clear()
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i]
      displayModel.append({
        kind: r.kind, group: r.group, label: r.label, subtitle: r.subtitle, message: r.message, meta: r.meta,
        since: r.since, running: r.running, waiting: r.waiting, home: r.home, deployment: r.deployment, key: r.key, act: r.act
      })
    }
    if (displayModel.count === 0) selectedIndex = 0
    else if (selectedIndex >= displayModel.count) selectedIndex = displayModel.count - 1
    else if (selectedIndex < 0) selectedIndex = 0
    Qt.callLater(function() {
      if (displayModel.count > 0) resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
    })
  }

  function select(delta) {
    if (displayModel.count === 0) return
    if (!cursorActive) {
      cursorActive = true
      selectedIndex = delta < 0 ? displayModel.count - 1 : 0
    } else {
      selectedIndex = Math.max(0, Math.min(displayModel.count - 1, selectedIndex + delta))
    }
    resultList.positionViewAtIndex(selectedIndex, ListView.Contain)
  }

  // Enter on a row: an agent's session, or a soul's spawn. Before setup, or
  // with a plugin.json an older setup wrote, Enter runs setup.
  function activate(index) {
    if (root.needsSetup) { var setup = Widget.setupArgv(root.plugin, root.setupPath); root.dismiss(); root.execArgv(setup); return }
    if (index < 0 || index >= displayModel.count) return
    var row = displayModel.get(index)
    if (!row.act || !root.plugin) return
    var argv = row.kind === "soul" ? Widget.spawnArgv(root.plugin, row.deployment, row.key) : Widget.attachArgv(root.plugin, row.home)
    root.dismiss()
    root.execArgv(argv)
  }

  // A key in the picker: what the shell's own pickers do with it, and
  // Tab and Shift+Tab between the sections. Its own function, so the QML
  // test can press keys without a keyboard.
  function keyPressed(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) && !(event.modifiers & (Qt.AltModifier | Qt.MetaModifier))
    if (event.key === Qt.Key_Escape) {
      if (root.filterText) root.setFilter("")
      else root.dismiss()
      event.accepted = true
    } else if (Util.editsFilter(event, root.filterText)) {
      root.setFilter(Util.editedFilter(event, root.filterText))
      event.accepted = true
    } else if (event.key === Qt.Key_Backtab || (event.key === Qt.Key_Tab && (event.modifiers & Qt.ShiftModifier))) {
      root.setSection(Picker.nextSection(root.section, -1))
      event.accepted = true
    } else if (event.key === Qt.Key_Tab) {
      root.setSection(Picker.nextSection(root.section, 1))
      event.accepted = true
    } else if (event.key === Qt.Key_Up || (ctrl && event.key === Qt.Key_K)) {
      root.select(-1)
      event.accepted = true
    } else if (event.key === Qt.Key_Down || (ctrl && event.key === Qt.Key_J)) {
      root.select(1)
      event.accepted = true
    } else if (event.key === Qt.Key_PageUp) {
      root.select(-6)
      event.accepted = true
    } else if (event.key === Qt.Key_PageDown) {
      root.select(6)
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      if (root.cursorActive || root.needsSetup) root.activate(root.selectedIndex)
      else if (displayModel.count > 0) root.cursorActive = true
      event.accepted = true
    } else if (!ctrl && event.text && event.text.length === 1 && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127) {
      root.setFilter(root.filterText + event.text)
      event.accepted = true
    }
  }

  Component.onDestruction: {
    readTimeout.stop()
    if (reader.running) reader.running = false
  }

  ListModel { id: displayModel }

  FileView {
    id: pluginFile
    path: root.pluginPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.pluginLoaded(Widget.parsePlugin(text()))
    onLoadFailed: root.pluginLoaded(null)
  }

  Process {
    id: reader
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (Widget.settleRead(root.readState, root.readAttempt)) {
          readTimeout.stop()
          root.answered(Picker.parseAgents(text, Date.now()))
        }
      }
    }
  }

  // The read's deadline (once, not repeating): it also settles a read whose
  // program never started.
  Timer {
    id: readTimeout
    interval: Picker.READ_TIMEOUT_MS
    repeat: false
    onTriggered: {
      var result = Widget.expireRead(root.readState, root.readAttempt, interval, "agents --json")
      if (result) {
        reader.running = false
        root.answered(result)
      }
    }
  }

  PickerWindow {
    id: panel
    visible: root.opened
    scrim: root.scrim
    onDismissed: root.dismiss()

    BorderSurface {
      id: card
      objectName: "pickerCard"
      width: root.cardWidth
      height: root.cardHeight
      radius: root.cornerRadius
      anchors.centerIn: parent
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true

        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) { root.keyPressed(event) }
      }

      Column {
        id: content
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: root.contentSpacing

        Rectangle {
          id: header
          width: parent.width
          height: root.headerHeight
          radius: root.cornerRadius
          color: "transparent"

          Text {
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.filterText || "Search OATS…"
            color: root.foreground
            opacity: root.filterText ? 1 : 0.58
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            elide: Text.ElideRight
          }
        }

        // The sections, as Omarchy's own switches are drawn (omarchy.agents).
        Row {
          id: tabs
          width: parent.width
          spacing: Style.spacing.md
          readonly property real cellWidth: (width - spacing * (Picker.SECTIONS.length - 1)) / Picker.SECTIONS.length

          Repeater {
            model: Picker.SECTIONS

            Button {
              required property var modelData
              width: tabs.cellWidth
              text: Picker.sectionTitle(root.view, modelData)
              selected: root.section === modelData
              bordered: true
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              verticalPadding: Style.spacing.controlPaddingY
              onClicked: root.setSection(modelData)
            }
          }
        }

        // That it is reading; why the read failed; the deployments that could
        // not be read; and, before setup, what to do.
        Column {
          id: above
          width: parent.width
          spacing: Style.space(4)

          Text {
            visible: root.reading
            width: parent.width
            text: "Reading your agents…"
            textFormat: Text.PlainText
            color: root.foreground
            opacity: root.dimOpacity
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            visible: root.needsSetup
            width: parent.width
            text: root.plugin ? "Setup was applied by an older version of this plugin: Enter runs it again." : "OATS is not set up here yet: Enter runs setup."
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }
          Text {
            visible: root.failed
            width: parent.width
            text: root.failed ? root.view.reason : ""
            textFormat: Text.PlainText
            color: root.foreground
            opacity: root.dimOpacity
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
          Repeater {
            model: Picker.notes(root.view, root.section)

            Text {
              required property var modelData
              width: above.width
              text: modelData
              textFormat: Text.PlainText
              color: root.foreground
              opacity: root.dimOpacity
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }
        }

        Item {
          width: parent.width
          height: parent.height - header.height - tabs.height - above.height - below.height - root.contentSpacing * 4

          ListView {
            id: resultList
            anchors.fill: parent
            model: displayModel
            clip: true
            spacing: Style.space(4)
            boundsBehavior: Flickable.StopAtBounds

            section.property: "group"
            section.criteria: ViewSection.FullString
            section.delegate: Item {
              required property string section
              width: ListView.view.width
              height: section !== "" ? groupTitle.implicitHeight + Style.space(6) : 0
              visible: section !== ""
              PanelSectionHeader {
                id: groupTitle
                anchors.bottom: parent.bottom
                anchors.bottomMargin: Style.space(2)
                width: parent.width
                text: parent.section
                foreground: root.foreground
                fontFamily: root.fontFamily
                elide: Text.ElideRight
              }
            }

            delegate: Rectangle {
              id: row
              required property int index
              required property string kind
              required property string label
              required property string subtitle
              required property string message
              required property string meta
              required property string running
              required property bool waiting
              required property bool act

              readonly property bool hasCursor: root.cursorActive && index === root.selectedIndex
              readonly property color ink: hasCursor ? root.selectedText : root.foreground

              width: ListView.view.width
              height: lines.implicitHeight + Style.spacing.rowPaddingX * 2
              radius: root.cornerRadius
              color: hasCursor ? root.selectedBackground : "transparent"

              // The agent's marks: running or stopped, and waiting on you.
              Text {
                id: mark
                visible: row.kind !== "soul"
                anchors.left: parent.left
                anchors.leftMargin: Style.space(12)
                anchors.top: parent.top
                anchors.topMargin: Style.spacing.rowPaddingX
                width: visible ? Style.space(18) : 0
                text: row.running === "running" ? "●" : row.running === "stopped" ? "○" : "◌"
                textFormat: Text.PlainText
                color: row.ink
                opacity: row.running === "running" ? 1 : 0.6
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }

              Column {
                id: lines
                anchors.left: mark.right
                anchors.leftMargin: row.kind === "soul" ? Style.space(12) : Style.space(6)
                anchors.right: bell.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)

                Text {
                  width: parent.width
                  text: row.label
                  textFormat: Text.PlainText
                  color: row.ink
                  opacity: row.act ? 1 : 0.6
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                  elide: Text.ElideRight
                }
                Text {
                  visible: text !== ""
                  width: parent.width
                  text: row.message
                  textFormat: Text.PlainText
                  color: row.ink
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  wrapMode: Text.WordWrap
                  maximumLineCount: 3
                  elide: Text.ElideRight
                }
                Text {
                  visible: text !== ""
                  width: parent.width
                  text: [row.subtitle, row.meta].filter(function(x) { return x !== "" }).join(" · ")
                  textFormat: Text.PlainText
                  color: row.ink
                  opacity: 0.6
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }

              Text {
                id: bell
                visible: row.waiting && row.kind === "agent"
                anchors.right: parent.right
                anchors.rightMargin: Style.space(12)
                anchors.top: parent.top
                anchors.topMargin: Style.spacing.rowPaddingX
                width: visible ? implicitWidth : 0
                text: "\u{F009A}"
                textFormat: Text.PlainText
                color: row.ink
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: row.act ? Qt.PointingHandCursor : Qt.ArrowCursor
                onContainsMouseChanged: if (containsMouse) {
                  root.cursorActive = true
                  root.selectedIndex = row.index
                }
                onClicked: {
                  root.cursorActive = true
                  root.selectedIndex = row.index
                  root.activate(row.index)
                }
              }
            }
          }

          Text {
            anchors.centerIn: parent
            visible: displayModel.count === 0 && !root.reading && !root.needsSetup && !root.failed
            width: parent.width
            text: Picker.emptyText(root.view, root.section, root.filterText)
            textFormat: Text.PlainText
            color: root.foreground
            opacity: 0.7
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }
        }

        Text {
          id: below
          width: parent.width
          height: visible ? implicitHeight : 0
          visible: root.section !== "souls" && displayModel.count > 0 && Widget.detachKey(root.plugin)
          text: "Alt+O leaves the viewer"
          textFormat: Text.PlainText
          color: root.foreground
          opacity: root.dimOpacity
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
