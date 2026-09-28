#!/usr/bin/env node
// CLI skill release gate (ENG-0055).
//
// A CLI the organization releases ships an agent skill, and its release fails
// closed unless the skill and the packaged executable agree. The contract this
// checks is qwts-agent-sop's docs/reference/cli-skill-contract.md (contract
// version 1); the numbered checks below are that document's "Release gate".
//
//   node cli-skill-gate.mjs --skill <dir> --executable <path>
//     --bundle <dir> --bundle-args-json '<json array>'
//     --test-json '<json array: command and arguments>'
//
// 1. SKILL.md frontmatter passes the Agent Skills rules and the qwts- metadata.
// 2. The packaged executable's --version is bare SemVer inside qwts-versions.
// 3. qwts-validated is inside the range, and the range is capped at the next
//    major after it (next minor during 0.x).
// 4. The bundle holds the same skill files, and the bundle-location command
//    reports the bundle.
// 5. The skill's workflow and output-contract tests pass against the packaged
//    executable, which they receive as CLI_SKILL_GATE_EXECUTABLE.
//
// Zero-dependency (ENG-0004): the SemVer range grammar is the npm `semver`
// package's, reimplemented here with its default options.

import process from 'node:process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONTRACT_VERSION = '1';
export const SIDE_EFFECTS = ['read-only', 'local-write', 'remote-write', 'destructive'];
const ALLOWED_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const REQUIRED_METADATA = ['qwts-contract', 'qwts-cli', 'qwts-versions', 'qwts-validated', 'qwts-side-effects'];

// ---------------------------------------------------------------- SemVer

const NUM = '0|[1-9]\\d*';
const IDENT = `(?:${NUM}|\\d*[a-zA-Z-][a-zA-Z0-9-]*)`;
const PRE = `(?:-(${IDENT}(?:\\.${IDENT})*))?`;
const BUILD = '(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?';
const STRICT = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})${PRE}${BUILD}$`);

export function parseVersion(text) {
  const m = STRICT.exec(String(text).trim());
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
  };
}

function version(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease };
}

export function formatVersion(v) {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease.length ? `-${v.prerelease.join('.')}` : ''}`;
}

function compareIdent(a, b) {
  const an = typeof a === 'number';
  const bn = typeof b === 'number';
  if (an && bn) return Math.sign(a - b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let i = 0; ; i += 1) {
    if (i >= a.prerelease.length && i >= b.prerelease.length) return 0;
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const c = compareIdent(a.prerelease[i], b.prerelease[i]);
    if (c) return c;
  }
}

// A partial version as written in a range: 1, 1.2, 1.x, 1.2.3-rc.1, *.
const PARTIAL = new RegExp(
  `^v?(${NUM}|[xX*])(?:\\.(${NUM}|[xX*])(?:\\.(${NUM}|[xX*])${PRE}${BUILD})?)?$`,
);

function parsePartial(text) {
  if (text === '' || text === '*' || /^[xX]$/.test(text)) return { major: null };
  const m = PARTIAL.exec(text);
  if (!m) throw new Error(`invalid version in range: "${text}"`);
  const part = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  const p = { major: part(m[1]), minor: part(m[2]), patch: part(m[3]), prerelease: [] };
  if (p.major === null) p.minor = null;
  if (p.minor === null) p.patch = null;
  if (m[4] && p.patch !== null) {
    p.prerelease = m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  }
  return p;
}

const cmp = (op, v) => ({ op, v });
const ANY = [cmp('>=', version(0, 0, 0))];
const lowerFill = (p) => version(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease);

