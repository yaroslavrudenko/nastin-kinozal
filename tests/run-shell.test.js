'use strict';
// N4 (COMMON DECISION batch 5, 2026-11-05): tests/run.sh started by another shell (sh tests/run.sh, bash tests/run.sh) runs
// itself again under zsh before set -u and the cd — before, sh stopped at the zsh-only ${0:A:h} with no test run and exit 0.
// The zero-test exit (NO TESTS RAN, 2) is pinned. Each case runs a temp copy: tests/run.sh of the tree under test (ROOT) and
// one fixture file. An emptied test file still counts as one passing test in Node 22: the by-name diff (VG-4) catches that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./harness');

const PASSING = "require('node:test')('one', () => {});\n";
const FAILING = "require('node:test')('one', () => { throw new Error('red'); });\n";

function sandbox(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-sh-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.copyFileSync(path.join(ROOT, 'tests', 'run.sh'), path.join(dir, 'tests', 'run.sh'));
  fs.writeFileSync(path.join(dir, 'tests', 'a.test.js'), fixture);
  return dir;
}
// shell tests/run.sh in dir; node: the runner's NODE (this Node by default). The child is a suite of its own, not part of this one.
function run(shell, dir, node) {
  const env = Object.assign({}, process.env, { NODE: node || process.execPath });
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(shell, ['tests/run.sh'], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
}
function inSandbox(fixture, fn) {
  const dir = sandbox(fixture);
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const shell of ['sh', 'bash']) {
  test('N4: ' + shell + ' tests/run.sh runs the suite under zsh — «# tests 1», with zsh\'s exit code (0)', () => inSandbox(PASSING, (dir) => {
    const r = run(shell, dir), z = run('zsh', dir);
    assert.match(r.stdout, /^# tests 1$/m, r.stdout + r.stderr);
    assert.equal(r.status, z.status, 'zsh ' + z.status + ', ' + shell + ' ' + r.status);
    assert.equal(r.status, 0, r.stderr);
  }));
  test('N4: ' + shell + ' tests/run.sh with a failing test exits non-zero, as zsh does', () => inSandbox(FAILING, (dir) => {
    const r = run(shell, dir), z = run('zsh', dir);
    assert.match(r.stdout, /^not ok · one$/m, r.stdout + r.stderr);
    assert.notEqual(r.status, 0);
    assert.equal(r.status, z.status, 'zsh ' + z.status + ', ' + shell + ' ' + r.status);
  }));
}

test('N4 (pin): a runner that reports no tests — «NO TESTS RAN», exit 2 (sh and zsh alike)', () => inSandbox(PASSING, (dir) => {
  const stub = path.join(dir, 'node-silent');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const shell of ['sh', 'zsh']) {
    const r = run(shell, dir, stub);
    assert.equal(r.status, 2, shell + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, /NO TESTS RAN/);
  }
}));
