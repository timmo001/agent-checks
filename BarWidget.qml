import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "timmo.agent-checks"

  readonly property bool primaryOnly: setting("primaryOnly", false)
  readonly property string preferredOutput: setting("primaryOutput", "")
  readonly property string currentOutput: {
    var window = root.QsWindow ? root.QsWindow.window : null
    return window && window.screen ? String(window.screen.name || "") : ""
  }
  readonly property string activeOutput: {
    var screens = Quickshell.screens
    for (var i = 0; i < screens.length; i++)
      if (root.preferredOutput !== "" && screens[i].name === root.preferredOutput)
        return root.preferredOutput
    return screens.length > 0 ? String(screens[0].name || "") : ""
  }
  readonly property bool activeInstance: !primaryOnly
    || (currentOutput !== "" && currentOutput === activeOutput)
  readonly property var checks: bar && bar.shell ? bar.shell.serviceFor("timmo.agent-checks") : null
  readonly property var entry: checks ? checks.focused : null
  property var pendingOpen: null
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true : false
  readonly property real openPanelIndicatorWidth: content.implicitWidth
  readonly property var displaySegments: {
    if (!entry || !checks || checks.stale) return []
    var segments = []
    if (entry.lintIndicator)
      segments.push({ text: entry.lintIndicator.replace(" ", "\u2002"), color: lintColor() })
    if (entry.ciIndicator)
      segments.push({ text: entry.ciIndicator.replace(" ", "\u2002"), color: ciColor() })
    if (entry.reviewsIndicator)
      segments.push({ text: entry.reviewsIndicator.replace(" ", "\u2002"), color: reviewsColor() })
    return segments
  }
  readonly property string tooltipText: {
    if (!entry) return ""
    var lines = []
    if (entry.target) lines.push(entry.target.repository + " · " + entry.target.branch)
    else if (entry.root) lines.push(entry.root)
    if (entry.reviews) lines.push("#" + entry.reviews.number + " " + entry.reviews.title)
    if (entry.ciError) lines.push("CI: " + entry.ciError)
    if (entry.reviewsError) lines.push("Reviews: " + entry.reviewsError)
    return lines.join("\n")
  }

  // Matches the Herdr sidebar colours.
  function lintColor() {
    var tone = checks.lintTone(entry.lint)
    if (tone === "failed") return "#f38ba8"
    if (tone === "running" || tone === "error") return "#f9e2af"
    return tone === "ok" ? "#a6e3a1" : "#73758a"
  }

  function ciColor() {
    if (entry.ciError) return "#f9e2af"
    if (entry.target && !entry.ci) return "#89b4fa"
    var tone = checks.ciTone(entry.ci, null)
    if (entry.ciIndicator.indexOf("↶") >= 0) {
      if (tone === "ok") return "#7f9f7a"
      return tone === "running" ? "#b3a078" : "#b07883"
    }
    if (tone === "failed") return "#f38ba8"
    if (tone === "running") return "#f9e2af"
    return tone === "ok" ? "#a6e3a1" : "#73758a"
  }

  function reviewsColor() {
    var tone = checks.reviewsTone(entry.reviews, entry.reviewsError)
    if (tone === "failed") return "#f38ba8"
    if (tone === "running" || tone === "error") return "#f9e2af"
    return tone === "ok" ? "#a6e3a1" : "#73758a"
  }

  function activeWidget() {
    if (root.activeInstance) return root
    var items = root.bar && typeof root.bar.moduleWidgets === "function"
      ? root.bar.moduleWidgets(root.moduleName) : []
    for (var i = 0; i < items.length; i++)
      if (items[i] && items[i].activeInstance === true) return items[i]
    return null
  }

  // `mode` is overview, ci, lint or reviews; an empty cwd or pane means the focused one.
  function open(mode, cwd, pane) {
    var widget = activeWidget()
    if (widget && widget !== root) { widget.open(mode, cwd, pane); return }
    var request = { mode: mode || "overview", cwd: cwd || "", pane: pane || "" }
    if (panelLoader.item) {
      pendingOpen = null
      panelLoader.item.open(request)
      return
    }
    pendingOpen = request
    panelLoader.active = true
  }
  function close() {
    var widget = activeWidget()
    if (widget && widget !== root) { widget.close(); return }
    pendingOpen = null
    if (panelLoader.item) panelLoader.item.close()
  }
  function togglePanel() {
    var widget = activeWidget()
    if (widget && widget !== root) { widget.togglePanel(); return }
    if (panelLoader.item && panelLoader.item.opened) panelLoader.item.close()
    else open("overview")
  }
  function closeForPopoutSwitch() {
    var widget = activeWidget()
    if (widget && widget !== root) { widget.closeForPopoutSwitch(); return }
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }
  function injectPanel() {
    var panel = panelLoader.item
    if (!panel) return
    panel.bar = root.bar
    panel.settings = root.settings
    panel.anchorItem = button
    panel.hostWidget = root
    panel.service = root.checks
  }

  visible: activeInstance
  implicitWidth: activeInstance && displaySegments.length > 0 ? button.implicitWidth : 0
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()
  onChecksChanged: injectPanel()

  Loader {
    id: panelLoader
    active: false
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
      if (root.pendingOpen) {
        var request = root.pendingOpen
        root.pendingOpen = null
        item.open(request)
      }
    }
  }

  Loader {
    active: root.activeInstance
    sourceComponent: Component {
      IpcHandler {
        target: "timmo.agent-checks"
        function open(): void { root.open("overview") }
        function ci(cwd: string, pane: string): void { root.open("ci", cwd, pane) }
        function lint(cwd: string, pane: string): void { root.open("lint", cwd, pane) }
        function reviews(cwd: string, pane: string): void { root.open("reviews", cwd, pane) }
        function toggle(): void { root.togglePanel() }
        function close(): void { root.close() }
      }
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    visible: root.displaySegments.length > 0
    bar: root.bar
    fontSize: 10
    labelVisible: false
    hasVisualContent: root.displaySegments.length > 0
    fixedWidth: vertical ? -1 : Math.max(12, content.implicitWidth + scaledHorizontalMargin * 2)
    tooltipText: root.tooltipText
    horizontalMargin: 6
    onPressed: function(buttonCode) { root.togglePanel() }

    Row {
      id: content
      anchors.centerIn: parent
      spacing: 10
      Repeater {
        model: root.displaySegments
        Text {
          required property var modelData
          text: modelData.text
          color: modelData.color
          font.family: button.fontFamily
          font.pixelSize: button.fontSize
          renderType: Text.NativeRendering
        }
      }
    }
  }
}