// Desugar one comparator token into primitive comparators, as npm semver does.
function desugar(token) {
  if (token.startsWith('~')) {
    const p = parsePartial(token.replace(/^~>?/, ''));
    if (p.major === null) return ANY;
    const upper = p.minor === null ? version(p.major + 1, 0, 0, [0]) : version(p.major, p.minor + 1, 0, [0]);
    return [cmp('>=', lowerFill(p)), cmp('<', upper)];
  }
  if (token.startsWith('^')) {
    const p = parsePartial(token.slice(1));
    if (p.major === null) return ANY;
    let upper;
    if (p.minor === null) upper = version(p.major + 1, 0, 0, [0]);
    else if (p.patch === null) {
      upper = p.major === 0 ? version(0, p.minor + 1, 0, [0]) : version(p.major + 1, 0, 0, [0]);
    } else if (p.major !== 0) upper = version(p.major + 1, 0, 0, [0]);
    else if (p.minor !== 0) upper = version(0, p.minor + 1, 0, [0]);
    else upper = version(0, 0, p.patch + 1, [0]);
    return [cmp('>=', lowerFill(p)), cmp('<', upper)];
  }
  const m = /^(<=|>=|<|>|=)?(.*)$/.exec(token);
  const op = m[1] ?? '';
  const p = parsePartial(m[2]);
  if (p.major === null) return op === '<' || op === '>' ? [cmp('<', version(0, 0, 0, [0]))] : ANY;
  const full = p.patch !== null;
  if (full) return [cmp(op === '' ? '=' : op, lowerFill(p))];
  const next = p.minor === null ? version(p.major + 1, 0, 0) : version(p.major, p.minor + 1, 0);
  const nextPre = version(next.major, next.minor, next.patch, [0]);
  switch (op) {
    case '': case '=': return [cmp('>=', lowerFill(p)), cmp('<', nextPre)];
    case '>': return [cmp('>=', next)];
    case '>=': return [cmp('>=', lowerFill(p))];
    case '<': return [cmp('<', version(p.major, p.minor ?? 0, 0, [0]))];
    case '<=': return [cmp('<', nextPre)];
    default: throw new Error(`invalid comparator "${token}"`);
  }
}

function hyphen(fromText, toText) {
  const from = parsePartial(fromText);
  const to = parsePartial(toText);
  const set = from.major === null ? [] : [cmp('>=', lowerFill(from))];
  if (to.major !== null) {
    if (to.patch !== null) set.push(cmp('<=', lowerFill(to)));
    else if (to.minor !== null) set.push(cmp('<', version(to.major, to.minor + 1, 0, [0])));
    else set.push(cmp('<', version(to.major + 1, 0, 0, [0])));
  }
  return set.length ? set : ANY;
}

// Parse a range into comparator sets (alternatives joined by ||).
export function parseRange(text) {
  const source = String(text).trim();
  if (!source) throw new Error('empty version range');
  return source.split('||').map((alt) => {
    const clean = alt.trim().replace(/(<=|>=|<|>|=|~>?|\^)\s+/g, '$1');
    const h = /^(\S+)\s+-\s+(\S+)$/.exec(clean);
    if (h) return hyphen(h[1], h[2]);
    const tokens = clean.split(/\s+/).filter(Boolean);
    return tokens.length ? tokens.flatMap(desugar) : ANY;
  });
}

function test1(c, v) {
  const d = compareVersions(v, c.v);
  switch (c.op) {
    case '<': return d < 0;
    case '<=': return d <= 0;
    case '>': return d > 0;
    case '>=': return d >= 0;
    default: return d === 0;
  }
}

export function satisfies(v, sets) {
  return sets.some((set) => {
    if (!set.every((c) => test1(c, v))) return false;
    if (!v.prerelease.length) return true;
    // Default rule: a prerelease satisfies only a set naming that tuple's prerelease.
    return set.some((c) => c.v.prerelease.length
      && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch);
  });
}

// The contract's cap: next major after validated, or next minor during 0.x.
export function rangeCap(validated) {
  return validated.major === 0 ? version(0, validated.minor + 1, 0) : version(validated.major + 1, 0, 0);
}

export function checkRangeBounded(sets, validated) {
  const cap = rangeCap(validated);
  const problems = [];
  sets.forEach((set, i) => {
    const uppers = set.filter((c) => c.op === '<' || c.op === '<=' || c.op === '=');
    const label = sets.length > 1 ? ` (alternative ${i + 1})` : '';
    if (!uppers.length) {
      problems.push(`qwts-versions has no upper bound${label}`);
      return;
    }
    const ok = uppers.some((c) => (c.op === '<' ? compareVersions(c.v, cap) <= 0 : compareVersions(c.v, cap) < 0));
    if (!ok) problems.push(`qwts-versions${label} reaches past ${formatVersion(cap)}, the cap after qwts-validated`);
  });
  return problems;
}

// ---------------------------------------------------------------- Frontmatter

