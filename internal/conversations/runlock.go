package conversations

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/roie/gitna/internal/filelock"
)

func (s *Store) LockRuns() (unlock func(), held bool, err error) {
	f, err := os.OpenFile(filepath.Join(s.dir, "runs.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	held, err = filelock.TryLock(f)
	if err != nil || !held {
		f.Close()
		return nil, false, err
	}
	return func() { f.Close() }, true, nil
}
