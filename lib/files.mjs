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
// `deployment` is null with this computer's list of deployments: the TUI
// then starts on its own list.
export const tuiLauncherArgs = ({ shimPath, deployment }) =>
  [`--app-id=${TUI_ID}`, evalWord(shimPath), "tui", ...(deployment === null ? [] : ["--dir", evalWord(deployment)])];

// The TUI launch: argv (the launcher entry, the bar widget), and as one
// `sh -c` command line (a key, a menu action).
export const tuiArgv = (spec) => ["omarchy-launch-or-focus-tui", ...tuiLauncherArgs(spec)];
export const tuiCommand = (spec) => tuiArgv(spec).map(shellWord).join(" ");

// The Desktop launch: focus its window by class, else run it under uwsm-app,
// as Omarchy's own o.launch_sole does. argv, and one `sh -c` command line.
export const desktopArgv = (execArgv) =>
  ["omarchy-launch-or-focus", DESKTOP_ID, `uwsm-app -- ${execArgv.map(evalWord).join(" ")}`];
export const desktopCommand = (execArgv) => desktopArgv(execArgv).map(shellWord).join(" ");

// Setup again, by the node and plugin directory setup recorded, for the
// deployment it is applied for (none with the list).
export const setupArgv = ({ node, pluginDir, deployment }) => [node, `${pluginDir}/bin/setup.mjs`, ...(deployment === null ? [] : ["--dir", deployment])];

// The bar widget's file (in setup's state directory, never in the plugin's):
// the commands the key and the menu run, as argv, which the widget quotes
// for the bar's `bash -lc`. `tui` and `desktop` are null when that part is
// not applied; `ui` ("tui", "desktop" or null, from 0.5.0) is the default
// UI, which a right click on the icon opens; `attach` is the argv up to the
// home, which goes last. `deployment` is null when setup uses this
// computer's list of deployments.
export const pluginFile = ({ deployment, tui, desktop, ui, waiting, attach, setup }) =>
  `${JSON.stringify({ deployment, tui, desktop, ui, waiting, attach, setup }, null, 2)}\n`;

export function tuiEntry(spec) {
  return renderDesktopEntry([
    ["Version", "1.0"],
    ["Type", "Application"],
    ["Name", "OATS"],
    ["Comment", TUI_COMMENT],
    ["Exec", tuiArgv(spec)],
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
// and says so in one line when either is gone (the node first). Every value in it is a
// single-quoted word, messages included: a path is data, never shell source.
// With the list (`deployment` null) there is no deployment to check from.
export function hook({ node, pluginDir, deployment }) {
  const say = (text) => `printf '%s\\n' ${shellQuote(text)}`;
  const engine = `${pluginDir}/bin/setup.mjs`;
  return `#!/bin/bash
# Managed by the oats-omarchy plugin's setup; \`setup --remove\` removes it.
# After an Omarchy update, report what drifted from the OATS setup. Advisory: always exits 0.
if [[ ! -x ${shellQuote(node)} ]]; then
  ${say(`oats-omarchy: the node setup recorded, ${node}, is gone: run setup --apply again from the plugin.`)}
  exit 0
fi
if [[ ! -f ${shellQuote(engine)} ]]; then
  ${say(`oats-omarchy: the plugin at ${pluginDir} was removed; its launchers, menu and keys remain. Add the plugin again and run setup --remove to clean them up.`)}
  exit 0
fi
${deployment === null ? "" : `cd ${shellQuote(deployment)} 2>/dev/null || { ${say(`oats-omarchy: the OATS deployment ${deployment} is gone, so its Omarchy setup cannot be checked`)}; exit 0; }
`}if ! out=$(${shellQuote(node)} ${shellQuote(engine)} --check 2>&1); then
  ${say("oats-omarchy: setup --check failed:")}
  printf '%s\\n' "$out" | head -n 5
  exit 0
fi
if [[ -n $out ]]; then printf '%s\\n' "$out"; fi
exit 0
`;
}
