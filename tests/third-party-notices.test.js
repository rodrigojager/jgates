'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');

function listed(name) {
  return notices.includes('`' + name + '`');
}

function pythonDependencyNames(pyproject) {
  const match = pyproject.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  assert.ok(match, 'quality-gate/pyproject.toml has a dependencies list');
  return [...match[1].matchAll(/"([A-Za-z0-9_.-]+)\s*(?:[=<>!~\[;][^"]*)?"/g)].map((m) => m[1]);
}

test('every direct dependency of jgates is in THIRD_PARTY_NOTICES.md', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'jgates', 'package.json'), 'utf8'));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(names.length > 0);
  const missing = names.filter((n) => !listed(n));
  assert.deepEqual(missing, [], `missing from THIRD_PARTY_NOTICES.md: ${missing.join(', ')}`);
});

test('every direct dependency of the sidecar is in THIRD_PARTY_NOTICES.md', () => {
  const text = fs.readFileSync(path.join(root, 'quality-gate', 'pyproject.toml'), 'utf8');
  const names = pythonDependencyNames(text);
  assert.ok(names.length > 0);
  const missing = names.filter((n) => !listed(n));
  assert.deepEqual(missing, [], `missing from THIRD_PARTY_NOTICES.md: ${missing.join(', ')}`);
});

test('every scanner of the images has a row with a license', () => {
  for (const scanner of ['MegaLinter', 'Semgrep', 'Gitleaks', 'Trivy', 'OSV-Scanner', 'Checkov', 'jscpd', 'Ruff', 'Import Linter']) {
    const row = notices.split('\n').find((l) => l.startsWith('|') && l.includes(scanner));
    assert.ok(row, `${scanner} has a row`);
    assert.match(row, /MIT|Apache-2\.0|AGPL|LGPL|BSD/, `${scanner} row names a license`);
  }
});

test('license limits are noted', () => {
  assert.match(notices, /Semgrep Registry rules[^\n]*Limit:/);
  assert.match(notices, /MegaLinter[^\n]*Limit:/);
});
