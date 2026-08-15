// Package browser opens the user's default browser to the local session.
package browser

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Open launches the default browser on the local machine pointing at url.
// Errors are returned so callers can log them while keeping the server running.
func Open(url string) error {
	switch {
	case runtime.GOOS == "windows":
		// rundll32 url.dll,FileProtocolHandler <url> is the documented way to
		// open a URL in the default Windows browser without a GUI framework.
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case isWSL():
		// Inside WSL, launch the Windows browser through interop. cmd.exe /c
		// start handles URLs, spaces, and metacharacters without a shell
		// string being interpreted by /bin/sh.
		return exec.Command("cmd.exe", "/c", "start", "", url).Start()
	case runtime.GOOS == "linux":
		return exec.Command("xdg-open", url).Start()
	default:
		return fmt.Errorf("browser: unsupported platform %q", runtime.GOOS)
	}
}

func isWSL() bool {
	if os.Getenv("WSL_INTEROP") != "" {
		return true
	}
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(data)), "microsoft")
}