function unquote(raw, where) {
  const s = raw.trim();
  if (s.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) throw new Error(`${where}: unterminated double-quoted string`);
    return JSON.parse(s);
  }
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new Error(`${where}: unterminated single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[|>[{&*!%@`]/.test(s)) throw new Error(`${where}: unsupported YAML value; use a plain or quoted string`);
  if (/: |\s#/.test(s)) throw new Error(`${where}: plain value contains ": " or " #"; quote it`);
  return s;
}

// The frontmatter subset skills use: top-level string scalars and a
// `metadata:` map of string scalars. Anything else fails closed.
export function parseFrontmatter(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('SKILL.md must start with a --- frontmatter line');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed with ---');
  const fields = {};
  let map = null;
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    const where = `SKILL.md line ${i + 1}`;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indented = /^\s/.test(line);
    const m = /^\s*([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (!m) throw new Error(`${where}: expected "key: value", found "${line.trim()}"`);
    const [, key, raw] = m;
    if (indented) {
      if (!map) throw new Error(`${where}: unexpected indentation`);
      if (raw === undefined || raw === '') throw new Error(`${where}: metadata.${key} must be a string`);
      if (Object.hasOwn(fields[map], key)) throw new Error(`${where}: duplicate metadata.${key}`);
      fields[map][key] = unquote(raw, where);
      continue;
    }
    if (Object.hasOwn(fields, key)) throw new Error(`${where}: duplicate field ${key}`);
    if (raw === undefined || raw === '') {
      fields[key] = {};
      map = key;
    } else {
      fields[key] = unquote(raw, where);
      map = null;
    }
  }
  return fields;
}

// Agent Skills specification rules, then the qwts- contract.
export function checkFrontmatter(fields, skillDirName) {
  const problems = [];
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_FIELDS.has(key)) problems.push(`unexpected top-level field "${key}"; contract keys go under metadata`);
  }
  const { name, description, compatibility, metadata } = fields;
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    problems.push('name must be 1-64 lowercase letters, digits, and single hyphens');
  } else if (skillDirName && name !== skillDirName) {
    problems.push(`name "${name}" must match the skill directory "${skillDirName}"`);
  }
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) {
    problems.push('description must be 1-1024 characters');
  }
  if (compatibility !== undefined && (typeof compatibility !== 'string' || compatibility.length > 500)) {
    problems.push('compatibility must be a string of at most 500 characters');
  }
  for (const key of ['name', 'description', 'license', 'compatibility', 'allowed-tools']) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') problems.push(`${key} must be a string`);
  }
  if (!metadata || typeof metadata !== 'object') {
    problems.push('metadata is missing; the ENG-0055 contract lives under it');
    return { problems };
  }
  for (const key of REQUIRED_METADATA) {
    if (typeof metadata[key] !== 'string' || !metadata[key].trim()) problems.push(`metadata.${key} is missing`);
  }
  if (problems.length) return { problems };
  if (metadata['qwts-contract'] !== CONTRACT_VERSION) {
    problems.push(`metadata.qwts-contract is "${metadata['qwts-contract']}"; this gate checks contract ${CONTRACT_VERSION}`);
  }
  if (!SIDE_EFFECTS.includes(metadata['qwts-side-effects'])) {
    problems.push(`metadata.qwts-side-effects must be one of ${SIDE_EFFECTS.join(', ')}`);
  }
  const clis = metadata['qwts-cli'].split(',').map((s) => s.trim());
  if (clis.some((c) => !c || /\s/.test(c))) problems.push('metadata.qwts-cli must be executable names separated by commas');
  const validated = parseVersion(metadata['qwts-validated']);
  if (!validated || /^v/.test(metadata['qwts-validated'])) problems.push('metadata.qwts-validated must be bare SemVer');
  let range = null;
  try {
    range = parseRange(metadata['qwts-versions']);
  } catch (error) {
    problems.push(`metadata.qwts-versions: ${error.message}`);
  }
  const rangeProblems = [];
  if (range && validated) {
    if (!satisfies(validated, range)) rangeProblems.push('metadata.qwts-validated is outside metadata.qwts-versions');
    rangeProblems.push(...checkRangeBounded(range, validated));
  }
  return { problems, rangeProblems, clis, range, validated };
}

// ---------------------------------------------------------------- Executable

export function versionFromOutput(stdout) {
  const first = String(stdout).split(/\r?\n/).find((l) => l.trim()) ?? '';
  const token = first.trim().split(/\s+/).pop() ?? '';
  return parseVersion(token);
}

