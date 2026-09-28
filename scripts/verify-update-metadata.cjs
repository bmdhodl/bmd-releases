'use strict';
// Reused from bmd-desktop/scripts/verify-update-metadata.cjs at 086d512712188c9c465c172e4cf273e8d459e9cc.
// The release-feed caller supplies the directory and version; no private source is fetched in CI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

function verify(directory, version) {
  const metadata = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'));
  if (metadata.version !== version || !metadata.files?.length) throw new Error('Invalid update version/files');
  for (const file of metadata.files) {
    if (path.basename(file.url) !== file.url) throw new Error('Invalid update asset path');
    const data = fs.readFileSync(path.join(directory, file.url));
    const digest = crypto.createHash('sha512').update(data).digest('base64');
    if (file.sha512 !== digest || file.size !== data.length) throw new Error('Update checksum/size mismatch');
    if (metadata.path === file.url && metadata.sha512 !== digest) throw new Error('Legacy update checksum mismatch');
  }
  if (!metadata.files.some(file => file.url === metadata.path)) throw new Error('Missing legacy update asset');
}
module.exports = verify;
