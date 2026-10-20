import QtQuick
import qs.Commons
import qs.Ui
import "widget.mjs" as Widget

// One agent waiting on you, in the style of Omarchy's own omarchy.agents
// panel: its name, the kernel's message, then reason, producer and age
// (widget.mjs card, worked out once from `readAt`, when the read answered);
// the exact `since` in its tooltip. The bar panel (OatsBarWidget.qml) and the
// waiting popup (OatsWaiting.qml) both draw their cards with this one. It is
// highlighted on hover, or when `highlighted` (the popup's cursor); a click
// is `activated`, and the owner opens the session.
BorderSurface {
  id: waitingCard

  property string label: ""
  property var waitingOnYou: null
  property real readAt: 0
  property color foreground: Color.foreground
  property color dim: Qt.darker(foreground, 1.55)
  property string fontFamily: Style.font.family
  property bool highlighted: false
  readonly property bool hovered: cardMouse.containsMouse
  readonly property var shown: Widget.card(label, waitingOnYou, readAt)
  signal activated()

  readonly property bool lit: highlighted || cardMouse.containsMouse

  implicitHeight: cardLines.implicitHeight + Style.space(10) * 2
  radius: Style.cornerRadius
  color: lit ? Style.hoverFillFor(foreground, Color.accent) : "transparent"
  borderSpec: Border.controlSpec(lit ? "hover-cursor" : "normal", foreground, Color.accent)

  Column {
    id: cardLines
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    anchors.leftMargin: Style.space(12)
    anchors.rightMargin: Style.space(12)
    spacing: Style.space(2)

    Text {
      width: parent.width
      text: waitingCard.shown.title
      textFormat: Text.PlainText
      color: waitingCard.foreground
      font.family: waitingCard.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }
    Text {
      visible: text !== ""
      width: parent.width
      text: waitingCard.shown.message
      textFormat: Text.PlainText
      color: waitingCard.foreground
      font.family: waitingCard.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
      maximumLineCount: 4
      elide: Text.ElideRight
    }
    Text {
      visible: text !== ""
      width: parent.width
      text: waitingCard.shown.meta
      textFormat: Text.PlainText
      color: waitingCard.dim
      font.family: waitingCard.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }
  }

  MouseArea {
    id: cardMouse
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: waitingCard.activated()
  }

  PanelToolTip {
    visible: cardMouse.containsMouse && waitingCard.shown.since !== ""
    text: waitingCard.shown.since
  }
}
