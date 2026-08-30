// Package browser opens the user's default browser to the local session.
package browser

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

var startCommand = func(name string, args ...string) error {
	return exec.Command(name, args...).Start()
}

// Open launches the default browser on the local machine pointing at url.
// Errors are returned so callers can log them while keeping the server running.
func Open(url string) error {
	return openFor(runtime.GOOS, runtime.GOOS == "linux" && isWSL(), url)
}

func openFor(goos string, wsl bool, url string) error {
	command, err := openCommandFor(goos, wsl, url)
	if err != nil {
		return err
	}
	return startCommand(command[0], command[1:]...)
}

func openCommandFor(goos string, wsl bool, url string) ([]string, error) {
	if goos == "linux" && wsl {
		// Inside WSL, launch the Windows browser through interop. cmd.exe /c
		// start handles URLs, spaces, and metacharacters without a shell
		// string being interpreted by /bin/sh.
		return []string{"cmd.exe", "/c", "start", "", url}, nil
	}
	switch goos {
	case "windows":
		// rundll32 url.dll,FileProtocolHandler <url> is the documented way to
		// open a URL in the default Windows browser without a GUI framework.
		return []string{"rundll32", "url.dll,FileProtocolHandler", url}, nil
	case "linux":
		return []string{"xdg-open", url}, nil
	case "darwin":
		return []string{"/usr/bin/open", url}, nil
	default:
		return nil, fmt.Errorf("browser: unsupported platform %q", goos)
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
