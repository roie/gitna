//go:build unix

package filelock

import (
	"errors"
	"os"
	"syscall"
)

// Lock blocks until f holds an exclusive lock. The lock belongs to the open
// file, so a second open of the same path conflicts even in one process.
func Lock(f *os.File) error {
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
		if !errors.Is(err, syscall.EINTR) {
			return err
		}
	}
}

// Unlock releases the lock taken by Lock. Closing f releases it too.
func Unlock(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
