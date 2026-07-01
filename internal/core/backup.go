package core

import (
	"bytes"
	"debug/pe"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ErrChangedOnDisk means the target file was modified between reading and writing
// (e.g. a game update mid-run); we abort rather than risk corrupting it.
var ErrChangedOnDisk = errors.New("file changed on disk since it was read")

// BackupIfAbsent writes pristine to path+".backup" only if no backup exists, so a
// re-run never overwrites a good backup. staleWarning is set when a pre-existing
// backup differs from pristine (an older version's backup — restoring it would
// downgrade the exe).
func BackupIfAbsent(path string, pristine []byte) (created bool, staleWarning bool, err error) {
	backup := path + ".backup"
	if existing, readErr := os.ReadFile(backup); readErr == nil {
		return false, !bytesEqual(existing, pristine), nil // keep existing backup
	} else if !os.IsNotExist(readErr) {
		return false, false, fmt.Errorf("read backup: %w", readErr)
	}
	if err := writeFileAtomic(backup, pristine); err != nil {
		return false, false, fmt.Errorf("write backup: %w", err)
	}
	return true, false, nil
}

// RestoreFromBackup copies path+".backup" back over path (atomically), undoing a
// patch. It refuses to restore a backup that isn't a valid PE executable, so a
// truncated/empty/garbage backup can't brick the game exe.
func RestoreFromBackup(path string) error {
	backup := path + ".backup"
	data, err := os.ReadFile(backup)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no backup found (%s)", filepath.Base(backup))
		}
		return fmt.Errorf("read backup: %w", err)
	}
	if f, perr := pe.NewFile(bytes.NewReader(data)); perr != nil {
		return fmt.Errorf("backup %s is not a valid executable — refusing to restore", filepath.Base(backup))
	} else {
		f.Close()
	}
	return writeFileAtomic(path, data)
}

// WritePatched writes patched to path atomically, but only after confirming the
// file on disk still byte-equals expectedCurrent (the pristine bytes we opened).
// If it changed, returns ErrChangedOnDisk and writes nothing.
func WritePatched(path string, expectedCurrent, patched []byte) error {
	cur, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("re-read before write: %w", err)
	}
	if !bytesEqual(cur, expectedCurrent) {
		return ErrChangedOnDisk
	}
	return writeFileAtomic(path, patched)
}

// writeFileAtomic writes via a temp file in the same directory then renames, so a
// crash mid-write can't leave a truncated executable.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".ucp-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
