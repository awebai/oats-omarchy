import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "widget.mjs" as Widget

// The OATS icon in the bar, with the number of agents waiting on you beside
// it, and a panel: those agents (a click opens the session), the TUI, the
// Desktop, and setup. Everything it runs or reads is built by widget.mjs from
// setup's plugin.json; this file only displays it, runs commands through the
// bar, and writes nothing. Without plugin.json, setup has not run, and the
// panel offers setup only.
//
// The count is `waiting --json` (bin/waiting.mjs), read on a timer and when
// the panel opens. One widget reads for every bar (the first the bar lists)
// and hands the result to the others; a read never overlaps another, and one
// that takes longer than READ_TIMEOUT_MS is stopped and shows "?".
Panel {
  id: root
  moduleName: "ai.aweb.oats"

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property string setupPath: Widget.urlPath(Qt.resolvedUrl("setup"))
  readonly property string pluginPath: Widget.pluginFilePath(Quickshell.env("HOME"), Quickshell.env("XDG_STATE_HOME"))

  // setup's commands, or null; the last read, or null before the first.
  property var plugin: null
  property var waiting: null
  property bool timedOut: false
  readonly property string badge: Widget.badge(waiting)
  readonly property var rows: waiting && waiting.known ? waiting.rows : []

  implicitWidth: bar_.implicitWidth
  implicitHeight: bar_.implicitHeight

  function runLine(line) {
    if (root.bar && line !== "") root.bar.run(line)
  }

  function peers() {
    return root.bar && typeof root.bar.moduleWidgets === "function" ? root.bar.moduleWidgets(root.moduleName) : []
  }

  function loadPlugin() {
    pluginFile.reload()
    root.plugin = Widget.parsePlugin(pluginFile.text())
  }

  // Read now, or let the reader do it; skipped while a read is running.
  function refresh() {
    root.loadPlugin()
    var all = root.peers()
    if (!Widget.isReader(all, root)) {
      if (typeof all[0].refresh === "function") all[0].refresh()
      return
    }
    if (reader.running) return
    if (!root.plugin) { root.share(null); return }
    root.timedOut = false
    reader.command = Widget.readArgv(root.plugin)
    reader.running = true
    readTimeout.restart()
  }

  function share(result) {
    var all = root.peers()
    for (var i = 0; i < all.length; i++)
      if (all[i] && all[i] !== root && typeof all[i].receive === "function") all[i].receive(result)
    root.waiting = result
  }

  function receive(result) { root.waiting = result }

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
    blockLoading: true
    watchChanges: true
    printErrors: false
    onFileChanged: root.loadPlugin()
  }

  Process {
    id: reader
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        readTimeout.stop()
        if (!root.timedOut) root.share(Widget.parseWaiting(text))
      }
    }
  }

  Timer {
    id: readTimeout
    interval: Widget.READ_TIMEOUT_MS
    onTriggered: {
      root.timedOut = true
      reader.running = false
      root.share({ known: false, reason: Widget.READ_TIMEOUT_REASON })
    }
  }

  Timer {
    interval: Widget.refreshMs(root.setting("refreshIntervalSec", 60))
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: if (Widget.isReader(root.peers(), root)) root.refresh()
  }

  Row {
    id: bar_
    spacing: 0

    BarIconButton {
      id: button
      bar: root.bar
      tooltipText: "OATS"
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
        if (buttonCode === Qt.RightButton) root.runLine(Widget.quickCommand(root.plugin, root.setupPath))
        else root.toggle()
      }
    }

    Text {
      visible: root.badge !== ""
      anchors.verticalCenter: button.verticalCenter
      rightPadding: Style.spacing.sm
      text: root.badge
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
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

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        width: parent.width
        spacing: Style.space(8)

        PanelSectionHeader {
          visible: root.rows.length > 0 || (!!root.waiting && !root.waiting.known)
          text: "Waiting on you"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        // The kernel's own words when the read failed.
        Text {
          visible: !!root.waiting && !root.waiting.known
          width: parent.width
          text: root.waiting && !root.waiting.known ? root.waiting.reason : ""
          textFormat: Text.PlainText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        Repeater {
          model: root.rows

          Button {
            required property var modelData
            width: column.width
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
          visible: root.rows.length > 0 || (!!root.waiting && !root.waiting.known)
          foreground: root.foreground
        }

        Button {
          visible: Widget.tuiCommand(root.plugin) !== ""
          width: column.width
          leftAlign: true
          text: "Open OATS TUI"
          foreground: root.foreground
          fontFamily: root.fontFamily
          onClicked: { root.runLine(Widget.tuiCommand(root.plugin)); root.close() }
        }

        Button {
          visible: Widget.desktopCommand(root.plugin) !== ""
          width: column.width
          leftAlign: true
          text: "Open OATS Desktop"
          foreground: root.foreground
          fontFamily: root.fontFamily
          onClicked: { root.runLine(Widget.desktopCommand(root.plugin)); root.close() }
        }

        Button {
          width: column.width
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
