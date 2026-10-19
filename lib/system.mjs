// Running other programs and finding them, the way setup needs: always with a
// timeout, never through a shell, and against an explicit PATH.
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// `command -v <name>` for an explicit PATH: the first executable regular file.
export function which(name, pathValue) {
  if (name.includes("/")) return isExecutableFile(name) ? name : null;
  for (const dir of String(pathValue || "").split(":")) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// → { ok, status, stdout, stderr, timedOut, error }. A program that is not
// found, times out or exits non-zero is not ok; nothing throws.
export function run(file, args, { env = process.env, cwd, timeoutMs = 10_000, input } = {}) {
  const r = spawnSync(file, args, {
    env, cwd, input, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const timedOut = r.error?.code === "ETIMEDOUT";
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    timedOut,
    error: r.error ? (timedOut ? `timed out after ${timeoutMs} ms` : r.error.message) : null,
  };
}

// The first line of a program's error, for a plan or a refusal.
export function failureText(result) {
  if (result.error) return result.error;
  const line = (result.stderr || result.stdout).trim().split("\n").find(Boolean);
  return `exit ${result.status}${line ? `: ${line}` : ""}`;
}

// `systemctl --user show-environment` → { ok, env } with the running user
// session's environment, or { ok: false, reason }. Read-only.
export function sessionEnvironment(pathValue, env) {
  const systemctl = which("systemctl", pathValue);
  if (!systemctl) return { ok: false, reason: "systemctl not found" };
  const r = run(systemctl, ["--user", "show-environment"], { env, timeoutMs: 5_000 });
  if (!r.ok) return { ok: false, reason: `systemctl --user show-environment: ${failureText(r)}` };
  const out = {};
  for (const line of r.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = unquoteSystemd(line.slice(eq + 1));
  }
  return { ok: true, env: out };
}

// show-environment prints values with special characters as $'...'.
function unquoteSystemd(value) {
  const m = /^\$'(.*)'$/.exec(value);
  if (!m) return value;
  return m[1].replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", "\\": "\\", "'": "'" })[c] ?? c);
}
