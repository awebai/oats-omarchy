import Quickshell
import Quickshell.Io
import QtQuick
import qs.Commons
import qs.Ui
import "widget.mjs" as Widget

// The waiting popup: the plugin's overlay, the oats menu's "Waiting on you".
// The agents waiting on you, one card each (WaitingCard.qml, as in the bar
// panel), by workspace, in the shape of Omarchy's own pickers and with the
// shell's theme. Up/Down or Ctrl+J/K move; Enter opens the agent's session
// in Omarchy's floating terminal; Esc closes.
//
// It is opened with `omarchy-shell shell summon ai.aweb.oats '{}'`. It reads
// only when it opens, fresh each time, after setup's plugin.json is read
// again: `waiting --json` (bin/waiting.mjs), the bar panel's read, with no
// repeating timer and nothing in the background. It says it is reading until
// the read answers; one that has not answered by its deadline is stopped and
// says why. Everything it shows and runs is decided by widget.mjs; it runs
// commands as argv, with no shell, and writes nothing.
Item {
  id: root

  property var shell: null
  property var manifest: null

  property bool opened: false
  property int selectedIndex: 0

  // setup's commands, or null; this opening's read, or null until it
  // answers; and whether it is being read.
  property var plugin: null
  property var waiting: null
  property bool reading: false
  property bool loaded: false
  // When this opening's read answered: a card's age is from then.
  property real readAt: 0
  readonly property bool failed: !!waiting && !waiting.known
  readonly property bool needsSetup: loaded && !reading && !plugin
  readonly property string note: waiting && waiting.known ? waiting.note : ""
  property var readState: Widget.newReadState()
  property int readAttempt: 0
  property bool readAfterLoad: false
  // The cards, in order (widget.mjs popupRows); the list's model holds only
  // their strings, and a card reads its claim from here.
  property var rows: []

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
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property int cornerRadius: Style.cornerRadius
  property string fontFamily: Style.font.menuFamily
  property int contentMargin: Style.spacing.panelPadding
  property int contentSpacing: Style.spacing.md
  property int cardWidth: Math.min(Style.space(560), panel.width - Style.gapsOut * 2)
  property int cardHeight: Math.min(Style.space(600), panel.height - Style.gapsOut * 2)

  function open(payloadJson) {
    root.opened = true
    root.selectedIndex = 0
    root.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    root.opened = false
  }

  function dismiss() {
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "ai.aweb.oats")
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  // Read plugin.json again, then who is waiting, fresh.
  function refresh() {
    root.waiting = null
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
    if (!root.plugin) { root.reading = false; root.rebuildDisplay(); return }
    if (reader.running) return
    var attempt = Widget.beginRead(root.readState)
    if (!attempt) return
    root.readAttempt = attempt
    reader.command = Widget.readArgv(root.plugin)
    reader.running = true
    readTimeout.interval = Widget.readTimeoutMs(root.plugin)
    readTimeout.restart()
  }

  function answered(result) {
    root.readAt = Date.now()
    root.waiting = result
    root.reading = false
    root.rebuildDisplay()
  }

  function rebuildDisplay() {
    var rows = Widget.popupRows(root.waiting)
    root.rows = rows
    displayModel.clear()
    for (var i = 0; i < rows.length; i++) displayModel.append({ group: rows[i].group, name: rows[i].label, home: rows[i].home })
    if (displayModel.count === 0) selectedIndex = 0
    else if (selectedIndex >= displayModel.count) selectedIndex = displayModel.count - 1
    Qt.callLater(function() {
      if (displayModel.count > 0) resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
    })
  }

  function select(delta) {
    if (displayModel.count === 0) return
    selectedIndex = Math.max(0, Math.min(displayModel.count - 1, selectedIndex + delta))
    resultList.positionViewAtIndex(selectedIndex, ListView.Contain)
  }

  // Enter on a card: the agent's session. Before setup, Enter runs setup.
  function activate(index) {
    if (root.needsSetup) { var setup = Widget.setupArgv(null, root.setupPath); root.dismiss(); root.execArgv(setup); return }
    if (!root.plugin || index < 0 || index >= displayModel.count) return
    var argv = Widget.attachArgv(root.plugin, displayModel.get(index).home)
    root.dismiss()
    root.execArgv(argv)
  }

  // A key in the popup. Its own function, so the QML test can press keys
  // without a keyboard.
  function keyPressed(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) && !(event.modifiers & (Qt.AltModifier | Qt.MetaModifier))
    if (event.key === Qt.Key_Escape) {
      root.dismiss()
      event.accepted = true
    } else if (event.key === Qt.Key_Up || (ctrl && event.key === Qt.Key_K)) {
      root.select(-1)
      event.accepted = true
    } else if (event.key === Qt.Key_Down || (ctrl && event.key === Qt.Key_J)) {
      root.select(1)
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      root.activate(root.selectedIndex)
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
        var result = Widget.finishRead(root.readState, root.readAttempt, text)
        if (result) {
          readTimeout.stop()
          root.answered(result)
        }
      }
    }
  }

  // The read's deadline (once, not repeating): it also settles a read whose
  // program never started.
  Timer {
    id: readTimeout
    interval: Widget.READ_TIMEOUT_MS
    repeat: false
    onTriggered: {
      var result = Widget.expireRead(root.readState, root.readAttempt, interval)
      if (result) {
        reader.running = false
        root.answered(result)
      }
    }
  }

  WaitingWindow {
    id: panel
    visible: root.opened
    scrim: root.scrim
    onDismissed: root.dismiss()

    BorderSurface {
      id: card
      objectName: "waitingCard"
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

        Text {
          id: header
          width: parent.width
          text: "Waiting on you"
          textFormat: Text.PlainText
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.heading
          elide: Text.ElideRight
        }

        // That it is reading; why the read failed, or what to do when this
        // computer's list holds no deployment; the deployments that could
        // not be read; and, before setup, what to do.
        Column {
          id: above
          width: parent.width
          spacing: Style.space(4)

          Text {
            visible: root.reading
            width: parent.width
            text: "Reading who is waiting on you…"
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            visible: root.needsSetup
            width: parent.width
            text: "OATS is not set up here yet: Enter runs setup."
            textFormat: Text.PlainText
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }
          Text {
            visible: root.failed || root.note !== ""
            width: parent.width
            text: root.failed ? root.waiting.reason : root.note
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
          Repeater {
            model: Widget.popupNotes(root.waiting)

            Text {
              required property var modelData
              width: above.width
              text: modelData
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }
        }

        Item {
          width: parent.width
          height: parent.height - header.height - above.height - below.height - root.contentSpacing * 3

          ListView {
            id: resultList
            anchors.fill: parent
            model: displayModel
            clip: true
            spacing: Style.space(6)
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

            delegate: WaitingCard {
              id: row
              required property int index
              required property string name

              width: ListView.view.width
              label: name
              waitingOnYou: root.rows[index] ? root.rows[index].waitingOnYou : null
              readAt: root.readAt
              foreground: root.foreground
              dim: root.dim
              fontFamily: root.fontFamily
              highlighted: index === root.selectedIndex
              onHoveredChanged: if (hovered) root.selectedIndex = row.index
              onActivated: {
                root.selectedIndex = row.index
                root.activate(row.index)
              }
            }
          }

          // Nothing to show: the kernel's claims only, so no agent is ever
          // said not to be waiting.
          Text {
            anchors.centerIn: parent
            visible: displayModel.count === 0 && !root.reading && !root.needsSetup && !root.failed && root.note === ""
            width: parent.width
            text: "No agent has said it is waiting on you"
            textFormat: Text.PlainText
            color: root.dim
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
          visible: displayModel.count > 0 && Widget.detachKey(root.plugin)
          text: Widget.detachHint(root.plugin)
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
