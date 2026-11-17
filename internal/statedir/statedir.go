// Package statedir locates the one directory that holds Gitna's local state.
package statedir

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Dir returns the state directory without creating it. GITNA_HOME overrides
// the platform location and must be an absolute path.
func Dir() (string, error) {
	return resolve(runtime.GOOS, os.Getenv("GITNA_HOME"), os.UserConfigDir, os.UserCacheDir)
}

func resolve(goos, home string, userConfigDir, userCacheDir func() (string, error)) (string, error) {
	if home != "" {
		if !filepath.IsAbs(home) {
			return "", fmt.Errorf("statedir: GITNA_HOME must be an absolute path: %q", home)
		}
		return filepath.Clean(home), nil
	}
	if goos == "windows" {
		cache, err := userCacheDir()
		if err != nil {
			return "", fmt.Errorf("statedir: %w", err)
		}
		return filepath.Join(cache, "Gitna"), nil
	}
	config, err := userConfigDir()
	if err != nil {
		return "", fmt.Errorf("statedir: %w", err)
	}
	return filepath.Join(config, "gitna"), nil
}
