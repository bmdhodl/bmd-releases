'use strict';
const test = require('node:test');
const { before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { validateFeed, verifyDownloaded, readLimited, checkFeed } = require('../scripts/check-feed.cjs');

before(() => mock.method(globalThis, 'fetch', async () => { throw new Error('Tests must inject fetch; live networking refused'); }));
after(() => mock.restoreAll());

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

for (const releaseTag of [null, 'v1.2.3']) {
  test(`audit reads the exact requested release: ${releaseTag || 'latest'}`, async () => {
    const f = fixture();
    const calls = [];
    const fetcher = async (url, options = {}) => {
      calls.push(url);
      if (options.method === 'HEAD') {
        const asset = f.release.assets.find(row => row.browser_download_url === url);
        assert.ok(asset);
        return new Response(null, { headers: { 'content-length': String(asset.size) } });
      }
      if (url.includes('api.github.com')) return new Response(JSON.stringify(f.release));
      if (url.endsWith('bmd-release.json')) return new Response(JSON.stringify(f.manifest));
      if (url.endsWith('latest.yml')) return new Response(JSON.stringify(f.metadata));
      throw new Error(`Unexpected URL ${url}`);
    };
    const result = await checkFeed(false, { releaseTag, fetcher });
    assert.equal(result.version, '1.2.3');
    assert.equal(result.target, releaseTag || 'latest');
    assert.ok(calls[0].endsWith(releaseTag ? '/releases/tags/v1.2.3' : '/releases/latest'));
    assert.ok(calls[1].includes(releaseTag ? '/download/v1.2.3/' : '/latest/download/'));
    assert.equal(calls.length, 5);
    if (releaseTag) assert.ok(calls.every(url => !url.includes('/latest/download/')));
  });
}

for (const releaseTag of ['../latest', 'v1.2.3/asset', '', 'v1.2.3-rc1']) {
  test(`refuses invalid release target before networking: ${releaseTag}`, async () => {
    let called = false;
    await assert.rejects(checkFeed(false, { releaseTag, fetcher: async () => { called = true; } }), /Invalid release tag/);
    assert.equal(called, false);
  });
}

test('a tag API response cannot silently select a different release', async () => {
  const f = fixture();
  await assert.rejects(checkFeed(false, { releaseTag: 'v9.9.9', fetcher: async () => new Response(JSON.stringify(f.release)) }), /Requested release identity mismatch/);
});

test('publication concurrency keeps distinct release tags in distinct groups', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/feed-audit.yml'), 'utf8');
  const group = workflow.match(/  group: (.+)/)[1];
  const evaluate = (event, tag, schedule = '') => group.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) =>
    runInNewContext(expression, { github: { event_name: event, event: { release: { tag_name: tag }, schedule } } }));
  const tags = ['v1.2.3', 'v1.2.4', 'v1.2.5'].map(tag => evaluate('release', tag));
  assert.equal(new Set(tags).size, 3);
  assert.notEqual(evaluate('schedule', '', '17 * * * *'), evaluate('schedule', '', '43 8 * * *'));
  assert.equal(evaluate('release', 'v1.2.3'), evaluate('release', 'v1.2.3'));
});

for (const [event, schedule, prerelease, deep, metadata, installer] of [
  ['release', '', false, false, true, false],
  ['release', '', true, false, false, false],
  ['schedule', '17 * * * *', false, false, true, false],
  ['schedule', '43 8 * * *', false, false, false, true],
  ['workflow_dispatch', '', false, false, true, false],
  ['workflow_dispatch', '', false, true, false, true],
]) {
  test(`workflow admission ${event} / ${schedule} / prerelease=${prerelease} / deep=${deep}`, () => {
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/feed-audit.yml'), 'utf8');
    assert.match(workflow, /release:\s+types: \[published\]/);
    const context = { github: { event_name: event, event: { schedule, release: { prerelease } } }, inputs: { deep } };
    for (const [job, expected] of [['metadata', metadata], ['installer', installer]]) {
      const expression = workflow.match(new RegExp(`  ${job}:\\r?\\n    if: (.+)`))?.[1];
      assert.ok(expression);
      assert.equal(runInNewContext(expression, context), expected);
    }
  });
}

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
