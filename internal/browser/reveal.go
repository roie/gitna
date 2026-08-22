package browser

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// Reveal opens path in the platform file manager without invoking a shell.
func Reveal(path string) error {
	switch {
	case runtime.GOOS == "windows":
		return exec.Command("explorer.exe", path).Start()
	case isWSL():
		converted, err := exec.Command("wslpath", "-w", path).Output()
		if err != nil {
			return fmt.Errorf("browser: convert WSL path: %w", err)
		}
		return exec.Command("explorer.exe", strings.TrimSpace(string(converted))).Start()
	case runtime.GOOS == "linux":
		return exec.Command("xdg-open", path).Start()
	case runtime.GOOS == "darwin":
		return exec.Command("open", path).Start()
	default:
		return fmt.Errorf("browser: unsupported platform %q", runtime.GOOS)
	}
}
