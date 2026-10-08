import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "timmo.agent-checks"

  property var anchorItem: null
  property var hostWidget: null
  property var service: null

  // overview, ci or lint; "agent" picks a launcher for agentKind.
  property string mode: "overview"
  property string view: "checks"
  property string cwd: ""
  property string paneId: ""
  property string expandedKey: ""

  property var checkout: null
  property string statusError: ""
  property var ciReport: null
  property string ciReportKey: ""
  property string ciReportError: ""
  property string lintError: ""
  property var launchers: []
  property string launchersError: ""
  property string agentKind: ""
  property bool agentWorktree: false
  property int agentRun: -1
  property string actionError: ""
  property string copiedKey: ""

  readonly property var barIdentity: hostWidget || root
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color urgentColor: bar ? bar.urgent : Color.urgent
  readonly property color warningColor: "#e5c07b"
  readonly property color successColor: "#98c379"
  readonly property color mutedColor: Qt.darker(contentForeground, 1.4)
  readonly property real now: service ? service.currentTime : Date.now()

  readonly property bool ready: service !== null && service.ready && cwd !== ""
  readonly property var ci: checkout ? checkout.ci : null
  readonly property var lint: checkout ? checkout.lint : null
  readonly property var runs: service ? service.ciRuns(ci) : []
  readonly property var failedRuns: runs.filter(function(run) { return service.attention(run.conclusion) })
  readonly property string ciTone: service && checkout ? service.ciTone(ci, checkout.ciError) : "none"
  readonly property string lintTone: service ? service.lintTone(lint) : "none"
  readonly property var lintChecks: lint && lint.result ? lint.result.checks : []
  readonly property var failingChecks: lintChecks.filter(function(check) { return check.status === "failed" || check.status === "timedOut" })
  readonly property bool ciReady: ciReport !== null && ciReportKey === failedRunsKey
  readonly property string failedRunsKey: ci ? failedRuns.map(function(run) {
    return run.id + "." + run.run_attempt
  }).join(",") : ""

  readonly property var ciSection: sectionState("ci")
  readonly property var lintSection: sectionState("lint")
  readonly property var modeSection: mode === "lint" ? lintSection : ciSection
  readonly property var panelRows: buildPanelRows()

  // Each section's status, message and the retry action its refresh button runs.
  function sectionState(kind) {
    if (!service) return { status: "error", message: "The Agent Checks service is not loaded", retry: "" }
    if (!service.ready)
      return { status: service.errorText ? "error" : "loading", message: service.errorText || "Finding the Herdr plugin", retry: "" }
    if (statusError) return { status: "error", message: statusError, retry: "status" }
    if (!checkout) return { status: "loading", message: "Reading " + cwd, retry: "" }
    return kind === "ci" ? ciState() : lintState()
  }

  function ciState() {
    if (!checkout.watched || service.stale)
      return { status: "stale", message: !checkout.watched
        ? "The watcher is not following this checkout. Start it to see CI."
        : "The watcher last updated " + relative(service.updated) + ".", retry: "watcher" }
    if (!checkout.target) return { status: "empty", message: "Not on a branch with a GitHub remote", retry: "" }
    if (checkout.ciError) return { status: "error", message: checkout.ciError, retry: "status" }
    if (checkout.ciPending) return { status: "loading", message: "Waiting for GitHub", retry: "" }
    if (!ci) return { status: "empty", message: checkout.target.branch + " has not been pushed", retry: "" }
    if (ciTone === "failed") {
      if (ciReportError) return { status: "error", message: ciReportError, retry: "ci" }
      if (!ciReady) return { status: "loading", message: "Fetching failed-step logs", retry: "" }
      return { status: "loaded", message: "", retry: "" }
    }
    if (ciTone === "running") return { status: "running", message: inProgressText(), retry: "" }
    if (ciTone === "ok") return { status: "empty", message: "All runs passed" + previousText(), retry: "" }
    return { status: "empty", message: "No workflow runs on " + shortSha(ci.sha), retry: "" }
  }

  function lintState() {
    if (lintError) return { status: "error", message: lintError, retry: "lint" }
    if (!lint) return { status: lintProcess.running ? "loading" : "empty",
      message: lintProcess.running ? "Checking the working tree" : "No lint result yet", retry: lintProcess.running ? "" : "lint" }
    if (lint.running) return { status: "running", message: "Lint running" + (lint.started ? " since " + relative(lint.started) : ""), retry: "" }
    var result = lint.result
    if (!result) return { status: "empty", message: "No lint result yet", retry: "lint" }
    if (result.status === "error") return { status: "error", message: "Lint could not run: " + (result.error || "unknown error"), retry: "lint" }
    if (result.status === "unconfigured") return { status: "empty", message: "No lint checks configured", retry: "" }
    if (result.status === "clean")
      return { status: "empty", message: "Clean · " + result.files + " changed file" + (result.files === 1 ? "" : "s") + " · " + relative(result.finished), retry: "lint" }
    return { status: "loaded", message: "", retry: "" }
  }

  function buildPanelRows() {
    if (view === "agent")
      return [backRow("Back")].concat(launchers.map(function(launcher) {
        return { key: "launcher:" + launcher.id, action: "launcher", launcher: launcher.id, primaryText: launcher.label, icon: "󱚣" }
      }))
    if (mode === "overview")
      return [
        { key: "section:ci", action: "mode", target: "ci", primaryText: "CI", secondaryText: summaryText("ci"), icon: "󰊤" },
        { key: "section:lint", action: "mode", target: "lint", primaryText: "Lint", secondaryText: summaryText("lint"), icon: "󰁨" }
      ]
    var rows = [backRow("Back to overview")]
    if (mode === "ci") {
      rows = rows.concat(runs.map(function(run) {
        return { key: "run:" + run.id, run: run, primaryText: run.name || run.display_title, secondaryText: runText(run) }
      }))
      if (ciTone === "failed") rows = rows.concat(actionRows("ci"))
    } else {
      rows = rows.concat(lintChecks.map(function(check) {
        return { key: "check:" + check.name, check: check, primaryText: check.name, secondaryText: checkText(check) }
      }))
      if (lintTone === "failed") rows = rows.concat(actionRows("lint"))
    }
    return rows
  }

  function backRow(label) {
    return { key: "action:back", action: "back", navigation: true, primaryText: label }
  }

  function actionRow(action, label, icon) {
    return { key: "action:" + action, action: action, primaryText: label, icon: icon }
  }

  function actionRows(kind) {
    var rows = [
      actionRow("paste", "Paste into " + (paneId || "the agent"), "󰆒"),
      actionRow("copy", copiedKey === kind ? "Copied" : "Copy the prompt", "󰆏"),
      actionRow("launch", "Fix in a new agent here", "󱚣")
    ]
    if (kind === "ci") {
      rows.push(actionRow("worktree", "Fix in a new agent in a worktree", "󰙅"))
      rows.push(actionRow("browser", "Open the Actions page", "󰖟"))
    }
    return rows
  }

  function summaryText(kind) {
    var state = kind === "ci" ? ciSection : lintSection
    if (state.status !== "loaded") return state.message
    if (kind === "ci") return failedRuns.length + " failed run" + (failedRuns.length === 1 ? "" : "s") + previousText()
    var failed = failingChecks.length
    return failed + " failing check" + (failed === 1 ? "" : "s")
  }

  function toneColor(tone) {
    if (tone === "failed" || tone === "error") return urgentColor
    if (tone === "running") return warningColor
    if (tone === "ok") return successColor
    return mutedColor
  }

  function toneIcon(tone) {
    if (tone === "failed") return "󰅚"
    if (tone === "error") return "󰀪"
    if (tone === "running") return "󰦖"
    if (tone === "ok") return "󰗠"
    return "󰋙"
  }

  function stateIcon(status) {
    if (status === "error") return "󰅚 "
    if (status === "stale") return "󰀪 "
    if (status === "running") return "󰦖 "
    if (status === "loading") return "󰔟 "
    return ""
  }

  function runTone(run) {
    if (service.attention(run.conclusion)) return "failed"
    if (run.status !== "completed") return "running"
    return run.conclusion === "success" ? "ok" : "none"
  }

  function runText(run) {
    return (run.status === "completed" ? (run.conclusion || "completed") : run.status.replace("_", " "))
      + (run.run_attempt > 1 ? " · attempt " + run.run_attempt : "")
  }

  function checkTone(check) {
    if (check.status === "passed") return "ok"
    if (check.status === "skipped") return "none"
    return "failed"
  }

  function checkText(check) {
    if (check.status === "skipped") return "skipped · no matching changed files"
    if (check.status === "passed") return "passed" + (check.durationMs !== null ? " in " + (check.durationMs / 1000).toFixed(1) + "s" : "")
    return check.command
  }

  function inProgressText() {
    var count = runs.filter(function(run) { return run.status !== "completed" }).length
    return count + " run" + (count === 1 ? "" : "s") + " in progress" + previousText()
  }

  function previousText() {
    if (!ci || ci.runs.length > 0 || !ci.previous) return ""
    var behind = ci.previous.commitsBehind
    return " · from " + behind + " commit" + (behind === 1 ? "" : "s") + " ago"
  }

  function shortSha(sha) { return String(sha || "").slice(0, 7) }

  // Names the pushed commit the shown runs belong to, which is an older one
  // when the latest commit has no runs yet.
  function ciBadge() {
    if (!ci || view !== "checks" || mode === "lint") return ""
    if (ci.runs.length === 0 && ci.previous) return "CI on " + shortSha(ci.previous.sha) + " (older)"
    return "CI on " + shortSha(ci.sha)
  }

  function span(milliseconds) {
    var seconds = Math.max(0, Math.round(milliseconds / 1000))
    if (seconds < 60) return seconds + "s"
    var minutes = Math.round(seconds / 60)
    if (minutes < 60) return minutes + "m"
    var hours = Math.round(minutes / 60)
    if (hours < 48) return hours + "h"
    return Math.round(hours / 24) + "d"
  }

  function relative(timestamp) {
    if (!timestamp) return ""
    var difference = Math.max(0, now - timestamp)
    return difference < 60000 ? "just now" : span(difference) + " ago"
  }

  function reportFor(run) {
    if (!ciReady) return null
    for (var i = 0; i < ciReport.runs.length; i++)
      if (ciReport.runs[i].id === run.id) return ciReport.runs[i]
    return null
  }

  function heroMeta() {
    if (checkout && checkout.target) return checkout.target.repository + " · " + checkout.target.branch
    return checkout ? checkout.root : cwd
  }

  function cli(args) {
    return service.command(args.concat(["--cwd", cwd, "--json"]))
  }

  // Paste and launch act on the pane the panel was opened for.
  function paneArgs() {
    return paneId ? ["--pane", paneId] : []
  }

  function refreshStatus() {
    if (!ready || statusProcess.running) return
    statusProcess.command = cli(["status"])
    statusProcess.running = true
  }

  function runLint(force) {
    if (!ready || lintProcess.running) return
    lintError = ""
    lintProcess.command = cli(["lint", "check"].concat(force ? ["--force"] : []))
    lintProcess.running = true
  }

  function loadCiReport() {
    if (!ready || ciTone !== "failed" || ciProcess.running || ciReportKey === failedRunsKey) return
    ciReportError = ""
    ciProcess.key = failedRunsKey
    ciProcess.command = cli(["ci", "logs"])
    ciProcess.running = true
  }

  function retry(action) {
    if (action === "status") { statusError = ""; refreshStatus() }
    else if (action === "watcher") { service.startWatcher(); refreshSoon.restart() }
    else if (action === "ci") { ciReportKey = ""; ciReport = null; loadCiReport() }
    else if (action === "lint") runLint(true)
  }

  function refresh() {
    refreshStatus()
    if (mode !== "ci") runLint(false)
  }

  function runAction(args, closeOnSuccess) {
    if (actionProcess.running) return
    actionError = ""
    actionProcess.closeOnSuccess = closeOnSuccess
    actionProcess.command = cli(args)
    actionProcess.running = true
  }

  function promptFor(kind) {
    return kind === "ci" ? (ciReady ? ciReport.prompt : "") : (checkout ? checkout.lintPrompt || "" : "")
  }

  function copy(kind) {
    var text = promptFor(kind)
    if (!text) return
    Quickshell.execDetached(["bash", "-c", "printf %s \"$1\" | wl-copy", "bash", text])
    copiedKey = kind
    copiedReset.restart()
  }

  function showAgentPicker(kind, worktree, run) {
    agentKind = kind
    agentWorktree = worktree
    agentRun = run === undefined ? -1 : run
    launchers = []
    launchersError = ""
    launchersProcess.command = cli(["launchers"])
    launchersProcess.running = true
    showView("agent")
  }

  function launch(launcherId) {
    var args = ["launch", "--kind", agentKind, "--launcher", launcherId].concat(paneArgs())
    if (agentWorktree) args.push("--worktree")
    if (agentRun >= 0) args = args.concat(["--run", String(agentRun)])
    runAction(args, true)
  }

  function activateAction(entry) {
    var kind = mode
    if (entry.action === "back") {
      if (view === "agent") showView("checks")
      else setMode("overview")
    } else if (entry.action === "mode") setMode(entry.target)
    else if (entry.action === "paste") runAction(["paste", "--kind", kind].concat(paneArgs()), true)
    else if (entry.action === "copy") copy(kind)
    else if (entry.action === "launch") showAgentPicker(kind, false)
    else if (entry.action === "worktree") showAgentPicker("ci", true)
    else if (entry.action === "browser") runAction(["browser"], false)
    else if (entry.action === "launcher") launch(entry.launcher)
  }

  function activateEntry(entry) {
    if (!entry) return
    if (entry.action) { activateAction(entry); return }
    expandedKey = expandedKey === entry.key ? "" : entry.key
    Qt.callLater(scrollCursorIntoView)
  }

  function setMode(next) {
    mode = next
    expandedKey = ""
    if (next === "ci") loadCiReport()
    if (next === "lint" && !lint && !lintProcess.running) runLint(false)
    showView("checks")
  }

  function cycleMode(direction) {
    if (view !== "checks") return
    var modes = ["overview", "ci", "lint"]
    setMode(modes[(modes.indexOf(mode) + direction + modes.length) % modes.length])
  }

  function showView(next) {
    view = next
    actionError = ""
    filterController.reset()
    panelFlick.contentY = 0
  }

  // `request` is { mode, cwd, pane }; empty values fall back to the focused pane.
  function open(request) {
    var nextCwd = request.cwd || (service ? service.repositoryPath : "")
    if (nextCwd !== cwd) {
      checkout = null
      ciReport = null
      ciReportKey = ""
    }
    cwd = nextCwd
    paneId = request.pane || (service ? service.paneId : "")
    statusError = ""
    ciReportError = ""
    lintError = ""
    mode = request.mode || "overview"
    expandedKey = ""
    showView("checks")
    refresh()
    controller.show()
    Qt.callLater(function() { filterController.forceActiveFocus() })
  }
  function close() { controller.hide() }
  function toggle() { if (opened) close(); else open({ mode: "overview" }) }

  function scrollCursorIntoView() {
    var entry = filterController.selectedEntry()
    var item = !entry ? null : (entry.navigation === true ? panelHeader : rowRepeater.itemAt(rowEntries.indexOf(entry)))
    if (!item) return
    var point = item.mapToItem(contentColumn, 0, 0)
    if (point.y < panelFlick.contentY) panelFlick.contentY = point.y
    else if (point.y + item.height > panelFlick.contentY + panelFlick.height)
      panelFlick.contentY = point.y + item.height - panelFlick.height
  }

  readonly property var rowEntries: filterController.filteredModel.filter(function(entry) { return entry.navigation !== true })

  onReadyChanged: if (opened && ready) refresh()
  onFailedRunsKeyChanged: if (opened && mode !== "lint") loadCiReport()
  onCiToneChanged: if (opened && mode !== "lint") loadCiReport()

  Connections {
    target: root.service
    function onPublished() { if (root.opened) root.refreshStatus() }
  }

  Process {
    id: statusProcess
    stdout: StdioCollector {
      id: statusOutput
      waitForEnd: true
    }
    stderr: StdioCollector { id: statusErrors; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.statusError = String(statusErrors.text || "Could not read the checkout status").trim()
        return
      }
      try {
        root.checkout = JSON.parse(statusOutput.text)
        root.statusError = ""
      } catch (error) {
        root.statusError = "Invalid checkout status"
      }
    }
  }

  Process {
    id: lintProcess
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { id: lintErrors; waitForEnd: true }
    onRunningChanged: if (running) root.refreshStatus()
    onExited: function(exitCode) {
      if (exitCode !== 0) root.lintError = String(lintErrors.text || "Lint could not run").trim()
      root.refreshStatus()
    }
  }

  Process {
    id: ciProcess
    property string key: ""
    stdout: StdioCollector { id: ciOutput; waitForEnd: true }
    stderr: StdioCollector { id: ciErrors; waitForEnd: true }
    onExited: function(exitCode) {
      root.ciReportKey = ciProcess.key
      if (exitCode !== 0) {
        root.ciReport = null
        root.ciReportError = String(ciErrors.text || "Could not fetch the failed runs").trim()
        return
      }
      try { root.ciReport = JSON.parse(ciOutput.text) }
      catch (error) { root.ciReportError = "Invalid CI report" }
    }
  }

  Process {
    id: launchersProcess
    stdout: StdioCollector { id: launchersOutput; waitForEnd: true }
    stderr: StdioCollector { id: launchersErrors; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.launchersError = String(launchersErrors.text || "Could not list agents").trim()
        return
      }
      try { root.launchers = JSON.parse(launchersOutput.text) }
      catch (error) { root.launchersError = "Invalid launcher list" }
    }
  }

  Process {
    id: actionProcess
    property bool closeOnSuccess: false
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { id: actionErrors; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.actionError = String(actionErrors.text || "The action failed").trim()
      else if (actionProcess.closeOnSuccess) root.close()
    }
  }

  Timer {
    id: refreshSoon
    interval: 2000
    onTriggered: root.refreshStatus()
  }

  Timer {
    id: copiedReset
    interval: 2000
    onTriggered: root.copiedKey = ""
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: filterController
    contentWidth: panel.fittedContentWidth(Style.space(560))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight, Style.space(720))

    FilterablePanel {
      id: filterController
      anchors.fill: parent
      model: root.panelRows
      bypassFilter: true
      backOnEmptyFilter: root.view === "agent" || root.mode !== "overview"
      onActivateRequested: function(entry) { root.activateEntry(entry) }
      onBackRequested: root.activateAction({ action: "back" })
      onRevealRequested: Qt.callLater(root.scrollCursorIntoView)
      onCloseRequested: {
        if (root.view === "agent") root.showView("checks")
        else if (root.mode !== "overview") root.setMode("overview")
        else root.close()
      }
      onTabRequested: function(direction) { root.cycleMode(direction) }
      onRefreshRequested: root.refresh()

      PanelFlickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: contentColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: contentColumn
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHeader {
            id: panelHeader
            backText: root.view === "agent" ? "Back" : (root.mode !== "overview" ? "Back to overview" : "")
            backHasCursor: filterController.cursorIndex === filterController.indexForKey("action:back")
            onBackHovered: filterController.cursorIndex = filterController.indexForKey("action:back")
            onBackActivated: root.activateAction({ action: "back" })
            title: root.view === "agent" ? "Fix in a new agent" : (root.mode === "ci" ? "CI" : (root.mode === "lint" ? "Lint" : "Agent Checks"))
            meta: root.heroMeta()
            detail: root.ciBadge()
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            iconComponent: Component {
              Text {
                text: root.mode === "lint" ? "󰁨" : "󰊤"
                color: root.toneColor(root.mode === "lint" ? root.lintTone : root.ciTone)
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.display
              }
            }
          }

          ButtonGroup {
            visible: root.view === "checks"
            focusable: false
            options: [
              { value: "overview", label: "Overview" },
              { value: "ci", label: "CI" },
              { value: "lint", label: "Lint" }
            ]
            value: root.mode
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            fontSize: Style.font.caption
            onChanged: function(value) { root.setMode(value) }
          }

          SectionHeading {
            id: sectionHeading
            visible: root.view === "checks" && root.mode !== "overview"
            title: root.mode === "ci" ? "Workflow runs" : "Checks"
            foreground: root.contentForeground
            fontFamily: root.contentFontFamily
            refreshable: true
            refreshing: statusProcess.running || lintProcess.running || ciProcess.running
            // The section's state sits in the heading; the refresh button retries whatever it needs.
            trailingControl: root.modeSection.status !== "loaded" ? headingState : null
            onRefreshRequested: root.retry(root.modeSection.retry || root.mode)
          }

          Component {
            id: headingState

            Text {
              readonly property string status: root.modeSection.status
              width: Math.min(implicitWidth, sectionHeading.width * 0.6)
              text: root.stateIcon(status) + root.modeSection.message
              textFormat: Text.PlainText
              wrapMode: Text.WrapAtWordBoundaryOrAnywhere
              maximumLineCount: 2
              elide: Text.ElideRight
              horizontalAlignment: Text.AlignRight
              color: status === "error" ? root.urgentColor
                : (status === "stale" || status === "running" ? root.warningColor : Qt.darker(root.contentForeground, 1.4))
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(2)

            Repeater {
              id: rowRepeater
              model: root.rowEntries

              CursorSurface {
                id: rowSurface
                required property var modelData
                readonly property bool expanded: root.expandedKey === modelData.key
                readonly property var report: modelData.run ? root.reportFor(modelData.run) : null
                readonly property string tone: modelData.run ? root.runTone(modelData.run)
                  : (modelData.check ? root.checkTone(modelData.check)
                    : (modelData.key === "section:ci" ? root.ciTone : (modelData.key === "section:lint" ? root.lintTone : "")))
                width: contentColumn.width
                implicitHeight: rowColumn.implicitHeight + Style.space(12)
                hasCursor: filterController.cursorIndex === filterController.indexForKey(modelData.key)
                foreground: root.contentForeground
                accent: tone ? root.toneColor(tone) : root.contentForeground

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onEntered: filterController.cursorIndex = filterController.indexForKey(rowSurface.modelData.key)
                  onClicked: root.activateEntry(rowSurface.modelData)
                }

                Column {
                  id: rowColumn
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.space(8)
                  anchors.rightMargin: Style.space(8)
                  spacing: Style.space(6)

                  Item {
                    width: parent.width
                    implicitHeight: Math.max(textColumn.implicitHeight, rowActions.implicitHeight)

                    Text {
                      id: rowIcon
                      anchors.left: parent.left
                      anchors.verticalCenter: parent.verticalCenter
                      width: Style.space(22)
                      text: rowSurface.modelData.icon || root.toneIcon(rowSurface.tone)
                      color: rowSurface.tone ? root.toneColor(rowSurface.tone) : root.contentForeground
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.icon
                      horizontalAlignment: Text.AlignHCenter
                    }

                    Column {
                      id: textColumn
                      anchors.left: rowIcon.right
                      anchors.leftMargin: Style.space(10)
                      anchors.right: rowActions.left
                      anchors.rightMargin: Style.space(8)
                      anchors.verticalCenter: parent.verticalCenter
                      spacing: Style.space(2)

                      Text {
                        width: parent.width
                        text: rowSurface.modelData.primaryText
                        textFormat: Text.PlainText
                        color: root.contentForeground
                        font.family: root.contentFontFamily
                        font.pixelSize: Style.font.body
                        font.bold: !rowSurface.modelData.action || rowSurface.modelData.action === "mode"
                        elide: Text.ElideRight
                      }

                      Text {
                        width: parent.width
                        visible: text !== ""
                        text: rowSurface.modelData.secondaryText || ""
                        textFormat: Text.PlainText
                        color: root.mutedColor
                        font.family: root.contentFontFamily
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                        maximumLineCount: 3
                        elide: Text.ElideRight
                      }
                    }

                    Row {
                      id: rowActions
                      anchors.right: parent.right
                      anchors.verticalCenter: parent.verticalCenter
                      spacing: Style.space(4)

                      PanelActionButton {
                        visible: !!rowSurface.modelData.run
                        enabled: !actionProcess.running
                        iconText: "󰖟"
                        tooltipText: "Open in the browser"
                        foreground: root.contentForeground
                        fontFamily: root.contentFontFamily
                        onClicked: root.runAction(["browser", "--run", String(rowSurface.modelData.run.id)], false)
                      }

                      PanelActionButton {
                        visible: !!rowSurface.modelData.run && rowSurface.tone === "failed"
                        enabled: rowSurface.report !== null
                        iconText: "󱚣"
                        tooltipText: "Fix this run in a new agent"
                        foreground: root.contentForeground
                        fontFamily: root.contentFontFamily
                        onClicked: root.showAgentPicker("ci", false, rowSurface.modelData.run.id)
                      }
                    }
                  }

                  Column {
                    visible: rowSurface.expanded
                    width: parent.width
                    leftPadding: Style.space(32)
                    spacing: Style.space(4)

                    Text {
                      visible: !!rowSurface.modelData.run && rowSurface.tone !== "failed"
                      text: "Only failed runs have logs here"
                      color: root.mutedColor
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.caption
                    }

                    Repeater {
                      model: rowSurface.expanded && rowSurface.report ? rowSurface.report.jobs : []

                      Text {
                        required property var modelData
                        width: parent.width - Style.space(32)
                        text: modelData.name + (modelData.failedSteps.length
                          ? " · " + modelData.failedSteps.map(function(step) { return step.name }).join(", ") : "")
                        textFormat: Text.PlainText
                        color: root.urgentColor
                        font.family: root.contentFontFamily
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                      }
                    }

                    OutputView {
                      visible: rowSurface.expanded && text !== ""
                      width: parent.width - Style.space(32)
                      text: rowSurface.modelData.check
                        ? (rowSurface.modelData.check.status === "timedOut" ? "Timed out" : rowSurface.modelData.check.output)
                        : (rowSurface.report ? (rowSurface.report.logs || "Saved to " + rowSurface.report.logFile) : "")
                      foreground: root.contentForeground
                    }
                  }
                }
              }
            }
          }

          Text {
            visible: root.view === "agent" && (launchersProcess.running || root.launchersError !== "" || root.launchers.length === 0)
            width: parent.width
            text: launchersProcess.running ? "Finding agents" : (root.launchersError || "No agents can be launched here")
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.launchersError ? root.urgentColor : root.mutedColor
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }

          Text {
            visible: actionProcess.running || root.actionError !== ""
            width: parent.width
            text: actionProcess.running ? "Working…" : root.actionError
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: actionProcess.running ? root.mutedColor : root.urgentColor
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
