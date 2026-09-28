'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const verifyUpdateMetadata = require('./verify-update-metadata.cjs');
const REPOSITORY = 'bmdhodl/bmd-releases';
const BASE = `https://github.com/${REPOSITORY}/releases`;
const MAX_BYTES = 200 * 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function validateFeed(release, manifest, metadata) {
  const m = manifest;
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
  requireValue(m && m.schema === 1 && typeof m.version === 'string'
    && /^\d+\.\d+\.\d+$/.test(m.version), 'Invalid manifest schema/version');
  const name = `BMD-Setup-${m.version}-x64.exe`;
  const base = `${BASE}/download/v${m.version}/`;
  requireValue(m.withdrawn === undefined || m.withdrawn === false, 'Release withdrawn');
  requireValue(validDate(m.releasedAt) && validDate(m.eligibilityDate), 'Invalid release dates');
  requireValue(m.installerUrl === base + name && m.notesUrl === `${BASE}/tag/v${m.version}`,
    'Unexpected release URL');
  requireValue(typeof m.sha256 === 'string' && /^[a-f0-9]{64}$/.test(m.sha256), 'Invalid SHA256');
  requireValue(Number.isSafeInteger(m.bytes) && m.bytes > 0 && m.bytes <= MAX_BYTES, 'Invalid installer size');
  requireValue(m.publisher === 'BMD PAT LLC' && m.platform === 'windows-x64', 'Invalid publisher/platform');
  requireValue(Array.isArray(m.supportedWindows) && m.supportedWindows.length > 0
    && m.supportedWindows.every(v => typeof v === 'string' && v.trim() && v.length <= 100),
  'Invalid supported Windows versions');
  const schema = m.workspaceSchema;
  requireValue(schema && [schema.readMin, schema.write, schema.readMax].every(v => Number.isSafeInteger(v) && v >= 1)
    && schema.readMin <= schema.write && schema.write <= schema.readMax, 'Invalid workspace schema range');
  requireValue(release && release.draft === false && release.prerelease === false
    && release.tag_name === `v${m.version}` && Array.isArray(release.assets), 'Release identity mismatch');
  for (const assetName of [name, name + '.blockmap', 'latest.yml', 'bmd-release.json']) {
    const assets = release.assets.filter(asset => asset.name === assetName);
    requireValue(assets.length === 1 && assets[0].browser_download_url === base + assetName
      && Number.isSafeInteger(assets[0].size) && assets[0].size > 0, `Missing or invalid asset: ${assetName}`);
    if (assetName === name) requireValue(assets[0].size === m.bytes, 'Asset size mismatch');
  }
  requireValue(metadata && metadata.version === m.version && metadata.path === name
    && Array.isArray(metadata.files) && metadata.files.length === 1, 'Invalid updater identity/files');
  const file = metadata.files[0];
  requireValue(file.url === name && file.size === m.bytes, 'Invalid updater asset path/size');
  requireValue(typeof file.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
    && Buffer.from(file.sha512, 'base64').length === 64 && metadata.sha512 === file.sha512,
  'Invalid updater SHA512');
  return { version: m.version, name };
}

function verifyDownloaded(directory, manifest) {
  const name = `BMD-Setup-${manifest.version}-x64.exe`;
  const data = fs.readFileSync(path.join(directory, name));
  requireValue(data.length === manifest.bytes
    && crypto.createHash('sha256').update(data).digest('hex') === manifest.sha256,
  'Installer SHA256/size mismatch');
  verifyUpdateMetadata(directory, manifest.version);
}

async function readLimited(url, limit, options = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(120000) });
  requireValue(response.ok, `HTTP ${response.status}: ${url}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireValue(size <= limit, `Response exceeded ${limit} bytes: ${url}`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function checkFeed(deep = false, { releaseTag = null, fetcher = fetch } = {}) {
  requireValue(releaseTag === null || (typeof releaseTag === 'string' && /^v\d+\.\d+\.\d+$/.test(releaseTag)),
    'Invalid release tag');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'bmd-release-feed-check' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const selector = releaseTag === null ? 'latest' : `tags/${releaseTag}`;
  const release = JSON.parse(await readLimited(`https://api.github.com/repos/${REPOSITORY}/releases/${selector}`,
    1024 * 1024, { headers }, fetcher));
  requireValue(releaseTag === null || release.tag_name === releaseTag, 'Requested release identity mismatch');
  // Publication checks pin the event's tag. Scheduled checks additionally
  // exercise the public latest pointer, which may have moved since publication.
  const manifestPath = releaseTag === null ? 'latest/download' : `download/${releaseTag}`;
  const manifest = JSON.parse(await readLimited(`${BASE}/${manifestPath}/bmd-release.json`, 65536, {}, fetcher));
  requireValue(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version), 'Invalid version');
  const updateBytes = await readLimited(`${BASE}/download/v${manifest.version}/latest.yml`, 65536, {}, fetcher);
  const metadata = yaml.load(updateBytes.toString('utf8'));
  const selected = validateFeed(release, manifest, metadata);
  for (const name of [selected.name, selected.name + '.blockmap']) {
    const url = `${BASE}/download/v${manifest.version}/${name}`;
    const response = await fetcher(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
    requireValue(response.ok, `Download unavailable: HTTP ${response.status} ${name}`);
    const declared = response.headers.get('content-length');
    const asset = release.assets.find(row => row.name === name);
    requireValue(declared !== null && Number(declared) === asset.size, `Download size mismatch: ${name}`);
  }
  if (deep) {
    const data = await readLimited(manifest.installerUrl, manifest.bytes, {}, fetcher);
    const directory = path.resolve('dist/installer');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, selected.name), data);
    fs.writeFileSync(path.join(directory, 'latest.yml'), updateBytes);
    verifyDownloaded(directory, manifest);
  }
  return { ...selected, target: releaseTag || 'latest', bytes: manifest.bytes, sha256: manifest.sha256,
    metadata: 'passed', downloads: 'available', hashes: deep ? 'passed' : 'not checked',
    signature: 'not checked by this command' };
}

module.exports = { validateFeed, verifyDownloaded, readLimited, checkFeed };
if (require.main === module) {
  if (process.argv.slice(2).some(arg => arg !== '--deep')) throw new Error('Usage: check-feed.cjs [--deep]');
  checkFeed(process.argv.includes('--deep'), { releaseTag: process.env.BMD_RELEASE_TAG || null }).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
