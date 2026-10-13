package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/drafts"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
)

type largeFileRepo struct {
	*fakeRepo
	worktreeRepository
}

func TestLargeFileRoutesRequireBudgetAndPreserveContent(t *testing.T) {
	root := t.TempDir()
	content := strings.Repeat("row\r\n", 110000) + "😀END"
	if err := os.WriteFile(filepath.Join(root, "large.txt"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	h := newSnapshotServer(&largeFileRepo{fakeRepo: &fakeRepo{}, worktreeRepository: gitx.Repository{Root: root}})
	blocked := worktreeRequest(t, h, http.MethodGet, "/worktree/file?path=large.txt", "")
	var warning struct {
		SizeBytes int
		Code      string
	}
	if err := json.Unmarshal(blocked.Body.Bytes(), &warning); err != nil {
		t.Fatal(err)
	}
	if blocked.Code != http.StatusRequestEntityTooLarge || warning.Code != "file-too-large" || warning.SizeBytes != len(content) {
		t.Fatalf("warning = %d %s", blocked.Code, blocked.Body.String())
	}
	budget := strconv.Itoa(len(content) + 10)
	read := worktreeRequest(t, h, http.MethodGet, "/worktree/file?path=large.txt&maxBytes="+budget, "")
	var loaded protocol.WorktreeFile
	if err := json.Unmarshal(read.Body.Bytes(), &loaded); err != nil {
		t.Fatal(err)
	}
	if read.Code != http.StatusOK || loaded.Content != content {
		t.Fatalf("approved read = %d", read.Code)
	}
	body, _ := json.Marshal(worktreeFileRequest{Path: "large.txt", Content: content + "Z", ExpectedHash: loaded.Hash})
	saved := worktreeRequest(t, h, http.MethodPut, "/worktree/file?maxBytes="+budget, string(body))
	if saved.Code != http.StatusOK {
		t.Fatalf("save = %d %s", saved.Code, saved.Body.String())
	}
	data, _ := os.ReadFile(filepath.Join(root, "large.txt"))
	if string(data) != content+"Z" {
		t.Fatal("save changed bytes")
	}
	stale := worktreeRequest(t, h, http.MethodPut, "/worktree/file?maxBytes="+budget, string(body))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale save = %d", stale.Code)
	}
	for _, invalid := range []string{"0", "-1", "no", "9223372036854775807"} {
		for _, method := range []string{http.MethodGet, http.MethodPut} {
			result := worktreeRequest(t, h, method, "/worktree/file?path=large.txt&maxBytes="+invalid, string(body))
			if result.Code != http.StatusBadRequest {
				t.Fatalf("%s budget %s = %d", method, invalid, result.Code)
			}
		}
	}
}

func TestLargeDraftRoutesKeepExplicitBudgetThroughRecovery(t *testing.T) {
	journal, err := drafts.Open(t.TempDir(), drafts.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(newTestFS(), Options{Version: "test", Token: testToken, Host: testHost, Drafts: journal})
	if err != nil {
		t.Fatal(err)
	}
	record := drafts.Record{DocumentID: "large", ClientID: "client", Label: "large.txt", Revision: 1,
		Contents: strings.Repeat("row\r\n", 110000) + "😀", BaselineHash: "baseline"}
	body, _ := json.Marshal(record)
	blocked := worktreeRequest(t, srv.Handler(), http.MethodPost, "/drafts", string(body))
	if blocked.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("default draft = %d %s", blocked.Code, blocked.Body.String())
	}
	record.MaxBytes = int64(len(record.Contents))
	body, _ = json.Marshal(record)
	unapproved := worktreeRequest(t, srv.Handler(), http.MethodPost, "/drafts", string(body))
	if unapproved.Code != http.StatusBadRequest {
		t.Fatalf("unapproved draft = %d", unapproved.Code)
	}
	accepted := worktreeRequest(t, srv.Handler(), http.MethodPost, "/drafts?maxBytes="+strconv.Itoa(len(record.Contents)), string(body))
	if accepted.Code != http.StatusOK {
		t.Fatalf("approved draft = %d %s", accepted.Code, accepted.Body.String())
	}
	recovered, err := journal.Get("large")
	if err != nil || recovered.Contents != record.Contents || recovered.MaxBytes != record.MaxBytes || recovered.BaselineHash != record.BaselineHash {
		t.Fatalf("recovery: %v", err)
	}
}
