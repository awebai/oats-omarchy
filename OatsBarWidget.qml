import QtQuick
import QtQuick.Controls
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "widget.mjs" as Widget

// The OATS icon in the bar, and a panel: the agents waiting on you (a click
// opens the session), the TUI, the Desktop, and setup. Everything it runs or
// reads is built by widget.mjs from setup's plugin.json; this file only displays it, runs commands through the
// bar, and writes nothing. Without plugin.json, setup has not run: a click
// on the icon runs the whole setup in a floating terminal instead
// (widget.mjs clickAction), and the tooltip says so.
//
// The rows are `waiting --json` (bin/waiting.mjs), read only when the panel
// opens, after plugin.json is read again: nothing is read in the background,
// and the icon shows no count. The panel says it is reading until the read
// answers. One widget reads for every bar (the first the bar lists) and hands
// the result to the others. A read never overlaps another (widget.mjs's read
// state), and one that has not answered by READ_TIMEOUT_MS, or whose program
// could not start, is stopped and shows why in the panel. Stopping waiting
// stops the kernel's read with it.
Panel {
  id: root
  moduleName: "ai.aweb.oats"

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property string setupPath: Widget.urlPath(Qt.resolvedUrl("setup"))
  readonly property string pluginPath: Widget.pluginFilePath(Quickshell.env("HOME"), Quickshell.env("XDG_STATE_HOME"))

  // setup's commands, or null; this opening's read, or null until it
  // answers; and whether it is being read.
  property var plugin: null
  property var waiting: null
  property bool reading: false
  readonly property var rows: waiting && waiting.known ? waiting.rows : []
  readonly property bool failed: !!waiting && !waiting.known
  // The read: its state, the read the process runs, and whether a
  // read waits for plugin.json to be read first.
  property var readState: Widget.newReadState()
  property int readAttempt: 0
  property bool readAfterLoad: false

  implicitWidth: bar_.implicitWidth
  implicitHeight: bar_.implicitHeight

  function runLine(line) {
    if (root.bar && line !== "") root.bar.run(line)
  }

  function peers() {
    return root.bar && typeof root.bar.moduleWidgets === "function" ? root.bar.moduleWidgets(root.moduleName) : []
  }

  // plugin.json as just read (null when it is gone), then the read that
  // waited for it.
  function pluginLoaded(parsed) {
    root.plugin = parsed
    if (root.readAfterLoad) {
      root.readAfterLoad = false
      root.startRead()
    }
  }

  // Read plugin.json again, then the rows, fresh: here, or by the reader.
  function refresh() {
    root.waiting = null
    root.reading = true
    var all = root.peers()
    if (Widget.isReader(all, root)) root.readAfterLoad = true
    else if (typeof all[0].refresh === "function") all[0].refresh()
    pluginFile.reload()
  }

  function startRead() {
    if (!root.plugin) { root.share(null); return }
    if (reader.running) return
    var attempt = Widget.beginRead(root.readState)
    if (!attempt) return
    root.readAttempt = attempt
    reader.command = Widget.readArgv(root.plugin)
    reader.running = true
    readTimeout.restart()
  }

  function share(result) {
    var all = root.peers()
    for (var i = 0; i < all.length; i++)
      if (all[i] && all[i] !== root && typeof all[i].receive === "function") all[i].receive(result)
    root.receive(result)
  }

  function receive(result) {
    root.waiting = result
    root.reading = false
  }

  onOpenedChanged: if (opened) {
    root.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Component.onDestruction: {
    readTimeout.stop()
    if (reader.running) reader.running = false
  }

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
          root.share(result)
        }
      }
    }
  }

  // The read's deadline: it also settles a read whose program never started.
  Timer {
    id: readTimeout
    interval: Widget.READ_TIMEOUT_MS
    onTriggered: {
      var result = Widget.expireRead(root.readState, root.readAttempt)
      if (result) {
        reader.running = false
        root.share(result)
      }
    }
  }

  Row {
    id: bar_
    spacing: 0

    BarIconButton {
      id: button
      bar: root.bar
      tooltipText: Widget.tooltip(root.plugin)
      iconComponent: Component {
        Item {
          Image {
            id: mark
            anchors.fill: parent
            source: Qt.resolvedUrl("assets/oats-256.png")
            sourceSize.width: 64
            sourceSize.height: 64
            fillMode: Image.PreserveAspectFit
            // Hidden, so the effect can sample it as a texture.
            visible: false
            layer.enabled: true
          }
          MultiEffect {
            anchors.fill: mark
            source: mark
            colorization: 1.0
            colorizationColor: button.foreground
          }
        }
      }
      onPressed: function(buttonCode) {
        var action = Widget.clickAction(root.plugin, root.setupPath, buttonCode === Qt.RightButton)
        if (action.toggle) root.toggle()
        else root.runLine(action.line)
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(300))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(480))

    // The rows scroll in what the launchers and the read's reason leave of
    // the panel, so those always stay in view however many rows there are.
    // The card is capped at 480 or the screen, whichever is less; its body is that less the inset.
    readonly property real bodyHeight: Math.min(Style.space(480), panel.availableCardHeight > 0 ? panel.availableCardHeight : Style.space(480)) - panel.verticalContentInset
    readonly property real rowsCap: Math.max(Style.space(64), bodyHeight - above.implicitHeight - below.implicitHeight - column.spacing * 2)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dy !== 0) rowsFlick.contentY = Math.max(0, Math.min(rowsFlick.contentHeight - rowsFlick.height, rowsFlick.contentY + dy * Style.space(40)))
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(8)

        // That the rows are being read; the kernel's own words when the
        // read failed.
        Column {
          id: above
          width: parent.width
          Text {
            visible: root.reading
            width: parent.width
            text: "Reading who is waiting on you\u2026"
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
          Text {
            visible: root.failed
            width: parent.width
            text: root.failed ? root.waiting.reason : ""
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }

        Flickable {
          id: rowsFlick
          visible: root.rows.length > 0
          width: parent.width
          height: visible ? Math.min(rows.implicitHeight, panel.rowsCap) : 0
          contentWidth: width
          contentHeight: rows.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Column {
            id: rows
            width: rowsFlick.width

            Repeater {
              model: root.rows

              Button {
                required property var modelData
                width: rows.width
                leftAlign: true
                text: modelData.instance
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: {
                  root.runLine(Widget.attachCommand(root.plugin, modelData.home))
                  root.close()
                }
              }
            }
          }
        }

        Column {
          id: below
          width: parent.width
          spacing: Style.space(8)

          Text {
            visible: root.rows.length > 0 && Widget.detachKey(root.plugin)
            width: parent.width
            text: "Alt+O leaves the viewer"
            textFormat: Text.PlainText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          PanelSeparator {
            visible: root.rows.length > 0 || root.failed || root.reading
            foreground: root.foreground
          }

          Button {
            visible: Widget.tuiCommand(root.plugin) !== ""
            width: parent.width
            leftAlign: true
            text: "Open OATS TUI"
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: { root.runLine(Widget.tuiCommand(root.plugin)); root.close() }
          }

          Button {
            visible: Widget.desktopCommand(root.plugin) !== ""
            width: parent.width
            leftAlign: true
            text: "Open OATS Desktop"
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: { root.runLine(Widget.desktopCommand(root.plugin)); root.close() }
          }

          Button {
            width: parent.width
            leftAlign: true
            text: "Set up keys and launchers"
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: { root.runLine(Widget.setupCommand(root.plugin, root.setupPath)); root.close() }
          }
        }
      }
    }
  }
}
