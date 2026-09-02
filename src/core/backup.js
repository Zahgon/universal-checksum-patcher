// Port of internal/core/backup.go

import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { newFile } from '../internal/gope.js';
import { CoreError } from './pattern.js';
import { bytesEqual } from './patch.js';
import { isNotExist, wrapFsError } from '../internal/goerrors.js';

// ErrChangedOnDisk means the target file was modified between reading and
// writing; we abort rather than risk corrupting it.
export const ErrChangedOnDisk = new CoreError('file changed on disk since it was read');
Object.freeze(ErrChangedOnDisk);

function readFileBytes(path) {
  return new Uint8Array(readFileSync(path));
}

// backupIfAbsent writes pristine to path+".backup" only if no backup exists.
// staleWarning is set when a pre-existing backup differs from pristine.
export function backupIfAbsent(path, pristine) {
  const backup = `${path}.backup`;
  let existing = null;
  try {
    existing = readFileBytes(backup);
  } catch (err) {
    if (!isNotExist(err)) {
      throw new CoreError(`read backup: ${wrapFsError(err, backup)}`, err);
    }
  }
  if (existing !== null) {
    return { created: false, staleWarning: !bytesEqual(existing, pristine) };
  }
  try {
    writeFileAtomic(backup, pristine);
  } catch (err) {
    throw new CoreError(`write backup: ${wrapFsError(err, backup)}`, err);
  }
  return { created: true, staleWarning: false };
}

// restoreFromBackup copies path+".backup" back over path, refusing a backup that
// is not a valid PE so a corrupt backup cannot brick the game exe.
export function restoreFromBackup(path) {
  const backup = `${path}.backup`;
  let data;
  try {
    data = readFileBytes(backup);
  } catch (err) {
    if (isNotExist(err)) {
      throw new CoreError(`no backup found (${basename(backup)})`, err);
    }
    throw new CoreError(`read backup: ${wrapFsError(err, backup)}`, err);
  }
  try {
    newFile(data);
  } catch {
    throw new CoreError(
      `backup ${basename(backup)} is not a valid executable — refusing to restore`,
    );
  }
  writeFileAtomic(path, data);
}

// writePatched writes atomically, but only after confirming the file on disk
// still byte-equals the pristine bytes we opened.
export function writePatched(path, expectedCurrent, patched) {
  let cur;
  try {
    cur = readFileBytes(path);
  } catch (err) {
    throw new CoreError(`re-read before write: ${wrapFsError(err, path)}`, err);
  }
  if (!bytesEqual(cur, expectedCurrent)) throw ErrChangedOnDisk;
  writeFileAtomic(path, patched);
}

// writeFileAtomic writes via a temp file in the same directory then renames, so
// a crash mid-write cannot leave a truncated executable.
export function writeFileAtomic(path, data) {
  const dir = dirname(path);
  // os.CreateTemp(dir, ".ucp-*.tmp") creates the file inside dir itself, which
  // is what keeps the rename below atomic (same filesystem). It also retries on
  // name collision, hence the loop.
  let fd = -1;
  let tmpName = '';
  // os.CreateTemp gives up after 10000 collisions rather than retrying forever.
  for (let attempt = 0; ; attempt++) {
    tmpName = join(dir, `.ucp-${randomSuffix()}.tmp`);
    try {
      fd = openSync(tmpName, 'wx', 0o600);
      break;
    } catch (err) {
      if (err.code === 'EEXIST' && attempt < 10000) continue;
      throw err;
    }
  }
  let renamed = false;
  try {
    try {
      // os.File.Write reports io.ErrShortWrite when the syscall accepts fewer
      // bytes than requested. fs.writeSync reports the same situation only
      // through its return value — under a filesystem limit it returns a short
      // count with NO error, so an unchecked call would rename a truncated file
      // over the target executable and destroy it.
      const written = writeSync(fd, data);
      if (written !== data.length) throw new CoreError('short write');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpName, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmpName);
      } catch {
        // Go's `defer os.Remove(tmpName)` discards its error identically.
      }
    }
  }
}

function randomSuffix() {
  return Math.floor(Math.random() * 0x100000000).toString(10).padStart(10, '0');
}
