// The state file and the file operations that make --apply undoable: atomic
// writes, the exact prior state of every path, and the directories created.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const STATE_SCHEMA = 1;

export const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// → { bytes, mode } for a regular file, null when absent. Anything else at
// the path (a directory, a link to one) is refused: setup never replaces it.
export function readFileState(path) {
  let st;
  try { st = lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (st.isSymbolicLink()) {
    const target = statSync(path);
    if (!target.isFile()) throw Object.assign(new Error(`${path} is a link to something that is not a file`), { code: "E_NOT_A_FILE" });
    return { bytes: readFileSync(path), mode: target.mode & 0o7777, link: true };
  }
  if (!st.isFile()) throw Object.assign(new Error(`${path} exists and is not a regular file`), { code: "E_NOT_A_FILE" });
  return { bytes: readFileSync(path), mode: st.mode & 0o7777 };
}

// Temp file in the same directory, every byte written, fsync, chmod, rename
// over the target (rename replaces a link itself, never what it points to).
// On any failure the temp file is removed and the target is untouched.
export function atomicWrite(path, bytes, mode) {
  const tmp = join(dirname(path), `.${basename(path)}.oats-omarchy-${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      for (let at = 0; at < bytes.length;) {
        const n = writeSync(fd, bytes, at, bytes.length - at);
        if (n <= 0) throw Object.assign(new Error(`writing ${tmp} made no progress`), { code: "EIO" });
        at += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

// The same, for a path that must not exist: the temp file is linked into
// place, which fails (EEXIST) rather than replace whatever got there first.
export function atomicCreate(path, bytes, mode) {
  const tmp = join(dirname(path), `.${basename(path)}.oats-omarchy-${randomBytes(6).toString("hex")}`);
  atomicWrite(tmp, bytes, mode);
  try { linkSync(tmp, path); } finally { unlinkSync(tmp); }
}

// mkdir -p. Each directory it creates is pushed onto `created` (outermost
// first) as soon as it exists, so a failure part-way still reports them.
export function makeDirs(dir, created = []) {
  const missing = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) missing.unshift(d);
  for (const d of missing) { mkdirSync(d, { mode: 0o755 }); created.push(d); }
  return created;
}

// Removes each directory that is empty, innermost first; → those removed.
export function removeEmptyDirs(dirs) {
  const removed = [];
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(d); removed.push(d); } catch { /* not empty, or already gone */ }
  }
  return removed;
}

export function readState(stateFile) {
  let text;
  try { text = readFileSync(stateFile, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  const state = JSON.parse(text);
  if (state?.schemaVersion !== STATE_SCHEMA || !Array.isArray(state.files)) {
    throw Object.assign(new Error(`${stateFile} is not a state file this version reads (schemaVersion ${state?.schemaVersion})`), { code: "E_STATE" });
  }
  return state;
}
