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

test('every vendored pack and the shipped Semgrep pack are in THIRD_PARTY_NOTICES.md with pin and license', () => {
  assert.match(notices, /c1c8a8c1471069fb0e188eeaff69b8e8db6564a8/);
  assert.match(notices, /e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff/);
  assert.match(notices, /CC BY-SA 4\.0|CC-BY-SA-4\.0/);
  assert.match(notices, /jgates\/packs\/semgrep\/jgates-semgrep/);
  assert.match(notices, /registry rules are never bundled/);
  assert.match(notices, /5cf9b032440be53ce345ab3c130fda46ba1ce7a2/);
  for (const dir of ['jgates/vendor/cloudflare-security-audit', 'jgates/vendor/trailofbits-skills', 'jgates/packs/semgrep/jgates-semgrep', 'jgates/vendor/owasp-asvs', 'jgates/packs/asvs/jgates-asvs-map']) {
    assert.ok(notices.includes('`' + dir + '`'), `${dir} is listed`);
    for (const f of ['LICENSE', 'NOTICE.md', 'jgates-pack.json']) assert.ok(fs.existsSync(path.join(root, dir, f)), `${dir}/${f} exists`);
  }
});

test('every Quality integration of V2 has a row in THIRD_PARTY_NOTICES.md', () => {
  for (const tool of ['zizmor', 'oasdiff', 'CodeQL', 'Schemathesis', 'ZAP', 'StrykerJS', 'govulncheck', 'cargo-audit']) {
    const row = notices.split('\n').find((l) => l.startsWith('|') && l.includes(tool));
    assert.ok(row, `${tool} has a row`);
    assert.match(row, /MIT|Apache-2\.0|BSD|CodeQL Terms/, `${tool} row names a license`);
  }
});

test('every tool shipped in the tools image has a row with a license and a source URL', () => {
  const image = JSON.parse(fs.readFileSync(path.join(root, 'jgates', 'release', 'image-tools.json'), 'utf8'));
  const tools = Object.keys(image.tools);
  assert.ok(tools.length >= 60, `image-tools.json lists ${tools.length} tools`);
  const start = notices.indexOf('## Tools shipped in the tools image');
  assert.ok(start >= 0, 'the tools image section exists');
  const rows = new Map();
  for (const line of notices.slice(start).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const name = cells[1] && cells[1].match(/^`([^`]+)`$/);
    if (name) rows.set(name[1], cells);
  }
  const problems = [];
  for (const tool of tools) {
    const cells = rows.get(tool);
    if (!cells) problems.push(`${tool}: no row`);
    else if (!cells[2]) problems.push(`${tool}: no license`);
    else if (!/^<https:\/\/[^>\s]+>$/.test(cells[3] || '')) problems.push(`${tool}: no source URL`);
  }
  assert.deepEqual(problems, []);
  for (const gpl of ['git', 'rsync', 'shellcheck', 'hadolint', 'golangci-lint']) assert.match(rows.get(gpl)[2], /GPL/, `${gpl} is marked GPL`);
});
