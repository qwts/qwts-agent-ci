import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('all Changesets lanes share one semantic release-count contract', () => {
  const policy = read('docs/ci-execution-policy.md');
  const rollout = read('docs/governed-ci-rollout.md');
  const action = read('.github/actions/changeset-release-count/action.yml');
  const counter = read('.github/actions/changeset-release-count/semantic-release-count.mjs');
  const contract = `${policy}\n${rollout}`;

  for (const lane of ['Version planning', 'tag planning', 'release verification']) {
    assert.match(contract, new RegExp(lane.replace(' ', '\\s+'), 'iu'));
  }
  assert.match(contract, /semantic `releases\.length`/u);
  assert.match(contract, /Empty or frontmatter-only\s+governance changesets/u);
  assert.match(contract, /a positive count fails\s+closed/u);
  assert.match(action, /git fetch --no-tags --depth=1 origin/u);
  assert.match(counter, /'changeset', 'status', '--output'/u);
  assert.match(counter, /status\.releases\.length/u);
  assert.doesNotMatch(action, /find \.changeset|\.changeset\/\*\.md/u);
});

// The wording of the release-lifecycle policy is reviewed in the PR. What is pinned here is
// that exactly one document owns it and that the others point at it instead of restating it.
test('one document owns the generated-projection contract', () => {
  const policy = read('docs/ci-execution-policy.md');
  const consumers = ['governed-ci-rollout', 'governed-ci-release-lifecycle-fleet']
    .map((name) => read(`docs/${name}.md`));

  assert.match(policy, /`release-lifecycles\.json`/u);
  assert.match(policy, /`pull-requests: read`/u);
  assert.match(policy, /both `github\.actor` and `github\.triggering_actor`/u);
  assert.match(policy, /never required to retain the\s+Changesets it consumed/u);
  assert.match(policy, /complete PR file list\s+contains only\s+paths in the managed harness inventory/u);
  assert.match(policy, /`generated-projection` and\s+`harness-projection` modes/u);

  for (const consumer of consumers) {
    assert.match(consumer, /ci-execution-policy\.md/u, 'each consumer links the owning policy');
    assert.doesNotMatch(
      consumer,
      /base ref, head ref, canonical head repository, and author/u,
      'the projection identity tuple is restated outside the owning policy',
    );
  }
});

// Coverage of the governed manifest (governance/repos.json, now in qwts-agent-org) is
// asserted where the manifest lives. Here every catalog entry must be unique, carry a
// complete projection identity, and have a published disposition in the fleet handoff.
test('every release lifecycle catalog entry is unique, complete, and published', () => {
  const catalog = JSON.parse(read('governance/release-lifecycles.json'));
  const fleet = read('docs/governed-ci-release-lifecycle-fleet.md');

  for (const entry of catalog.repositories) {
    const name = entry.repository.replace(/^qwts\//u, '');
    const entries = catalog.repositories.filter((candidate) => candidate.repository === entry.repository);
    assert.equal(entries.length, 1, `${name} must appear in the catalog exactly once`);
    const { metadataSystem, generatedProjection, harnessProjection } = entry;
    assert.ok(fleet.includes(`\`${name}\``), `${name} has no published disposition`);
    if (metadataSystem === 'none') {
      assert.equal(generatedProjection, null, `${name} has no release system but names a projection`);
      assert.equal(harnessProjection, null, `${name} has no release gate but names a harness projection`);
      continue;
    }
    for (const field of ['baseRef', 'headRef', 'author']) {
      assert.ok(generatedProjection?.[field], `${name} projection identity is missing ${field}`);
    }
    for (const field of ['baseRef', 'headRef', 'author', 'sourceRepository']) {
      assert.ok(harnessProjection?.[field], `${name} harness identity is missing ${field}`);
    }
  }
});

test('user-owned fallback preserves strict exact-SHA evidence and merge methods', () => {
  const policy = read('docs/ci-execution-policy.md');
  const rollout = read('docs/governed-ci-rollout.md');
  const contract = `${policy}\n${rollout}`;

  assert.match(contract, /limits merge queues to organization-owned repositories/u);
  assert.match(contract, /governed\s+`chores-dumb\[bot\]` ready-branch updater/u);
  assert.match(contract, /updater changes\s+receive a fresh complete suite/u);
  assert.match(contract, /tree equivalence, and an earlier\s+`main` success do not count/u);
  assert.match(contract, /Do not change enabled merge methods/u);
  assert.match(rollout, /organization-owned repositories prefer GitHub's native merge queue/u);
});

test('required contexts are bound to their real publishers', () => {
  const policy = read('docs/ci-execution-policy.md');
  const rollout = read('docs/governed-ci-rollout.md');
  const contract = `${policy}\n${rollout}`;

  assert.match(contract, /`CodeQL` \| GitHub Advanced Security App/u);
  assert.match(contract, /`CI` \| GitHub Actions/u);
  assert.match(contract, /`chores-dumb\[bot\]` initiates governed writes but publishes none/u);
  assert.match(contract, /not transient `E2E`/u);
  for (const publisher of ['GitHub Advanced Security App', 'GitHub Actions']) {
    assert.match(rollout, new RegExp(publisher, 'u'));
  }
});

test('every privileged chores-dumb consumer uses the Client ID and private key boundary', () => {
  const policy = read('docs/ci-execution-policy.md');
  const rollout = read('docs/governed-ci-rollout.md');

  for (const consumer of [
    'ready-branch updater',
    'Version packages PR',
    'tag creation',
    'release-recovery dispatch',
    'harness synchronization',
  ]) {
    assert.match(`${policy}\n${rollout}`, new RegExp(consumer, 'u'));
  }
  const contract = `${policy}\n${rollout}`;
  assert.match(contract, /`CHORES_DUMB_CLIENT_ID`/u);
  assert.match(contract, /`CHORES_DUMB_PRIVATE_KEY`/u);
  assert.match(contract, /Do not substitute an App ID variable/u);
  assert.match(contract, /mint again after any wait that could approach one hour/u);
  assert.match(contract, /Never pass App credentials or tokens to third-party actions/u);
  assert.match(contract, /secret merely for actor\s+authorization/u);
});

test('repository settings and concurrency rollout evidence stay explicit', () => {
  const policy = read('docs/ci-execution-policy.md');
  const rollout = read('docs/governed-ci-rollout.md');

  assert.match(`${policy}\n${rollout}`, /policy and reference\s+workflow stay unchanged/u);
  assert.match(rollout, /No\s+deterministic group or expression defect was found/iu);
  for (const setting of [
    'Workflow execution protections',
    'full-commit-SHA pinning',
    'read-only default token',
    'Allow GitHub Actions to create and approve pull requests',
    'CodeQL analysis',
  ]) {
    assert.match(rollout, new RegExp(setting, 'u'));
  }
});

test('the runtime policy documents fan-out backpressure and its decision', () => {
  const runtime = read('docs/ci-runtime-policy.md');

  assert.match(runtime, /merge-one-and-wait/u);
  assert.match(runtime, /ENG-0313-ci-fan-out-backpressure\.md/u);
});
