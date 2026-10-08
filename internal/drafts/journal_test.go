package drafts

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func testRecord(revision uint64, contents string) Record {
	return Record{
		DocumentID: "document-1",
		ClientID:   "client-1",
		Label:      "Untitled-1",
		Revision:   revision,
		Contents:   contents,
	}
}

func TestJournalPutGetAndRevisionChecks(t *testing.T) {
	journal, err := Open(t.TempDir(), Options{Now: func() time.Time { return time.Unix(10, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.Put(testRecord(1, "draft")); err != nil {
		t.Fatal(err)
	}
	record, err := journal.Get("document-1")
	if err != nil {
		t.Fatal(err)
	}
	if record.Schema != SchemaVersion || record.Contents != "draft" || record.UpdatedAt != time.Unix(10, 0).UTC() {
		t.Fatalf("record = %#v", record)
	}
	if err := journal.Put(testRecord(1, "draft")); err != nil {
		t.Fatalf("idempotent put: %v", err)
	}
	if err := journal.Put(testRecord(1, "changed")); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("same revision error = %v, want ErrStaleRevision", err)
	}
	if err := journal.Put(testRecord(0, "older")); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("older revision error = %v, want ErrStaleRevision", err)
	}
	if err := journal.Delete("document-1", 0); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("stale delete error = %v, want ErrStaleRevision", err)
	}
	if err := journal.Delete("document-1", 1); err != nil {
		t.Fatal(err)
	}
}

func TestJournalPersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Put(testRecord(4, "survives restart")); err != nil {
		t.Fatal(err)
	}
	second, err := Open(dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	record, err := second.Get("document-1")
	if err != nil {
		t.Fatal(err)
	}
	if record.Revision != 4 || record.Contents != "survives restart" {
		t.Fatalf("reopened record = %#v", record)
	}
}

func TestJournalBoundsContentAndRecords(t *testing.T) {
	journal, err := Open(t.TempDir(), Options{MaxContent: 4, MaxRecords: 1, MaxTotalSize: 256})
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.Put(testRecord(1, "12345")); !errors.Is(err, ErrQuota) {
		t.Fatalf("large content error = %v, want ErrQuota", err)
	}
	if err := journal.Put(testRecord(1, "ok")); err != nil {
		t.Fatal(err)
	}
	second := testRecord(1, "ok")
	second.DocumentID = "document-2"
	if err := journal.Put(second); !errors.Is(err, ErrQuota) {
		t.Fatalf("record quota error = %v, want ErrQuota", err)
	}
}

func TestJournalUsesRestrictedAtomicRecords(t *testing.T) {
	dir := t.TempDir()
	journal, err := Open(filepath.Join(dir, "drafts"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.Put(testRecord(1, "private")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "drafts"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("directory permissions = %o, want 700", info.Mode().Perm())
	}
	fileInfo, err := os.Stat(filepath.Join(dir, "drafts", "document-1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fileInfo.Mode().Perm() != 0o600 {
		t.Fatalf("file permissions = %o, want 600", fileInfo.Mode().Perm())
	}
}
