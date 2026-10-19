import QtQuick
import QtQuick.Effects
import qs.Ui
import "widget.mjs" as Widget

// The OATS icon in the bar. A click opens the OATS TUI, or, before setup has
// run, setup's plan in a floating terminal (widget.mjs). It reads nothing and
// writes nothing.
BarWidget {
  id: root
  moduleName: "ai.aweb.oats"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property string setupPath: Widget.urlPath(Qt.resolvedUrl("setup"))

  BarIconButton {
    id: button
    anchors.fill: parent
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
      if (root.bar) root.bar.run(Widget.clickCommand(root.setupPath))
    }
  }
}
