#!/usr/bin/env node
// Validates the package payload before anything else runs:
//   - oats-package.json and every capability oats.json against the schemas
//     vendored from the kernel (schemas/, see schemas/README.md);
//   - containment: every path a manifest names (capability roots, skills,
//     inject, command and hook entrypoints) resolves, after symlinks, inside
//     the payload root, and a capability's own paths inside its own root,
//     which is the directory a spawn copies;
//   - no manifest outside the payload: an oats.json or oats-package.json
//     anywhere else in the repository is refused, so nothing the kernel would
//     not copy can look like part of the package.
//
//   node scripts/validate-manifests.mjs [--repo <dir>] [--schemas <dir>]
//
// --repo validates another checkout (the tests point it at fixtures); the
// default is this repository. The payload root is <repo>/oats-package.
// --schemas reads the schemas from another directory (default: schemas/).
import { readFileSync, readdirSync, realpathSync, statSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PAYLOAD = "oats-package";
const MANIFEST_NAMES = new Set(["oats.json", "oats-package.json"]);
// Directories the stray-manifest scan skips, relative to the repository root.
// test/fixtures holds the validator's own deliberately broken inputs.
const SCAN_SKIP = new Set([".git", "node_modules", "test/fixtures"]);

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
let repoRoot = toolRoot;
let schemaDir = join(toolRoot, "schemas");
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--repo" && argv[i + 1]) repoRoot = resolve(argv[++i]);
  else if (argv[i] === "--schemas" && argv[i + 1]) schemaDir = resolve(argv[++i]);
  else { process.stderr.write(`usage: validate-manifests.mjs [--repo <dir>] [--schemas <dir>]\n`); process.exit(2); }
}
const root = join(repoRoot, PAYLOAD);
const errors = [];
const report = (at, message) => errors.push(`${at}: ${message}`);

const readJson = (path, at) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { report(at, `invalid JSON (${error.message})`); return undefined; }
};

// A small JSON Schema evaluator for the keywords the kernel's schemas use.
// oneOf, anyOf and not evaluate each subschema in full and keep only whether
// it validated; local "#/..." references are followed, anything else fails.
// A schema that uses a keyword outside KEYWORDS is refused before anything is
// validated (schemaKeywordProblems), so a refreshed schema can never have an
// assertion this evaluator silently skips.
const ANNOTATIONS = ["$schema", "$id", "$comment", "title", "description", "deprecated", "default", "examples"];
const KEYWORDS = new Set([
  ...ANNOTATIONS, "$ref", "$defs", "type", "const", "enum", "oneOf", "anyOf", "not",
  "minLength", "maxLength", "pattern", "items", "minItems", "maxItems", "uniqueItems",
  "properties", "required", "additionalProperties", "propertyNames", "minProperties", "maxProperties",
]);
// Keywords whose value is a map from names to subschemas, or a subschema list.
const SCHEMA_MAPS = new Set(["properties", "$defs"]);
const SCHEMA_LISTS = new Set(["oneOf", "anyOf"]);
const SCHEMA_VALUES = new Set(["not", "items", "additionalProperties", "propertyNames"]);

function schemaKeywordProblems(schema, at) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const problems = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) { problems.push(`${at}/${key}: keyword "${key}" is not evaluated by scripts/validate-manifests.mjs`); continue; }
    if (SCHEMA_MAPS.has(key)) for (const [name, sub] of Object.entries(value || {})) problems.push(...schemaKeywordProblems(sub, `${at}/${key}/${name}`));
    else if (SCHEMA_LISTS.has(key)) (Array.isArray(value) ? value : []).forEach((sub, i) => problems.push(...schemaKeywordProblems(sub, `${at}/${key}/${i}`)));
    else if (SCHEMA_VALUES.has(key)) problems.push(...schemaKeywordProblems(value, `${at}/${key}`));
  }
  return problems;
}

