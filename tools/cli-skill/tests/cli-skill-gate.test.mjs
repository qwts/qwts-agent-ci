import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkFrontmatter,
  checkRangeBounded,
  gate,
  parseFrontmatter,
  parseRange,
  parseVersion,
  satisfies,
  versionFromOutput,
} from '../../../.github/actions/cli-skill-gate/cli-skill-gate.mjs';

const ok = (range, v) => satisfies(parseVersion(v), parseRange(range));

describe('SemVer ranges (npm semver grammar, default options)', () => {
  test('primitive, caret, tilde, x-range, and hyphen ranges', () => {
    assert.ok(ok('>=1.4.0 <2.0.0', '1.9.9'));
    assert.ok(!ok('>=1.4.0 <2.0.0', '2.0.0'));
    assert.ok(ok('^1.2.3', '1.9.0'));
    assert.ok(!ok('^1.2.3', '2.0.0'));
    assert.ok(ok('^0.2.3', '0.2.9'));
    assert.ok(!ok('^0.2.3', '0.3.0'));
    assert.ok(!ok('^0.0.3', '0.0.4'));
    assert.ok(ok('~1.2.3', '1.2.9'));
    assert.ok(!ok('~1.2.3', '1.3.0'));
    assert.ok(ok('1.x', '1.5.0'));
    assert.ok(ok('1.2 - 2.3.4', '2.3.4'));
    assert.ok(!ok('1.2.3 - 2.3', '2.4.0'));
    assert.ok(ok('>=1.0.0 <1.5.0 || >=2.0.0 <2.1.0', '2.0.5'));
  });

  test('a prerelease satisfies only a range naming its tuple', () => {
    assert.ok(!ok('>=1.0.0 <2.0.0', '1.5.0-beta'));
    assert.ok(ok('>=1.2.3-beta.2 <1.3.0', '1.2.3-beta.10'));
    assert.ok(!ok('>=1.2.3-beta.2 <1.3.0', '1.2.4-beta'));
  });

  test('versions are bare SemVer', () => {
    assert.equal(parseVersion('v1.2.3'), null);
    assert.equal(parseVersion('1.2'), null);
    assert.deepEqual(versionFromOutput('example-cli 1.4.2\nbuilt today'), parseVersion('1.4.2'));
    assert.equal(versionFromOutput('example-cli v1.4.2'), null);
  });

  test('the range is capped at the next major after validated, next minor in 0.x', () => {
    assert.deepEqual(checkRangeBounded(parseRange('>=1.4.0 <2.0.0'), parseVersion('1.4.2')), []);
    assert.deepEqual(checkRangeBounded(parseRange('^1.4.0'), parseVersion('1.4.2')), []);
    assert.match(checkRangeBounded(parseRange('>=1.4.0 <3.0.0'), parseVersion('1.4.2'))[0], /past 2\.0\.0/);
    assert.match(checkRangeBounded(parseRange('>=1.4.0'), parseVersion('1.4.2'))[0], /no upper bound/);
    assert.deepEqual(checkRangeBounded(parseRange('^0.4.1'), parseVersion('0.4.1')), []);
    assert.match(checkRangeBounded(parseRange('>=0.4.0 <1.0.0'), parseVersion('0.4.1'))[0], /past 0\.5\.0/);
  });
});

const GOOD = [
  '---',
  'name: example-cli',
  'description: "Run Example CLI workflows and recover from their failures."',
  'metadata:',
  '  qwts-contract: "1"',
  '  qwts-cli: "example-cli"',
  '  qwts-versions: ">=1.4.0 <2.0.0"',
  '  qwts-validated: "1.4.2"',
  '  qwts-side-effects: "remote-write"',
  '---',
  '',
  '# Example CLI',
].join('\n');

