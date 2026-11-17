//go:build windows

package filelock

import (
	"os"

	"golang.org/x/sys/windows"
)

// The locked byte lies far past any real content so the lock never blocks
// ordinary reads of the data.
const lockOffsetHigh = 0x7fff0000

// Lock blocks until f holds an exclusive lock. The lock belongs to the open
// file, so a second open of the same path conflicts even in one process.
func Lock(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, lockRange())
}

// Unlock releases the lock taken by Lock. Closing f releases it too.
func Unlock(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, lockRange())
}

func lockRange() *windows.Overlapped {
	return &windows.Overlapped{OffsetHigh: lockOffsetHigh}
}
