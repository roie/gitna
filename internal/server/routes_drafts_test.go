package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/roie/gitna/internal/drafts"
)

func TestDraftRoutesPersistAndRejectStaleRevisions(t *testing.T) {
	journal, err := drafts.Open(t.TempDir(), drafts.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(newTestFS(), Options{
		Version: "test-version",
		Token:   testToken,
		Host:    testHost,
		Drafts:  journal,
	})
	if err != nil {
		t.Fatal(err)
	}
	record := drafts.Record{
		DocumentID: "document-route",
		ClientID:   "client-route",
		Label:      "Untitled-1",
		Revision:   2,
		Contents:   "draft",
		UpdatedAt:  time.Now(),
	}
	body, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	created := worktreeRequest(t, srv.Handler(), http.MethodPost, "/drafts", string(body))
	if created.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	stale := worktreeRequest(t, srv.Handler(), http.MethodDelete, "/drafts?documentId=document-route&revision=1", "")
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale delete status = %d, body = %s", stale.Code, stale.Body.String())
	}
	listed := worktreeRequest(t, srv.Handler(), http.MethodGet, "/drafts", "")
	if listed.Code != http.StatusOK || !containsDraft(listed.Body.Bytes(), "document-route") {
		t.Fatalf("list status = %d, body = %s", listed.Code, listed.Body.String())
	}
}

func TestDraftRoutesDeleteMissingRecordReturnsNotFound(t *testing.T) {
	journal, err := drafts.Open(t.TempDir(), drafts.Options{})
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(newTestFS(), Options{
		Version: "test-version",
		Token:   testToken,
		Host:    testHost,
		Drafts:  journal,
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := worktreeRequest(t, srv.Handler(), http.MethodDelete, "/drafts?documentId=missing-document&revision=1", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestDraftRoutesScopeRecordsToFolder(t *testing.T) {
	journal, err := drafts.Open(t.TempDir(), drafts.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := journal.Put(drafts.Record{
		DocumentID: "document-other",
		ClientID:   "client-other",
		FolderKey:  "/other",
		Label:      "Untitled-1",
		Revision:   1,
		Contents:   "private",
	}); err != nil {
		t.Fatal(err)
	}
	srv, err := New(newTestFS(), Options{
		Version:        "test-version",
		Token:          testToken,
		Host:           testHost,
		Drafts:         journal,
		DraftFolderKey: "/current",
	})
	if err != nil {
		t.Fatal(err)
	}
	listed := worktreeRequest(t, srv.Handler(), http.MethodGet, "/drafts", "")
	if listed.Code != http.StatusOK || containsDraft(listed.Body.Bytes(), "document-other") {
		t.Fatalf("scoped list status = %d, body = %s", listed.Code, listed.Body.String())
	}
	body := `{"schema":1,"documentId":"document-new","clientId":"client-new","folderKey":"/other","label":"Untitled-2","revision":1,"contents":"blocked"}`
	created := worktreeRequest(t, srv.Handler(), http.MethodPost, "/drafts", body)
	if created.Code != http.StatusForbidden {
		t.Fatalf("cross-folder create status = %d, body = %s", created.Code, created.Body.String())
	}
}

func containsDraft(data []byte, documentID string) bool {
	var records []drafts.Record
	if err := json.Unmarshal(data, &records); err != nil {
		return false
	}
	for _, record := range records {
		if record.DocumentID == documentID {
			return true
		}
	}
	return false
}