function validateSchema(value, schema, at, rootSchema = schema, refs = []) {
  if (!schema || typeof schema !== "object") return;
  if (Object.hasOwn(schema, "$ref")) {
    const ref = schema.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/") || refs.includes(ref) || refs.length >= 32) {
      report(at, "unsupported or cyclic schema reference"); return;
    }
    let target = rootSchema;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      target = target && typeof target === "object" && Object.hasOwn(target, key) ? target[key] : undefined;
    }
    if (!target || typeof target !== "object") { report(at, "unresolved schema reference"); return; }
    validateSchema(value, target, at, rootSchema, [...refs, ref]);
  }
  const validates = (sub) => {
    const start = errors.length;
    validateSchema(value, sub, at, rootSchema, refs);
    return errors.splice(start).length === 0;
  };
  if (schema.oneOf && schema.oneOf.filter(validates).length !== 1) report(at, "must match exactly one schema alternative");
  if (schema.anyOf && !schema.anyOf.some(validates)) report(at, "must match at least one schema alternative");
  if (schema.not && validates(schema.not)) report(at, schema.not.pattern ? `must not match ${schema.not.pattern}` : "must not match the excluded schema");
  if ("const" in schema && !Object.is(schema.const, value)) report(at, `must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) report(at, `must be one of ${schema.enum.join(", ")}`);
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  if (types.length && !types.some((type) => type === actual || (type === "number" && actual === "integer"))) {
    report(at, `must be ${types.join(" or ")}, got ${actual}`); return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) report(at, `must contain at least ${schema.minLength} character(s)`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) report(at, `must contain at most ${schema.maxLength} character(s)`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) report(at, `must match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) report(at, `must contain at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) report(at, `must contain at most ${schema.maxItems} item(s)`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) report(at, "must contain unique items");
    value.forEach((item, index) => validateSchema(item, schema.items, `${at}[${index}]`, rootSchema, refs));
  }
  if (value && actual === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) report(at, `missing required property ${key}`);
    const count = Object.keys(value).length;
    if (schema.minProperties !== undefined && count < schema.minProperties) report(at, `must have at least ${schema.minProperties} propert(ies)`);
    if (schema.maxProperties !== undefined && count > schema.maxProperties) report(at, `must have at most ${schema.maxProperties} propert(ies)`);
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames) validateSchema(key, schema.propertyNames, `${at}.${key} (property name)`, rootSchema, refs);
      if (Object.hasOwn(properties, key)) validateSchema(item, properties[key], `${at}.${key}`, rootSchema, refs);
      else if (schema.additionalProperties === false) report(`${at}.${key}`, "unknown property");
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validateSchema(item, schema.additionalProperties, `${at}.${key}`, rootSchema, refs);
    }
  }
}

const isInside = (child, parent) => child === parent || child.startsWith(parent + sep);

// Resolves `candidate` under `base` and checks the real path (and, for a
// directory, every descendant's real path) stays inside `boundary`.
function contained(base, candidate, at, { boundary, type, recursive = false }) {
  if (typeof candidate !== "string" || !candidate.trim()) { report(at, "path must be a non-empty string"); return undefined; }
  if (isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate) || candidate.includes("\\") || candidate.includes("\0") || candidate.split("/").includes("..")) {
    report(at, `path "${candidate}" must be relative, use forward slashes and contain no '..'`); return undefined;
  }
  const realBoundary = realpathSync(boundary);
  const inspect = (path, label, seen, expected) => {
    let target;
    try { target = realpathSync(path); }
    catch (error) { report(label, `cannot be resolved (${error.code || error.message})`); return undefined; }
    if (!isInside(target, realBoundary)) { report(label, `escapes ${relative(repoRoot, boundary) || "."} after symlink resolution`); return undefined; }
    const stat = statSync(target);
    if (expected === "file" && !stat.isFile()) { report(label, "must be a regular file"); return undefined; }
    if (expected === "directory" && !stat.isDirectory()) { report(label, "must be a directory"); return undefined; }
    if (!stat.isFile() && !stat.isDirectory()) { report(label, "must be a regular file or directory"); return undefined; }
    if (recursive && stat.isDirectory()) {
      if (seen.has(target)) { report(label, "contains a directory symlink cycle"); return undefined; }
      const next = new Set([...seen, target]);
      for (const child of readdirSync(target).sort()) inspect(join(target, child), `${label}/${child}`, next);
    }
    return target;
  };
  return inspect(resolve(base, candidate), at, new Set(), type);
}

// The kernel finds skills as a SKILL.md at the tree's top, or in its
// immediate (non-symlink) child directories.
function validateSkillTree(tree, at, boundary) {
  const hasDoc = (dir) => { try { return statSync(join(dir, "SKILL.md")).isFile(); } catch { return false; } };
  const skills = hasDoc(tree) ? [tree] : readdirSync(tree, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && hasDoc(join(tree, entry.name)))
    .map((entry) => join(tree, entry.name));
  if (!skills.length) report(at, "contains no skill (a SKILL.md in the tree or in a child directory)");
  for (const skill of skills) contained(skill, "SKILL.md", `${at}/${relative(tree, skill) || "."}/SKILL.md`, { boundary, type: "file" });
}

// "bin/x.mjs arg" or { command: "bin/x.mjs arg" } → "bin/x.mjs".
const entrypoint = (spec) => {
  const command = typeof spec === "string" ? spec : spec && typeof spec === "object" ? spec.command : undefined;
  return typeof command === "string" ? command.trim().split(/\s+/)[0] : command;
};
const entries = (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []);

function strayManifests(dir, rel = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (SCAN_SKIP.has(path) || path === PAYLOAD) continue;
    if (entry.isDirectory()) found.push(...strayManifests(join(dir, entry.name), path));
    else if (MANIFEST_NAMES.has(entry.name)) found.push(path);
  }
  return found;
}

const loadSchema = (name) => {
  const schema = readJson(join(schemaDir, name), `schemas/${name}`);
  const problems = schemaKeywordProblems(schema, `schemas/${name}#`);
  for (const problem of problems) report(problem, "the validator would skip it");
  return problems.length ? undefined : schema;
};
const packageSchema = loadSchema("oats-package.schema.json");
const capabilitySchema = loadSchema("capability-manifest.schema.json");

