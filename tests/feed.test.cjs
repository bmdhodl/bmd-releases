'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateFeed, verifyDownloaded, readLimited } = require('../scripts/check-feed.cjs');

function fixture() {
  const bytes = Buffer.from('test installer bytes, never executable');
  const version = '1.2.3';
  const name = `BMD-Setup-${version}-x64.exe`;
  const base = `https://github.com/bmdhodl/bmd-releases/releases/download/v${version}/`;
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const manifest = { schema: 1, version, releasedAt: '2026-09-23T01:29:05.000Z',
    eligibilityDate: '2026-09-23T01:29:05.000Z', installerUrl: base + name,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    publisher: 'BMD PAT LLC', platform: 'windows-x64', supportedWindows: ['Windows 11'],
    notesUrl: `https://github.com/bmdhodl/bmd-releases/releases/tag/v${version}`,
    workspaceSchema: { readMin: 1, readMax: 1, write: 1 } };
  const metadata = { version, files: [{ url: name, sha512, size: bytes.length }], path: name, sha512 };
  const release = { tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [name, name + '.blockmap', 'latest.yml', 'bmd-release.json'].map(asset => ({
      name: asset, size: asset === name ? bytes.length : 100, browser_download_url: base + asset })) };
  return { bytes, name, release, manifest, metadata };
}

test('published manifest, API assets and update feed agree', () => {
  const f = fixture();
  assert.equal(validateFeed(f.release, f.manifest, f.metadata).name, f.name);
});

for (const [name, mutate] of [
  ['withdrawn manifest', f => { f.manifest.withdrawn = true; }],
  ['wrong publication tag', f => { f.release.tag_name = 'v9.9.9'; }],
  ['draft release', f => { f.release.draft = true; }],
  ['missing blockmap', f => { f.release.assets.splice(1, 1); }],
  ['duplicate installer', f => { f.release.assets.push(f.release.assets[0]); }],
  ['off-repository URL', f => { f.manifest.installerUrl = 'https://example.com/payload.exe'; }],
  ['asset size differs', f => { f.release.assets[0].size++; }],
  ['invalid schema range', f => { f.manifest.workspaceSchema.write = 2; }],
  ['invalid release date', f => { f.manifest.releasedAt = 'tomorrow'; }],
  ['missing SHA256', f => { delete f.manifest.sha256; }],
  ['update version differs', f => { f.metadata.version = '9.9.9'; }],
  ['update path traversal', f => { f.metadata.files[0].url = '../payload.exe'; }],
  ['legacy digest differs', f => { f.metadata.sha512 = 'A'.repeat(88); }],
]) {
  test(`refuses ${name}`, () => {
    const f = fixture(); mutate(f);
    assert.throws(() => validateFeed(f.release, f.manifest, f.metadata));
  });
}

test('downloaded bytes must match both manifest and existing updater validator', () => {
  const f = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmd-feed-test-'));
  try {
    fs.writeFileSync(path.join(directory, f.name), f.bytes);
    fs.writeFileSync(path.join(directory, 'latest.yml'), JSON.stringify(f.metadata));
    assert.doesNotThrow(() => verifyDownloaded(directory, f.manifest));
    fs.writeFileSync(path.join(directory, f.name), Buffer.alloc(f.bytes.length));
    assert.throws(() => verifyDownloaded(directory, f.manifest), /SHA256/);
    fs.writeFileSync(path.join(directory, f.name), f.bytes);
    f.metadata.files[0].sha512 = 'broken';
    fs.writeFileSync(path.join(directory, 'latest.yml'), JSON.stringify(f.metadata));
    assert.throws(() => verifyDownloaded(directory, f.manifest), /checksum/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP errors and oversized bodies cannot become healthy readbacks', async () => {
  const fake = (body, status = 200) => async () => new Response(body, { status });
  assert.equal((await readLimited('https://example.invalid', 3, {}, fake('abc'))).toString(), 'abc');
  await assert.rejects(readLimited('https://example.invalid', 3, {}, fake('abcd')), /exceeded/);
  await assert.rejects(readLimited('https://example.invalid', 3, {}, fake('bad', 503)), /HTTP 503/);
});
