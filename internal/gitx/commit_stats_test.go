package gitx

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestParseNumstatCountsTextBinaryAndRenameRecords(t *testing.T) {
	raw := []byte("12\t3\tsrc/main.go\x00-\t-\timage.png\x000\t0\t\x00old.txt\x00new.txt\x00")
	got, err := ParseNumstat(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := protocol.CommitStats{Files: 3, Additions: 12, Deletions: 3, BinaryFiles: 1}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stats = %#v, want %#v", got, want)
	}
}

func TestCommitDetailsUsesFirstParentForMergeStats(t *testing.T) {
	root := buildHistoryFixture(t)
	repo, runner := historyDiscover(t, root)
	oid := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))

	details, err := repo.CommitDetails(context.Background(), runner, oid)
	if err != nil {
		t.Fatal(err)
	}
	if details.Stats.Files != 1 || details.Stats.Additions != 1 || details.Stats.Deletions != 0 {
		t.Fatalf("stats = %#v", details.Stats)
	}
	if len(details.Files) != 1 || details.Files[0].Path != "f.txt" {
		t.Fatalf("files = %#v", details.Files)
	}
}

func TestParseNumstatRejectsMalformedInput(t *testing.T) {
	if _, err := ParseNumstat([]byte("1\t2\tmissing-nul")); err == nil {
		t.Fatal("expected malformed record error")
	}
}
