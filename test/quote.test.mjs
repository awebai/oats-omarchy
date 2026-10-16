// Quoting for each layer a launch command passes through, and proof that the
// whole chain (sh -c or a desktop entry's Exec, then Omarchy's launchers and
// their eval) delivers every argument to the terminal unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafePath, desktopExec, desktopExecArg, evalWord, hyprlangValue, luaString,
  parseDesktopExec, shellQuote, shellWord, unescapeDesktopString,
} from "../oats-package/capabilities/oats-omarchy/lib/quote.mjs";
import { desktopCommand, tuiCommand, tuiEntry, TUI_ID, DESKTOP_ID } from "../oats-package/capabilities/oats-omarchy/lib/files.mjs";
import { readDesktopEntry } from "../oats-package/capabilities/oats-omarchy/lib/desktop-entry.mjs";

const NASTY = [
  "plain", "with space", "dollar$HOME", 'double"quote', "back\\slash", "back`tick`", "hash#tag",
  "per%cent", "semi;colon", "amp&ersand", "star*glob", "día ünïcode ✓", "", "-dash", "x=y", "a'b",
];

// sh -c "<command>" → the single word it reads back.
const shWords = (command) => {
  const r = spawnSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\0").slice(0, -1);
};
// What eval makes of one word (the omarchy-launch-or-focus layer, alone).
const evalWords = (text) => {
  const r = spawnSync("/bin/bash", ["-c", 'eval "set -- $1"; printf "%s\\0" "$@"', "bash", text], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\0").slice(0, -1);
};

test("shellWord: bare when nothing needs quoting, double quotes when safe, else single quotes", () => {
  assert.equal(shellWord("omarchy-launch-or-focus-tui"), "omarchy-launch-or-focus-tui");
  assert.equal(shellWord("--app-id=org.oats.tui"), "--app-id=org.oats.tui");
  assert.equal(shellWord("/a/b@c%d+e,f:g"), "/a/b@c%d+e,f:g");
  assert.equal(shellWord("with space"), '"with space"');
  assert.equal(shellWord("a'b"), `"a'b"`);
  assert.equal(shellWord("a$b"), `'a$b'`);
  assert.equal(shellWord('a"b'), `'a"b'`);
  assert.equal(shellWord("a\\b"), `'a\\b'`);
  assert.equal(shellWord("a`b"), "'a`b'");
  assert.equal(shellWord("a!b"), "'a!b'");
  assert.equal(shellWord(""), '""');
  for (const value of NASTY) assert.deepEqual(shWords(shellWord(value)), [value], value);
  // Several words, as tuiCommand joins them.
  assert.deepEqual(shWords(NASTY.map(shellWord).join(" ")), NASTY);
});

test("shellQuote: POSIX single quotes, a single quote closed, escaped and reopened", () => {
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(shellQuote(""), "''");
  for (const value of NASTY) assert.deepEqual(shWords(shellQuote(value)), [value], value);
});

test("evalWord: bare or single-quoted, and eval reproduces it", () => {
  assert.equal(evalWord("tui"), "tui");
  assert.equal(evalWord("/x/100%"), "/x/100%");
  assert.equal(evalWord("with space"), "'with space'");
  assert.equal(evalWord("a$b"), "'a$b'");
  assert.equal(evalWord(""), "''");
  for (const value of NASTY) assert.deepEqual(evalWords(evalWord(value)), [value], value);
});

test("luaString: a double-quoted Lua literal with escapes", () => {
  assert.equal(luaString("plain"), '"plain"');
  assert.equal(luaString('a"b'), '"a\\"b"');
  assert.equal(luaString("a\\b"), '"a\\\\b"');
  assert.equal(luaString("a\nb"), '"a\\nb"');
  assert.equal(luaString("a#b'c$d"), `"a#b'c$d"`);
  assert.equal(luaString("día"), '"día"');
  assert.equal(luaString("a\tb"), '"a\\009b"', "three digits, so a following digit is not read into it");
  for (const value of NASTY) assert.equal(luaUnescape(luaString(value)), value, value);
});

test("luaString: a control character followed by a digit stays that character", () => {
  assert.equal(luaUnescape(luaString("\u00012")), "\u00012");
  assert.equal(luaUnescape(luaString("\t5")), "\t5");
});

test("hyprlangValue: # is written ##; a newline is refused", () => {
  assert.equal(hyprlangValue("omarchy-launch-or-focus-tui --app-id=x"), "omarchy-launch-or-focus-tui --app-id=x");
  assert.equal(hyprlangValue("a #b ## c"), "a ##b #### c");
  assert.throws(() => hyprlangValue("a\nb"), { code: "E_UNSAFE_PATH" });
  assert.throws(() => hyprlangValue("a\rb"), { code: "E_UNSAFE_PATH" });
});

test("desktopExecArg: reserved characters double-quoted with \" ` $ \\ escaped; % is %%", () => {
  assert.equal(desktopExecArg("plain"), "plain");
  assert.equal(desktopExecArg("100%"), "100%%");
  assert.equal(desktopExecArg("with space"), '"with space"');
  assert.equal(desktopExecArg('a"b'), '"a\\"b"');
  assert.equal(desktopExecArg("a`b"), '"a\\`b"');
  assert.equal(desktopExecArg("a$b"), '"a\\$b"');
  assert.equal(desktopExecArg("a\\b"), '"a\\\\b"');
  for (const value of ["a'b", "a>b", "a<b", "~a", "a|b", "a&b", "a;b", "a*b", "a?b", "a#b", "a(b", "a)b"]) {
    assert.equal(desktopExecArg(value), `"${value}"`, value);
  }
  assert.throws(() => desktopExecArg("a\nb"), { code: "E_UNSAFE_PATH" });
  assert.throws(() => desktopExecArg("a\tb"), { code: "E_UNSAFE_PATH" });
});

test("desktopExec: arguments joined by spaces, then every backslash doubled for the string value", () => {
  assert.equal(desktopExec(["/bin/app", "--dir", "/x/my dir"]), '/bin/app --dir "/x/my dir"');
  // "a\b" → "a\\b" (the Exec quoting) → "a\\\\b" (the string-value escape).
  assert.equal(desktopExec(["a\\b"]), '"a\\\\\\\\b"');
  assert.equal(desktopExec(["a$b"]), '"a\\\\$b"');
});

test("parseDesktopExec: field codes removed, %% kept, quotes and escapes read", () => {
  assert.deepEqual(parseDesktopExec("app %f %F %u %U %i %c %k"), ["app"]);
  assert.deepEqual(parseDesktopExec("app %U --x"), ["app", "--x"]);
  assert.deepEqual(parseDesktopExec("app 100%% --file=%f"), ["app", "100%", "--file="]);
  assert.deepEqual(parseDesktopExec('app "with space" "a\\"b" "a\\`b" "a\\$b"'), ["app", "with space", 'a"b', "a`b", "a$b"]);
  assert.deepEqual(parseDesktopExec('app  \t "" x'), ["app", "", "x"]);
  // The string-value escape first: \\\\ is \\ (one escaped backslash in the quotes) and \s a space.
  assert.deepEqual(parseDesktopExec('app "a\\\\\\\\b"'), ["app", "a\\b"]);
  assert.deepEqual(parseDesktopExec("app a\\sb"), ["app", "a", "b"]);
  assert.equal(unescapeDesktopString("a\\\\sb\\n"), "a\\sb\n");
});

test("parseDesktopExec(desktopExec(argv)) round-trips argv", () => {
  const values = NASTY.filter((v) => v !== "");
  for (const value of values) assert.deepEqual(parseDesktopExec(desktopExec(["app", value])), ["app", value], value);
  assert.deepEqual(parseDesktopExec(desktopExec(["app", ...values])), ["app", ...values]);
  const mixed = 'a "$b" \\ `c` #d; f & g * día';
  assert.deepEqual(parseDesktopExec(desktopExec([mixed])), [mixed]);
});

test("parseDesktopExec(desktopExec(argv)) round-trips a % inside a quoted argument", () => {
  assert.deepEqual(parseDesktopExec(desktopExec(["app", "50% off"])), ["app", "50% off"]);
});

test("assertSafePath refuses a single quote, a newline and other control characters", () => {
  assert.equal(assertSafePath("the deployment", "/x/my dir $\"\\#%&;"), "/x/my dir $\"\\#%&;");
  for (const value of ["/x/a'b", "/x/a\nb", "/x/a\rb", "/x/a\tb", "/x/a\u0000b", "/x/a\u001bb", "/x/a\u007fb", ""]) {
    assert.throws(() => assertSafePath("the deployment", value), { code: "E_UNSAFE_PATH" }, JSON.stringify(value));
  }
});

// --- The eval chain, against fakes that mirror Omarchy's own scripts. ---

// Omarchy's launchers, as shipped, minus hyprctl: no window matches, so
// omarchy-launch-or-focus always launches.
const LAUNCH_OR_FOCUS_TUI = `#!/bin/bash
if [[ \${1:-} == --app-id=* ]]; then
  APP_ID="\${1#--app-id=}"
else
  APP_ID="org.omarchy.$(basename "$1")"
fi

LAUNCH_COMMAND="omarchy-launch-tui $@"

exec omarchy-launch-or-focus "$APP_ID" "$LAUNCH_COMMAND"
`;
const launchOrFocus = (log) => `#!/bin/bash
if (($# == 0)); then
  echo "Usage: omarchy-launch-or-focus [window-pattern] [launch-command]"
  exit 1
fi

WINDOW_PATTERN="$1"
LAUNCH_COMMAND="\${2:-"uwsm-app -- $WINDOW_PATTERN"}"
printf '%s\\n' "$WINDOW_PATTERN" > ${shellQuote(log)}
WINDOW_ADDRESS=

if [[ -n $WINDOW_ADDRESS ]]; then
  exit 1
else
  eval exec setsid $LAUNCH_COMMAND
fi
`;
const LAUNCH_TUI = `#!/bin/bash
if [[ \${1:-} == --app-id=* ]]; then
  APP_ID="\${1#--app-id=}"
  shift
else
  APP_ID="org.omarchy.$(basename $1)"
fi

exec setsid uwsm-app -- xdg-terminal-exec --app-id=$APP_ID -e "$1" "\${@:2}"
`;
const recorder = (out) => `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > ${shellQuote(out)}\n`;

function chain(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oats-omarchy-chain-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const put = (name, text) => { writeFileSync(join(bin, name), text); chmodSync(join(bin, name), 0o755); };
  const out = join(root, "argv.txt");
  const pattern = join(root, "pattern.txt");
  put("omarchy-launch-or-focus-tui", LAUNCH_OR_FOCUS_TUI);
  put("omarchy-launch-or-focus", launchOrFocus(pattern));
  put("omarchy-launch-tui", LAUNCH_TUI);
  put("setsid", '#!/bin/sh\nexec "$@"\n');
  put("uwsm-app", '#!/bin/sh\n[ "$1" = "--" ] && shift\nexec "$@"\n');
  put("xdg-terminal-exec", recorder(out));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, LANG: "C.UTF-8" };
  const read = () => {
    const lines = readFileSync(out, "utf8").split("\n").slice(0, -1);
    rmSync(out);
    return { argv: lines.slice(1), pattern: readFileSync(pattern, "utf8").trimEnd() };
  };
  const sh = (command) => {
    const r = spawnSync("/bin/sh", ["-c", command], { env, cwd: root, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, `${command}\n${r.stderr}`);
    return read();
  };
  const direct = (argv) => {
    const r = spawnSync(argv[0], argv.slice(1), { env, cwd: root, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, `${JSON.stringify(argv)}\n${r.stderr}${r.error ?? ""}`);
    return read();
  };
  return { root, sh, direct, recorder };
}

const DEPLOYMENTS = [
  "/srv/oats/my deployment", "/srv/oats/dollar$HOME", '/srv/oats/double"quote', "/srv/oats/back\\slash",
  "/srv/oats/hash#tag", "/srv/oats/per%cent", "/srv/oats/amp&ersand", "/srv/oats/semi;colon",
  "/srv/oats/día ü ✓", "/srv/oats/back`tick`", "/srv/oats/star*", '/srv/oats/all $x "y" \\z #%&;',
];
const SHIM = "/srv/oats/data dir/oats-omarchy/oats";

test("the TUI command reaches the terminal with its argv intact (sh -c)", (t) => {
  const c = chain(t);
  for (const deployment of DEPLOYMENTS) {
    const got = c.sh(tuiCommand({ shimPath: SHIM, deployment }));
    assert.deepEqual(got.argv, [`--app-id=${TUI_ID}`, "-e", SHIM, "tui", "--dir", deployment], deployment);
    assert.equal(got.pattern, TUI_ID);
  }
});

test("the TUI command keeps a run of spaces in a path (sh -c)", (t) => {
  const c = chain(t);
  const deployment = "/srv/oats/two  spaces";
  assert.deepEqual(c.sh(tuiCommand({ shimPath: SHIM, deployment })).argv, [`--app-id=${TUI_ID}`, "-e", SHIM, "tui", "--dir", deployment]);
});

test("the TUI desktop entry's Exec, parsed and run without a shell, reaches the terminal intact", (t) => {
  const c = chain(t);
  for (const deployment of DEPLOYMENTS.filter((d) => !(d.includes("%") && /[ "\\$`#&;*]/.test(d)))) {
    const exec = readDesktopEntry(tuiEntry({ shimPath: SHIM, deployment })).Exec;
    const argv = parseDesktopExec(exec);
    assert.equal(argv[0], "omarchy-launch-or-focus-tui");
    const got = c.direct(argv);
    assert.deepEqual(got.argv, [`--app-id=${TUI_ID}`, "-e", SHIM, "tui", "--dir", deployment], deployment);
  }
});

test("the TUI desktop entry's Exec keeps a % in a quoted path", (t) => {
  const c = chain(t);
  const deployment = "/srv/oats/100% done";
  const got = c.direct(parseDesktopExec(readDesktopEntry(tuiEntry({ shimPath: SHIM, deployment })).Exec));
  assert.deepEqual(got.argv, [`--app-id=${TUI_ID}`, "-e", SHIM, "tui", "--dir", deployment]);
});

test("the Desktop command reaches the AppImage with its argv intact (sh -c)", (t) => {
  const c = chain(t);
  for (const [i, deployment] of DEPLOYMENTS.entries()) {
    const dir = join(c.root, `apps ${i} $x "q" \\b #%&;`);
    mkdirSync(dir);
    const appImage = join(dir, "OATS Desktop.AppImage");
    const out = join(c.root, "argv.txt");
    writeFileSync(appImage, recorder(out));
    chmodSync(appImage, 0o755);
    const execArgv = [appImage, "--appimage-extract-and-run", "--dir", deployment];
    const got = c.sh(desktopCommand(execArgv));
    assert.deepEqual(got.argv, ["--appimage-extract-and-run", "--dir", deployment], deployment);
    assert.equal(got.pattern, DESKTOP_ID);
  }
});

// Lua's reading of a short string literal, for the escapes luaString writes.
function luaUnescape(literal) {
  assert.ok(literal.startsWith('"') && literal.endsWith('"'), literal);
  const body = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') assert.fail(`unescaped quote in ${literal}`);
    if (c !== "\\") { out += c; continue; }
    const next = body[++i];
    if (/[0-9]/.test(next)) {
      let digits = next;
      while (digits.length < 3 && /[0-9]/.test(body[i + 1] ?? "")) digits += body[++i];
      out += String.fromCharCode(Number(digits));
    } else {
      out += { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" }[next] ?? assert.fail(`unknown escape \\${next}`);
    }
  }
  return out;
}
