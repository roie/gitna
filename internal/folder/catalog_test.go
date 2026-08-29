package folder

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCatalogPersistsBoundedRecentFolders(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "config", "folders.json")
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

func TestCatalogDeferredRecordIsImmediateAndOrderedWithRemove(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "folders.json")
	opened := filepath.Join(root, "opened")
	if err := os.Mkdir(opened, 0o755); err != nil {
		t.Fatal(err)
	}
	catalog := Open(statePath, 5)
	catalog.RecordDeferred(opened, true)
	if recent := catalog.Recent(); len(recent) != 1 || recent[0].Path != opened {
		t.Fatalf("deferred recent = %#v", recent)
	}
	if err := catalog.Remove(opened); err != nil {
		t.Fatal(err)
	}
	catalog.Flush()
	if recent := Open(statePath, 5).Recent(); len(recent) != 0 {
		t.Fatalf("deferred record overwrote remove: %#v", recent)
	}
}

func TestCatalogRemovePersistsAndReopenRestoresEntry(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "config", "folders.json")
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "second")
	for _, path := range []string{first, second} {
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	catalog := Open(statePath, 5)
	catalog.Record(first, true)
	catalog.Record(second, false)
	if err := catalog.Remove(first); err != nil {
		t.Fatal(err)
	}
	if recent := catalog.Recent(); len(recent) != 1 || recent[0].Path != second {
		t.Fatalf("recent after remove = %#v", recent)
	}
	if recent := Open(statePath, 5).Recent(); len(recent) != 1 || recent[0].Path != second {
		t.Fatalf("persisted recent = %#v", recent)
	}

	catalog.Record(first, true)
	if recent := catalog.Recent(); len(recent) != 2 || recent[0].Path != first {
		t.Fatalf("recent after reopen = %#v", recent)
	}
}

func TestCatalogRemoveUsesCanonicalAliasAndAllowsMissingFolder(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	alias := filepath.Join(root, "alias")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	catalog := Open("", 5)
	catalog.Record(alias, true)
	if err := catalog.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Recent()) != 0 {
		t.Fatalf("recent after alias remove = %#v", catalog.Recent())
	}

	catalog.Record(target, true)
	if err := os.RemoveAll(target); err != nil {
		t.Fatal(err)
	}
	if err := catalog.Remove(target); err != nil {
		t.Fatal(err)
	}
	if len(catalog.Recent()) != 0 {
		t.Fatalf("recent after missing remove = %#v", catalog.Recent())
	}
}

func TestCatalogRemoveRollsBackWhenPersistenceFails(t *testing.T) {
	root := t.TempDir()
	folder := filepath.Join(root, "folder")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	catalog := Open("", 5)
	catalog.Record(folder, true)
	catalog.path = root // Atomic replacement cannot rename a file over this directory.
	if err := catalog.Remove(folder); err == nil {
		t.Fatal("expected persistence error")
	}
	if recent := catalog.Recent(); len(recent) != 1 || recent[0].Path != folder {
		t.Fatalf("recent after failed remove = %#v", recent)
	}
}

func TestPathKeyNormalizesWindowsPathCase(t *testing.T) {
	upper := pathKeyForOS(`C:\Users\Roie\Repo`, "windows")
	lower := pathKeyForOS(`c:\users\roie\repo`, "windows")
	if upper != lower {
		t.Fatalf("Windows path keys differ: %q != %q", upper, lower)
	}
	if got := pathKeyForOS("/Users/Roie/Repo", "linux"); got == pathKeyForOS("/users/roie/repo", "linux") {
		t.Fatalf("Linux path keys unexpectedly ignore case: %q", got)
	}
}

func TestCatalogIgnoresMalformedAndInvalidEntries(t *testing.T) {
	root := t.TempDir()
	statePath := filepath.Join(root, "folders.json")
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
		t.Fatal("expected missing folder error")
	}
	if len(catalog.Recent()) != 0 {
		t.Fatalf("recent after missing path = %#v", catalog.Recent())
	}
}
