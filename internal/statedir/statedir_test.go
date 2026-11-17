package statedir

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolve(t *testing.T) {
	failed := errors.New("no directory")
	config := func() (string, error) { return filepath.FromSlash("/cfg"), nil }
	cache := func() (string, error) { return filepath.FromSlash("/cache"), nil }
	broken := func() (string, error) { return "", failed }
	root := t.TempDir()
	home := root + string(filepath.Separator) + "x" + string(filepath.Separator) + ".." + string(filepath.Separator) + "gitna"

	tests := []struct {
		name, goos, home string
		config, cache    func() (string, error)
		want             string
		wantErr          string
	}{
		{name: "home wins on linux", goos: "linux", home: home, config: broken, cache: broken, want: filepath.Join(root, "gitna")},
		{name: "home wins on windows", goos: "windows", home: home, config: broken, cache: broken, want: filepath.Join(root, "gitna")},
		{name: "relative home", goos: "linux", home: "relative", config: config, cache: cache, wantErr: "GITNA_HOME"},
		{name: "windows cache", goos: "windows", config: broken, cache: cache, want: filepath.Join(filepath.FromSlash("/cache"), "Gitna")},
		{name: "linux config", goos: "linux", config: config, cache: broken, want: filepath.Join(filepath.FromSlash("/cfg"), "gitna")},
		{name: "darwin config", goos: "darwin", config: config, cache: broken, want: filepath.Join(filepath.FromSlash("/cfg"), "gitna")},
		{name: "config lookup fails", goos: "linux", config: broken, cache: cache, wantErr: failed.Error()},
		{name: "cache lookup fails", goos: "windows", config: config, cache: broken, wantErr: failed.Error()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolve(test.goos, test.home, test.config, test.cache)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("error = %v, want containing %q", err, test.wantErr)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("resolve = %q, %v; want %q", got, err, test.want)
			}
		})
	}
}
