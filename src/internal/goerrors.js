// Renders Node fs errors in Go's *fs.PathError text, and reproduces the
// errors.Is(err, os.ErrPermission) predicate.

const ERRNO_TEXT = new Map([
  ['ENOENT', 'no such file or directory'],
  ['EISDIR', 'is a directory'],
  ['ENOTDIR', 'not a directory'],
  ['EACCES', 'permission denied'],
  ['EPERM', 'operation not permitted'],
  ['EEXIST', 'file exists'],
  ['EBUSY', 'device or resource busy'],
  ['EROFS', 'read-only file system'],
  ['ENOSPC', 'no space left on device'],
  ['EMFILE', 'too many open files'],
  ['ENAMETOOLONG', 'file name too long'],
  ['EXDEV', 'invalid cross-device link'],
  ['ENOTEMPTY', 'directory not empty'],
]);

// wrapFsError renders `<op> <path>: <errno text>`. Node omits `path` on some
// errors (notably EISDIR from readFileSync), so the caller supplies it.
export function wrapFsError(err, path) {
  if (err === null || err === undefined || typeof err.code !== 'string') {
    return String(err && err.message ? err.message : err);
  }
  const op = err.syscall ?? 'open';
  const p = err.path ?? path ?? '';
  const text = ERRNO_TEXT.get(err.code) ?? err.code.toLowerCase();
  return `${op} ${p}: ${text}`;
}

export function isPermission(err) {
  for (let e = err; e !== null && e !== undefined; e = e.cause) {
    if (e.code === 'EACCES' || e.code === 'EPERM') return true;
  }
  return false;
}

export function isNotExist(err) {
  for (let e = err; e !== null && e !== undefined; e = e.cause) {
    if (e.code === 'ENOENT') return true;
  }
  return false;
}
