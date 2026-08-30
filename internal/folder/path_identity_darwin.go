//go:build darwin

package folder

import (
	"bytes"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// platformPathIdentity asks the Darwin kernel for the filesystem's canonical
// spelling. This folds case aliases on the default case-insensitive APFS while
// preserving distinct paths on case-sensitive volumes.
func platformPathIdentity(path string) (string, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer file.Close()

	buffer := make([]byte, 1024) // PATH_MAX on Darwin.
	_, _, errno := syscall.Syscall(
		syscall.SYS_FCNTL,
		file.Fd(),
		uintptr(syscall.F_GETPATH),
		uintptr(unsafe.Pointer(&buffer[0])),
	)
	if errno != 0 {
		return "", false
	}
	if end := bytes.IndexByte(buffer, 0); end >= 0 {
		buffer = buffer[:end]
	}
	if len(buffer) == 0 {
		return "", false
	}
	return filepath.Clean(string(buffer)), true
}
