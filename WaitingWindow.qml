import QtQuick
import Quickshell
import Quickshell.Wayland

// The waiting popup's window: a full-screen layer-shell surface over every
// window, as omarchy.clipboard's, that takes the keyboard while it is shown,
// with the theme's scrim; a click on the scrim dismisses it. The card goes in
// as its content. On a file of its own so the QML test, which runs offscreen
// where no layer-shell window exists, stands in for this one type alone.
PanelWindow {
  id: panel

  property color scrim: "transparent"
  signal dismissed()
  default property alias content: holder.data

  anchors { top: true; bottom: true; left: true; right: true }
  color: "transparent"
  WlrLayershell.namespace: "oats-waiting"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
  exclusionMode: ExclusionMode.Ignore

  Rectangle {
    anchors.fill: parent
    color: panel.scrim
  }

  MouseArea {
    anchors.fill: parent
    onClicked: panel.dismissed()
  }

  Item {
    id: holder
    anchors.fill: parent
  }
}
