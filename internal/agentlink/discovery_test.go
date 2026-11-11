package agentlink

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPublishIsPrivateAndListSkipsJunk(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "agents")
	remove, err := Publish(dir, Endpoint{PID: 42, URL: "http://127.0.0.1:1", Token: "secret", Version: "v"})
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{dir: 0o700, filepath.Join(dir, "42.json"): 0o600} {
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != want {
				t.Errorf("%s mode = %v, want %v", path, info.Mode().Perm(), want)
			}
		}
	}
	os.WriteFile(filepath.Join(dir, "1.json.tmp"), []byte(`{"url":"x","token":"t"}`), 0o600)
	os.WriteFile(filepath.Join(dir, "2.json"), []byte(`{not json`), 0o600)
	os.WriteFile(filepath.Join(dir, "3.json"), []byte(`{"url":"http://x"}`), 0o600)

	endpoints, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(endpoints) != 1 || endpoints[0].PID != 42 || endpoints[0].Token != "secret" {
		t.Fatalf("endpoints = %+v", endpoints)
	}
	remove()
	if endpoints, _ := List(dir); len(endpoints) != 0 {
		t.Fatalf("after remove = %+v", endpoints)
	}
}

func TestListWithoutDirectory(t *testing.T) {
	endpoints, err := List(filepath.Join(t.TempDir(), "missing"))
	if err != nil || endpoints != nil {
		t.Fatalf("List = %v, %v", endpoints, err)
	}
}

func TestPublishTightensAnExistingDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions")
	}
	dir := filepath.Join(t.TempDir(), "agents")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(dir, Endpoint{PID: 1, URL: "u", Token: "t"}); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(dir); info.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %v", info.Mode().Perm())
	}
}
