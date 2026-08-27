package workspace

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCatalogPersistsBoundedRecentWorkspaces(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "config", "workspaces.json")
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "second")
	third := filepath.Join(root, "third")
	for _, path := range []string{first, second, third} {
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	catalog := Open(statePath, 2)
	now := time.Date(2026, time.August, 27, 12, 0, 0, 0, time.UTC)
	catalog.now = func() time.Time {
		now = now.Add(time.Minute)
		return now
	}
	catalog.Record(first, true)
	catalog.Record(second, true)
	catalog.Record(first, true)
	catalog.Record(third, false)
	if err := catalog.LastError(); err != nil {
		t.Fatal(err)
	}

	recent := catalog.Recent()
	if len(recent) != 2 || recent[0].Path != third || recent[1].Path != first {
		t.Fatalf("recent = %#v", recent)
	}
	if recent[0].Repository || !recent[1].Repository {
		t.Fatalf("repository flags = %#v", recent)
	}

	reloaded := Open(statePath, 2)
	if err := reloaded.LastError(); err != nil {
		t.Fatal(err)
	}
	recent = reloaded.Recent()
	if len(recent) != 2 || recent[0].Path != third || recent[1].Path != first {
		t.Fatalf("reloaded recent = %#v", recent)
	}
	info, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
}

func TestCatalogIgnoresMalformedAndInvalidEntries(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "workspaces.json")
	if err := os.WriteFile(statePath, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := Open(statePath, 5)
	if catalog.LastError() == nil {
		t.Fatal("expected malformed catalog error")
	}
	if len(catalog.Recent()) != 0 {
		t.Fatalf("recent = %#v", catalog.Recent())
	}

	catalog.Record(filepath.Join(root, "missing"), true)
	if catalog.LastError() == nil {
		t.Fatal("expected missing workspace error")
	}
	if len(catalog.Recent()) != 0 {
		t.Fatalf("recent after missing path = %#v", catalog.Recent())
	}
}