describe('frontmatter', () => {
  test('a conforming skill has no problems', () => {
    const r = checkFrontmatter(parseFrontmatter(GOOD), 'example-cli');
    assert.deepEqual([...r.problems, ...r.rangeProblems], []);
  });

  test('contract keys at the top level are refused', () => {
    const text = GOOD.replace('metadata:', 'versions: ">=1.4.0 <2.0.0"\nmetadata:');
    assert.match(checkFrontmatter(parseFrontmatter(text), 'example-cli').problems[0], /unexpected top-level field "versions"/);
  });

  test('a metadata line without a colon fails closed', () => {
    const text = GOOD.replace('  qwts-contract: "1"', '  qwts-contract: "1"\n  version "0.7.10"');
    assert.throws(() => parseFrontmatter(text), /expected "key: value"/);
  });

  test('missing contract keys, a bad side-effect class, and a name mismatch are reported', () => {
    const noContract = checkFrontmatter(parseFrontmatter(GOOD.replace(/ {2}qwts-validated.*\n/, '')), 'example-cli');
    assert.ok(noContract.problems.includes('metadata.qwts-validated is missing'));
    const badClass = checkFrontmatter(parseFrontmatter(GOOD.replace('remote-write', 'network')), 'example-cli');
    assert.match(badClass.problems[0], /qwts-side-effects must be one of/);
    assert.match(checkFrontmatter(parseFrontmatter(GOOD), 'other').problems[0], /must match the skill directory/);
  });

  test('validated outside the range is a range problem', () => {
    const r = checkFrontmatter(parseFrontmatter(GOOD.replace('"1.4.2"', '"1.3.0"')), 'example-cli');
    assert.ok(r.rangeProblems.includes('metadata.qwts-validated is outside metadata.qwts-versions'));
  });
});

// A packaged fixture: a CLI that prints its version and its bundle's location.
function fixture({ version = '1.5.0', bundleReport = true, testExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cli-skill-gate-'));
  const skill = join(root, 'src', 'skills', 'example-cli');
  mkdirSync(join(skill, 'references'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), GOOD);
  writeFileSync(join(skill, 'references', 'output.md'), '# Output\n');
  const bundle = join(root, 'pkg', 'share', 'example-cli', 'skill');
  mkdirSync(join(root, 'pkg', 'share', 'example-cli'), { recursive: true });
  cpSync(skill, bundle, { recursive: true });
  const executable = join(root, 'pkg', 'bin', 'example-cli');
  mkdirSync(join(root, 'pkg', 'bin'));
  writeFileSync(executable, [
    '#!/usr/bin/env node',
    `if (process.argv[2] === '--version') console.log('example-cli ${version}');`,
    `else if (process.argv[2] === 'skill-path') console.log(${JSON.stringify(bundleReport ? bundle : '/elsewhere')});`,
    'else process.exit(2);',
  ].join('\n'));
  chmodSync(executable, 0o755);
  const tests = join(root, 'workflow-test.mjs');
  writeFileSync(tests, `if (!process.env.CLI_SKILL_GATE_EXECUTABLE) process.exit(3); process.exit(${testExit});`);
  return {
    root, skill, bundle, executable,
    args: {
      skill, executable, bundle,
      bundleArgsJson: '["skill-path"]',
      testJson: JSON.stringify([process.execPath, tests]),
    },
  };
}

describe('release gate', () => {
  test('passes a conforming release', () => {
    const f = fixture();
    assert.deepEqual(gate(f.args), { failures: [], released: '1.5.0' });
  });

  test('fails a release outside the range', () => {
    const { failures } = gate(fixture({ version: '2.0.0' }).args);
    assert.deepEqual(failures, ['check 2: released version 2.0.0 is outside qwts-versions']);
  });

  test('fails a bundle that drifted from the source revision', () => {
    const f = fixture();
    writeFileSync(join(f.bundle, 'references', 'output.md'), '# Stale\n');
    assert.deepEqual(gate(f.args).failures, ["check 4: bundle's references/output.md differs from the source revision"]);
  });

  test('fails when the bundle-location command does not report the bundle', () => {
    assert.match(gate(fixture({ bundleReport: false }).args).failures[0], /^check 4: the bundle-location command did not report/);
  });

  test('fails when the workflow tests fail', () => {
    assert.deepEqual(gate(fixture({ testExit: 1 }).args).failures, ['check 5: workflow tests failed (exit 1)']);
  });

  test('fails closed when SKILL.md is missing', () => {
    const f = fixture();
    assert.match(gate({ ...f.args, skill: join(f.root, 'nowhere') }).failures[0], /^check 1: .*SKILL\.md is missing/);
  });
});
