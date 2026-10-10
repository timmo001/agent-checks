import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  property var shell: null
  property string socketPath: ""
  property string workspaceId: ""
  property string paneId: ""
  property string repositoryPath: ""
  property string pluginRoot: ""
  property string statusPath: ""
  property string errorText: ""
  property var workspaces: []
  property real updated: 0
  property real currentTime: Date.now()

  readonly property bool ready: pluginRoot !== "" && socketPath !== ""
  readonly property bool loaded: updated > 0
  // The watcher writes at least every poll interval; much older means it stopped.
  readonly property bool stale: loaded && currentTime - updated > 180000
  readonly property var focused: {
    for (var i = 0; i < workspaces.length; i++)
      if (workspaces[i].workspace === workspaceId) return workspaces[i]
    return null
  }

  signal published()

  function attention(conclusion) {
    return ["failure", "timed_out", "startup_failure", "action_required"].indexOf(conclusion) >= 0
  }

  // The runs the indicator describes: the pushed commit's, or an earlier
  // commit's while the pushed one has none.
  function ciRuns(ci) {
    if (!ci) return []
    return ci.runs.length === 0 && ci.previous ? ci.previous.runs : ci.runs
  }

  // One of "failed", "running", "error", "ok" or "none".
  function ciTone(ci, error) {
    if (error) return "error"
    var runs = ciRuns(ci)
    if (runs.some(function(run) { return attention(run.conclusion) })) return "failed"
    if (runs.some(function(run) { return run.status !== "completed" })) return "running"
    return runs.length > 0 ? "ok" : "none"
  }

  function lintTone(lint) {
    if (!lint) return "none"
    if (lint.running) return "running"
    var status = lint.result ? lint.result.status : ""
    if (status === "failed" || status === "timedOut") return "failed"
    if (status === "error") return "error"
    return status === "clean" ? "ok" : "none"
  }

  // Open threads need attention; a requested bot review is still running.
  function reviewsTone(reviews, error) {
    if (error) return "error"
    if (!reviews) return "none"
    if (reviews.state === "open") return "failed"
    return reviews.state === "requested" ? "running" : "ok"
  }

  // Runs the CLI from the Herdr plugin checkout against the focused session.
  function command(args) {
    return ["env", "-C", pluginRoot, "HERDR_SOCKET_PATH=" + socketPath,
      "mise", "--quiet", "exec", "--", "bun", "dist/index.js"].concat(args)
  }

  function startWatcher() {
    if (ready) Quickshell.execDetached(command(["start"]))
  }

  function applyContext(value) {
    var socket = value && value.session ? String(value.session.socketPath || "") : ""
    workspaceId = value && value.workspace ? String(value.workspace.id || "") : ""
    paneId = value && value.pane ? String(value.pane.id || "") : ""
    repositoryPath = value && value.repository ? String(value.repository.path || "") : ""
    if (socket === socketPath) return
    socketPath = socket
    pluginRoot = ""
    statusPath = ""
    workspaces = []
    updated = 0
    if (socket !== "") rootProcess.running = true
  }

  function applyStatus(raw) {
    try {
      var value = JSON.parse(raw)
      workspaces = Array.isArray(value.workspaces) ? value.workspaces : []
      updated = Number(value.updated || 0)
      errorText = ""
    } catch (error) {
      errorText = "Invalid status file"
    }
    currentTime = Date.now()
    published()
  }

  FileView {
    path: Quickshell.env("XDG_RUNTIME_DIR") + "/dot-herdr-context.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var value = null
      try { value = JSON.parse(text()) } catch (error) {}
      root.applyContext(value)
    }
  }

  Process {
    id: rootProcess
    command: ["env", "HERDR_SOCKET_PATH=" + root.socketPath,
      "herdr", "plugin", "list", "--plugin", "timmo.agent-checks", "--json"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var plugin = null
        try { plugin = JSON.parse(text).result.plugins[0] } catch (error) {}
        root.pluginRoot = plugin && plugin.enabled ? String(plugin.plugin_root || "") : ""
        root.errorText = root.pluginRoot === "" ? "The timmo.agent-checks Herdr plugin is not enabled" : ""
        if (root.pluginRoot !== "") pathsProcess.running = true
      }
    }
  }

  Process {
    id: pathsProcess
    command: root.command(["paths", "--json"])
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.statusPath = String(JSON.parse(text).status || "") } catch (error) { root.statusPath = "" }
      }
    }
    stderr: StdioCollector { id: pathsError; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.errorText = String(pathsError.text || "Could not locate the status file").trim()
    }
  }

  FileView {
    path: root.statusPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.applyStatus(text())
  }

  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.currentTime = Date.now()
  }
}
