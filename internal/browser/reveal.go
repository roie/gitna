package browser

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

var commandOutput = func(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).Output()
}

// Reveal opens path in the platform file manager without invoking a shell.
func Reveal(path string) error {
	goos := runtime.GOOS
	wsl := goos == "linux" && isWSL()
	isDirectory := false
	if goos == "darwin" {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("browser: inspect reveal path: %w", err)
		}
		isDirectory = info.IsDir()
	}
	return revealFor(goos, wsl, path, isDirectory)
}

func revealFor(goos string, wsl bool, path string, isDirectory bool) error {
	if goos == "linux" && wsl {
		converted, err := commandOutput("wslpath", "-w", path)
		if err != nil {
			return fmt.Errorf("browser: convert WSL path: %w", err)
		}
		return startCommand("explorer.exe", strings.TrimSpace(string(converted)))
	}
	command, err := revealCommandFor(goos, path, isDirectory)
	if err != nil {
		return err
	}
	return startCommand(command[0], command[1:]...)
}

func revealCommandFor(goos, path string, isDirectory bool) ([]string, error) {
	switch goos {
	case "windows":
		return []string{"explorer.exe", path}, nil
	case "linux":
		return []string{"xdg-open", path}, nil
	case "darwin":
		if isDirectory {
			return []string{"/usr/bin/open", path}, nil
		}
		return []string{"/usr/bin/open", "-R", path}, nil
	default:
		return nil, fmt.Errorf("browser: unsupported platform %q", goos)
	}
}
