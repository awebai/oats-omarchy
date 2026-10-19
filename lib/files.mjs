// The files setup writes, as bytes. Every path embedded in them has passed
// assertSafePath (no single quote, no control character).
import { renderDesktopEntry } from "./desktop-entry.mjs";
import { evalWord, shellQuote, shellWord } from "./quote.mjs";

export const TUI_ID = "org.oats.tui";
export const DESKTOP_ID = "awebai-oats-desktop";
export const TUI_COMMENT = "The OATS terminal UI: your agents and their sessions";
export const DESKTOP_COMMENT = "OATS Desktop: your agents and their sessions";

// The shim the launchers, the menu and `waiting` call: the kernel by the
// node and CLI setup recorded, never `oats` from PATH.
export function shim({ node, cli }) {
  return `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(cli)} "$@"\n`;
}

// argv for omarchy-launch-or-focus-tui: each word already quoted for its eval.
export const tuiLauncherArgs = ({ shimPath, deployment }) =>
  [`--app-id=${TUI_ID}`, evalWord(shimPath), "tui", "--dir", evalWord(deployment)];

// The TUI launch as one `sh -c` command line (a key, a menu action).
export const tuiCommand = (spec) => ["omarchy-launch-or-focus-tui", ...tuiLauncherArgs(spec)].map(shellWord).join(" ");

// The Desktop launch as one `sh -c` command line: focus its window by class,
// else run it under uwsm-app, as Omarchy's own o.launch_sole does.
export const desktopCommand = (execArgv) =>
  ["omarchy-launch-or-focus", DESKTOP_ID, `uwsm-app -- ${execArgv.map(evalWord).join(" ")}`].map(shellWord).join(" ");

export function tuiEntry(spec) {
  return renderDesktopEntry([
    ["Version", "1.0"],
    ["Type", "Application"],
    ["Name", "OATS"],
    ["Comment", TUI_COMMENT],
    ["Exec", ["omarchy-launch-or-focus-tui", ...tuiLauncherArgs(spec)]],
    ["Icon", TUI_ID],
    ["Terminal", "false"],
    ["Categories", "Development;"],
  ]);
}

// The Desktop's own entry, for an AppImage that has none.
export function desktopEntry({ execArgv }) {
  return renderDesktopEntry([
    ["Version", "1.0"],
    ["Type", "Application"],
    ["Name", "OATS Desktop"],
    ["Comment", DESKTOP_COMMENT],
    ["Exec", execArgv],
    ["Icon", DESKTOP_ID],
    ["Terminal", "false"],
    ["StartupWMClass", DESKTOP_ID],
    ["Categories", "Development;"],
  ]);
}

// Omarchy's post-update hook: re-check, print only what drifted, exit 0. It
// runs the plugin's setup by the node and plugin directory setup recorded,
// and says so in one line when either is gone. Every value in it is a
// single-quoted word, messages included: a path is data, never shell source.
export function hook({ node, pluginDir, deployment }) {
  const say = (text) => `printf '%s\\n' ${shellQuote(text)}`;
  const engine = `${pluginDir}/bin/setup.mjs`;
  return `#!/bin/bash
# Managed by the oats-omarchy plugin's setup; \`setup --remove\` removes it.
# After an Omarchy update, report what drifted from the OATS setup. Advisory: always exits 0.
if [[ ! -f ${shellQuote(engine)} ]]; then
  ${say(`oats-omarchy: the plugin at ${pluginDir} was removed; its launchers, menu and keys remain. Add the plugin again and run setup --remove to clean them up.`)}
  exit 0
fi
if [[ ! -x ${shellQuote(node)} ]]; then
  ${say(`oats-omarchy: the node setup recorded, ${node}, is gone: run setup --apply again from the plugin.`)}
  exit 0
fi
cd ${shellQuote(deployment)} 2>/dev/null || { ${say(`oats-omarchy: the OATS deployment ${deployment} is gone, so its Omarchy setup cannot be checked`)}; exit 0; }
if ! out=$(${shellQuote(node)} ${shellQuote(engine)} --check 2>&1); then
  ${say("oats-omarchy: setup --check failed:")}
  printf '%s\\n' "$out" | head -n 5
  exit 0
fi
if [[ -n $out ]]; then printf '%s\\n' "$out"; fi
exit 0
`;
}
