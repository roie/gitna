//go:build !windows

package gitx

import "syscall"

// Avoid blocking if a regular file is replaced with a FIFO before open.
const mediaNonblock = syscall.O_NONBLOCK
