// Public entry point, mirroring what `internal/core` exposes to the two Go
// commands. Go's package is internal; this stays the single import surface.

export { CoreError, parsePattern, parseBytes, findAll, overlay } from './core/pattern.js';
export { Image, openImage, fnKey } from './core/image.js';
export {
  applySite,
  patchImage,
  bytesEqual,
  StatusPatched,
  StatusAlready,
  StatusNoMatch,
  StatusAmbig,
  StatusError,
} from './core/patch.js';
export { loadConfig, embeddedSignatures } from './core/config.js';
export {
  backupIfAbsent,
  restoreFromBackup,
  writePatched,
  writeFileAtomic,
  ErrChangedOnDisk,
} from './core/backup.js';
export { findGates, matchInText, stringsInFunc, cStringAt } from './core/discover.js';
