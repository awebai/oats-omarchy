#!/usr/bin/env node
// Repository lint with no dependencies: every JavaScript module parses
// (node --check), every shell script parses (bash -n for *.sh, sh -n for an
// extensionless #!/bin/sh script such as the `setup` launcher) and, where
// shellcheck is installed (it is on GitHub's Ubuntu runners), passes
// shellcheck, and every JSON file parses.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set([".git", "node_modules"]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const files = walk(repoRoot).sort();
const failures = [];
const run = (command, args, file) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${relative(repoRoot, file)}: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
};

const posix = (file) => !/\.[^/]+$/.test(file) && readFileSync(file, "latin1").startsWith("#!/bin/sh\n");
const shellScripts = files.filter((file) => file.endsWith(".sh") || posix(file));
for (const file of files) {
  if (/\.(mjs|cjs|js)$/.test(file)) run(process.execPath, ["--check", file], file);
  else if (file.endsWith(".sh")) run("bash", ["-n", file], file);
  else if (posix(file)) run("sh", ["-n", file], file);
  else if (file.endsWith(".json")) {
    try { JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { failures.push(`${relative(repoRoot, file)}: ${error.message}`); }
  }
}

let shellcheck = false;
try { execFileSync("shellcheck", ["--version"], { stdio: "ignore" }); shellcheck = true; } catch {}
if (shellcheck) for (const file of shellScripts) run("shellcheck", [file], file);
else process.stdout.write("lint: shellcheck not installed; shell scripts checked with bash -n only\n");

if (failures.length) {
  process.stderr.write(`Lint failed:\n- ${failures.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`Linted ${files.length} files.\n`);
