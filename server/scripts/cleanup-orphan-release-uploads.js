const db = require('../config/db');
const storage = require('../services/storage.service');

function ageLimitMinutes() {
  const argument = process.argv.find((value) => value.startsWith('--older-than-minutes='));
  return Math.max(10, Number(argument?.split('=')[1] || 30));
}

async function main() {
  if (!storage.useOss()) {
    console.log('OSS is disabled; no release multipart residue to inspect.');
    return;
  }
  const apply = process.argv.includes('--apply');
  const cutoff = Date.now() - ageLimitMinutes() * 60 * 1000;
  const [activeRows] = await db.query(
    `SELECT upload_id FROM desktop_release_upload_sessions
     WHERE status = 'pending' AND expires_at > NOW()`
  );
  const active = new Set(activeRows.map((row) => row.upload_id));
  const uploads = await storage.listIncompleteMultipartUploads('releases/');
  const orphans = uploads.filter((item) => {
    const initiatedAt = new Date(item.initiated || item.initiatedAt || 0).getTime();
    return !active.has(item.uploadId) && initiatedAt > 0 && initiatedAt < cutoff;
  });
  console.log(JSON.stringify({ inspected: uploads.length, active: active.size, orphans: orphans.length, apply }));
  if (!apply) return;
  for (const item of orphans) {
    await storage.abortDirectMultipartUpload({ key: item.name, uploadId: item.uploadId });
    console.log(`aborted orphan multipart upload: ${item.name} ${item.uploadId}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.end());