let payloadOk = true;
try { payloadOk = lstatSync(root).isDirectory(); } catch { payloadOk = false; }
if (!payloadOk) report(PAYLOAD, "the payload root must be a real directory");

for (const path of strayManifests(repoRoot)) report(path, `manifest outside the payload root: everything the package ships lives under ${PAYLOAD}/`);

const capabilities = [];
let packageManifest;
if (payloadOk) {
  const manifestPath = contained(root, "oats-package.json", "oats-package.json", { boundary: root, type: "file" });
  packageManifest = manifestPath ? readJson(manifestPath, "oats-package.json") : undefined;
  if (packageManifest && packageSchema) validateSchema(packageManifest, packageSchema, "oats-package.json");

  // Every other path the package manifest may name (this package declares
  // none of them today; they are checked so that adding one cannot escape).
  const pkg = packageManifest && typeof packageManifest === "object" ? packageManifest : {};
  for (const [i, dir] of (Array.isArray(pkg.souls) ? pkg.souls : []).entries()) contained(root, dir, `oats-package.json.souls[${i}]`, { boundary: root, type: "directory", recursive: true });
  for (const [i, trigger] of (Array.isArray(pkg.triggers) ? pkg.triggers : []).entries()) contained(root, trigger?.file, `oats-package.json.triggers[${i}].file`, { boundary: root, type: "file" });
  for (const field of ["configTemplates", "configs"]) {
    for (const [name, spec] of entries(pkg[field])) contained(root, spec?.path, `oats-package.json.${field}.${name}.path`, { boundary: root, type: "file" });
  }

  const declared = Array.isArray(packageManifest?.capabilities) ? packageManifest.capabilities : [];
  for (const [index, dir] of declared.entries()) {
    const capRoot = contained(root, dir, `oats-package.json.capabilities[${index}]`, { boundary: root, type: "directory", recursive: true });
    if (!capRoot) continue;
    const at = `${dir}/oats.json`;
    const manifestFile = contained(capRoot, "oats.json", at, { boundary: capRoot, type: "file" });
    const manifest = manifestFile ? readJson(manifestFile, at) : undefined;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) continue;
    if (capabilitySchema) validateSchema(manifest, capabilitySchema, at);
    capabilities.push(manifest);
    const own = { boundary: capRoot };
    for (const [i, skills] of (Array.isArray(manifest.skills) ? manifest.skills : []).entries()) {
      const tree = contained(capRoot, skills, `${at}.skills[${i}]`, { ...own, type: "directory", recursive: true });
      if (tree) validateSkillTree(tree, `${at}.skills[${i}]`, capRoot);
    }
    if ("inject" in manifest) contained(capRoot, manifest.inject, `${at}.inject`, { ...own, type: "file" });
    if (manifest.helperInjection?.mode === "file") contained(capRoot, manifest.helperInjection.path, `${at}.helperInjection.path`, { ...own, type: "file" });
    for (const [name, command] of entries(manifest.commands)) contained(capRoot, entrypoint(command), `${at}.commands.${name}`, { ...own, type: "file" });
    for (const [event, hook] of entries(manifest.hooks)) contained(capRoot, entrypoint(hook), `${at}.hooks.${event}`, { ...own, type: "file" });
  }

  // One package, one capability: their identity, version and kernel floor agree.
  if (capabilities.length !== 1) report("oats-package.json.capabilities", `must name exactly one capability (found ${capabilities.length})`);
  else if (packageManifest) {
    const [capability] = capabilities;
    if (packageManifest.package !== capability.capability) report("oats-package.json.package", `must equal the capability id ${capability.capability}`);
    if (packageManifest.version !== capability.version) report("oats-package.json.version", `must equal the capability version ${capability.version}`);
    if (packageManifest.compatibility?.oats !== capability.compatibility?.oats) report("oats-package.json.compatibility.oats", `must equal the capability's ${capability.compatibility?.oats}`);
  }
}

if (errors.length) {
  process.stderr.write(`Manifest validation failed:\n- ${errors.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(`Validated ${PAYLOAD}/oats-package.json and ${capabilities.length} capability manifest(s).\n`);
