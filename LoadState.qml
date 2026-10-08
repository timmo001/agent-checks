import QtQuick
import qs.Commons
import qs.Ui

// The not-yet-loaded states of a panel section: loading, running, error,
// empty and stale. Hidden once the section is loaded.
Item {
  id: root

  // One of "loading", "running", "error", "empty", "stale" or "loaded".
  property string status: "loading"
  property string message: ""
  property string retryText: "Retry"
  property bool retryable: status === "error" || status === "stale"
  property bool retryHasCursor: false
  property color foreground: Color.foreground
  property color warningColor: "#e5c07b"
  property color urgentColor: Color.urgent
  property string fontFamily: Style.font.family

  signal retryRequested()
  signal retryHovered()

  readonly property string icon: {
    if (status === "loading") return "󰔟"
    if (status === "running") return "󰑮"
    if (status === "error") return "󰅚"
    if (status === "stale") return "󰀪"
    return "󰋙"
  }
  readonly property color tone: status === "error" ? urgentColor
    : (status === "stale" || status === "running" ? warningColor : Qt.darker(foreground, 1.4))

  visible: status !== "loaded"
  width: parent ? parent.width : implicitWidth
  implicitHeight: visible ? Math.max(row.implicitHeight, retryButton.implicitHeight) + Style.space(8) : 0

  Row {
    id: row
    anchors.left: parent.left
    anchors.right: retryButton.visible ? retryButton.left : parent.right
    anchors.leftMargin: Style.space(8)
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(10)

    Text {
      width: Style.space(22)
      text: root.icon
      color: root.tone
      font.family: root.fontFamily
      font.pixelSize: Style.font.icon
      horizontalAlignment: Text.AlignHCenter
    }

    Text {
      width: Math.max(0, row.width - Style.space(32))
      anchors.verticalCenter: parent.verticalCenter
      text: root.message
      textFormat: Text.PlainText
      wrapMode: Text.WrapAtWordBoundaryOrAnywhere
      color: root.tone
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  PanelActionButton {
    id: retryButton
    visible: root.retryable
    anchors.right: parent.right
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    iconText: "󰑐"
    tooltipText: root.retryText
    foreground: root.foreground
    fontFamily: root.fontFamily
    hasCursor: root.retryHasCursor
    onHovered: function(hovered) { if (hovered) root.retryHovered() }
    onClicked: root.retryRequested()
  }
}
