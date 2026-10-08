package browser

import (
	"fmt"
	"os"
	"os/exec"
	pathpkg "path"
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
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("browser: inspect reveal path: %w", err)
	}
	isDirectory := info.IsDir()
	return revealFor(goos, wsl, path, isDirectory)
}

func revealFor(goos string, wsl bool, path string, isDirectory bool) error {
	if goos == "linux" && wsl {
		converted, err := commandOutput("wslpath", "-w", path)
		if err != nil {
			return fmt.Errorf("browser: convert WSL path: %w", err)
		}
		convertedPath := strings.TrimSpace(string(converted))
		if !isDirectory {
			return startCommand("explorer.exe", "/select,"+convertedPath)
		}
		return startCommand("explorer.exe", convertedPath)
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
		if !isDirectory {
			return []string{"explorer.exe", "/select," + path}, nil
		}
		return []string{"explorer.exe", path}, nil
	case "linux":
		if !isDirectory {
			path = pathpkg.Dir(path)
		}
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