function run(command, args, { env, timeoutMs = 10_000 } = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const error = r.error?.code === 'ETIMEDOUT' ? new Error(`timed out after ${timeoutMs / 1000} s`) : r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error };
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

export function compareBundle(skillDir, bundleDir) {
  const problems = [];
  if (!statSync(skillDir, { throwIfNoEntry: false })?.isDirectory()) return [`source skill directory ${skillDir} is missing`];
  if (!statSync(bundleDir, { throwIfNoEntry: false })?.isDirectory()) return [`bundle directory ${bundleDir} is missing`];
  const source = listFiles(skillDir);
  const bundled = listFiles(bundleDir);
  for (const f of source) {
    if (!bundled.includes(f)) problems.push(`bundle is missing ${f}`);
    else if (!readFileSync(join(skillDir, f)).equals(readFileSync(join(bundleDir, f)))) problems.push(`bundle's ${f} differs from the source revision`);
  }
  for (const f of bundled) if (!source.includes(f)) problems.push(`bundle has ${f}, which the source skill does not`);
  return problems;
}

function jsonArray(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) throw new Error(`${label} must be a JSON array of strings`);
  return value;
}

export function gate({ skill, executable, bundle, bundleArgsJson, testJson }) {
  const failures = [];
  const fail = (check, message) => failures.push(`check ${check}: ${message}`);
  const skillDir = resolve(skill);
  const exe = resolve(executable);

  let contract = {};
  try {
    const fields = parseFrontmatter(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'));
    contract = checkFrontmatter(fields, basename(skillDir));
    contract.problems.forEach((p) => fail(1, p));
    (contract.rangeProblems ?? []).forEach((p) => fail(3, p));
  } catch (error) {
    fail(1, error.code === 'ENOENT' ? `${join(skillDir, 'SKILL.md')} is missing` : error.message);
  }

  const v = run(exe, ['--version']);
  const released = v.error || v.status !== 0 ? null : versionFromOutput(v.stdout);
  if (v.error) fail(2, `could not run ${exe} --version: ${v.error.message}`);
  else if (v.status !== 0) fail(2, `${exe} --version exited ${v.status}`);
  else if (!released) fail(2, `${exe} --version did not print a bare SemVer version`);
  if (contract.clis && !contract.clis.includes(basename(exe))) fail(1, `metadata.qwts-cli does not list ${basename(exe)}`);
  if (released && contract.range && !satisfies(released, contract.range)) {
    fail(2, `released version ${formatVersion(released)} is outside qwts-versions`);
  }

  failures.push(...compareBundle(skillDir, resolve(bundle)).map((p) => `check 4: ${p}`));
  try {
    const b = run(exe, jsonArray(bundleArgsJson, 'bundle-args-json'));
    const reported = b.stdout.split(/\s+/).filter(Boolean).map((t) => {
      try { return realpathSync(t); } catch { return t; }
    });
    let bundleReal = resolve(bundle);
    try { bundleReal = realpathSync(bundleReal); } catch { /* reported as missing above */ }
    if (b.error || b.status !== 0) fail(4, `the bundle-location command exited ${b.error ? b.error.message : b.status}`);
    else if (!reported.includes(bundleReal)) fail(4, `the bundle-location command did not report ${bundleReal}`);
  } catch (error) {
    fail(4, error.message);
  }

  try {
    const [command, ...args] = jsonArray(testJson, 'test-json');
    if (!command) throw new Error('test-json must name a command');
    const t = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, CLI_SKILL_GATE_EXECUTABLE: exe } });
    if (t.error || t.status !== 0) fail(5, `workflow tests failed (${t.error ? t.error.message : `exit ${t.status}`})`);
  } catch (error) {
    fail(5, error.message);
  }
  return { failures, released: released ? formatVersion(released) : null };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!key || argv[i + 1] === undefined) throw new Error(`missing value for ${argv[i]}`);
    out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  for (const k of ['skill', 'executable', 'bundle', 'bundleArgsJson', 'testJson']) {
    if (!out[k]) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { failures, released } = gate(parseArgs(process.argv.slice(2)));
    for (const f of failures) console.log(`::error::CLI skill gate ${f}`);
    if (failures.length) process.exit(1);
    console.log(`CLI skill gate passed for ${released}`);
  } catch (error) {
    console.log(`::error::CLI skill gate: ${error.message}`);
    process.exit(1);
  }
}
