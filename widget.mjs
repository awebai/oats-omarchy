// The command the bar widget's click runs, through the bar's `run`, which
// hands it to `bash -lc`. Kept apart from the QML so a test can run it.

// One shell word: single quotes, and a quote inside closed, escaped, reopened.
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// The path of a file:// URL (Qt.resolvedUrl gives one for a plugin file).
export function urlPath(url) {
  return decodeURIComponent(String(url).replace(/^file:\/\//, ""))
}

// Open the OATS TUI through the launcher entry setup writes (its Exec is
// omarchy-launch-or-focus-tui …, so a second click focuses the window).
// Without that entry, setup has not run: open its plan in Omarchy's floating
// terminal, which runs its arguments as one bash command line, so the setup
// path is quoted for that line and the line is quoted again for this one.
export function clickCommand(setupPath) {
  var plan = shellQuote(setupPath) + " --plan"
  return "if [ -f \"${XDG_DATA_HOME:-$HOME/.local/share}/applications/org.oats.tui.desktop\" ]; "
    + "then exec uwsm-app -- org.oats.tui.desktop; "
    + "else exec omarchy-launch-floating-terminal-with-presentation " + shellQuote(plan) + "; fi"
}
