package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestSecurityLargeFileBudgets(t *testing.T) {
	content := strings.Repeat("x\r\n", 1000000)
	body, err := json.Marshal(map[string]string{"contents": content})
	if err != nil {
		t.Fatal(err)
	}
	h := (Security{Token: testToken, Host: testHost}).Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			writeMutationDecodeError(w, err)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	for _, scope := range []string{"", "/repo"} {
		for _, route := range []string{"/api/v1/worktree/file", "/api/v1/worktree/entry", "/api/v1/drafts"} {
			for _, chunked := range []bool{false, true} {
				for _, tc := range []struct {
					query  string
					status int
				}{
					{"", http.StatusRequestEntityTooLarge},
					{"?maxBytes=" + strconv.Itoa(len(content)), http.StatusOK},
					{"?maxBytes=0", http.StatusBadRequest},
					{"?maxBytes=9223372036854775807", http.StatusBadRequest},
				} {
					req := httptest.NewRequest(http.MethodPost, CapabilityPath(testToken)+scope+route+tc.query, strings.NewReader(string(body)))
					req.Host = testHost
					req.Header.Set("Origin", "http://"+testHost)
					req.Header.Set("Content-Type", "application/json")
					if chunked {
						req.ContentLength = -1
					}
					rec := httptest.NewRecorder()
					h.ServeHTTP(rec, req)
					if rec.Code != tc.status {
						t.Fatalf("%s%s%s chunked=%t: status %d, want %d: %s", scope, route, tc.query, chunked, rec.Code, tc.status, rec.Body.String())
					}
				}
			}
		}
	}
	req := httptest.NewRequest(http.MethodPost, CapabilityPath(testToken)+"/repo/api/v1/commit?maxBytes=3000000", strings.NewReader(string(body)))
	req.Host = testHost
	req.Header.Set("Origin", "http://"+testHost)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("unrelated route accepted large budget: status %d", rec.Code)
	}
}
