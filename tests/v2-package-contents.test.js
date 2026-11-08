'use strict';

// What the npm package carries: the notices, the vendored third-party packs with their licenses, the shipped Semgrep
// pack, and nothing that must never ship (credentials, keys, the official Semgrep registry rules).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function packedFiles() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // --ignore-scripts: the dry run must not trigger the build (prepare) of the repository.
  const r = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240000,
  });
  assert.equal(r.status, 0, `npm pack --dry-run failed: ${r.stderr}`);
  const start = r.stdout.indexOf('[');
  const parsed = JSON.parse(r.stdout.slice(start));
  assert.ok(Array.isArray(parsed) && parsed[0] && Array.isArray(parsed[0].files), 'npm pack --json lists files');
  return parsed[0].files.map((f) => f.path.replace(/\\/g, '/'));
}

const files = packedFiles();
const has = (p) => files.includes(p);

test('the package carries the notices and the license', () => {
  for (const p of ['THIRD_PARTY_NOTICES.md', 'LICENSE', 'README.md', 'docs/jgates/gates.en.md', 'docs/jgates/gates.pt-BR.md']) {
    assert.ok(has(p), `${p} is in the package`);
  }
});

test('the Cloudflare and Trail of Bits packs ship with their licenses, notices and records', () => {
  for (const dir of ['jgates/vendor/cloudflare-security-audit', 'jgates/vendor/trailofbits-skills']) {
    for (const name of ['LICENSE', 'NOTICE.md', 'jgates-pack.json']) assert.ok(has(`${dir}/${name}`), `${dir}/${name} is in the package`);
  }
  assert.ok(files.some((f) => f.startsWith('jgates/vendor/cloudflare-security-audit/prompts/')), 'the Cloudflare prompts ship');
  assert.ok(files.some((f) => f.startsWith('jgates/vendor/trailofbits-skills/') && f.endsWith('method.md')), 'the Trail of Bits methods ship');

  const cloudflare = JSON.parse(fs.readFileSync(path.join(root, 'jgates/vendor/cloudflare-security-audit/jgates-pack.json'), 'utf8'));
  assert.equal(cloudflare.source.revision, 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a8');
  assert.equal(cloudflare.spdx, 'MIT');
  const trail = JSON.parse(fs.readFileSync(path.join(root, 'jgates/vendor/trailofbits-skills/jgates-pack.json'), 'utf8'));
  assert.equal(trail.source.revision, 'e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff');
  assert.equal(trail.spdx, 'CC-BY-SA-4.0');
});

test('the JGates Semgrep rule pack ships with its license and record', () => {
  const dir = 'jgates/packs/semgrep/jgates-semgrep';
  for (const name of ['LICENSE', 'NOTICE.md', 'jgates-pack.json']) assert.ok(has(`${dir}/${name}`), `${dir}/${name} is in the package`);
  assert.ok(files.some((f) => f.startsWith(`${dir}/rules/`) && f.endsWith('.yaml')), 'the pack carries rule files');
});

test('credentials, keys and the official Semgrep rules are not in the package', () => {
  const credential = (f) => /(^|\/)\.env($|\.)/.test(f) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(f) || /(^|\/)id_(rsa|ed25519|ecdsa)/.test(f) || /(^|\/)\.npmrc$/.test(f) || /(^|\/)(secrets?|credentials)\.(json|ya?ml|txt)$/i.test(f);
  assert.deepEqual(files.filter(credential), [], 'no credential or key file is packed');
  const official = (f) => /(^|\/)semgrep-rules(\/|$)/i.test(f) || /(^|\/)semgrep-registry(\/|$)/i.test(f);
  assert.deepEqual(files.filter(official), [], 'the official Semgrep registry rules are not packed');
  // The only Semgrep rules in the package are the JGates-authored pack.
  const rules = files.filter((f) => /semgrep/i.test(f) && /\/rules\//.test(f));
  for (const f of rules) assert.ok(f.startsWith('jgates/packs/semgrep/jgates-semgrep/'), `${f} is not part of the JGates pack`);
});
