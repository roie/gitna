package server

import (
	"bytes"
	"context"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/gitx"
)

type mediaTestRepo struct {
	*fakeRepo
	disk gitx.Repository
}

func (r *mediaTestRepo) OpenWorktreeMedia(ctx context.Context, path string) (*os.File, error) {
	return r.disk.OpenWorktreeMedia(ctx, path)
}

type cancellingMediaResponse struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (w cancellingMediaResponse) Write(data []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(data)
	w.cancel()
	return n, err
}

func TestMediaStreamStopsAfterCancellation(t *testing.T) {
	root := t.TempDir()
	data := append([]byte("RIFF\x00\x00\x00\x00WAVE"), make([]byte, 1<<20)...)
	if err := os.WriteFile(filepath.Join(root, "sample.wav"), data, 0600); err != nil {
		t.Fatal(err)
	}
	h := newSnapshotServer(&mediaTestRepo{fakeRepo: &fakeRepo{}, disk: gitx.Repository{Root: root}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", "/g/"+testToken+"/api/v1/media?path=sample.wav", nil).WithContext(ctx)
	req.Host = testHost
	rec := httptest.NewRecorder()
	h.ServeHTTP(cancellingMediaResponse{rec, cancel}, req)
	if rec.Code != 200 || rec.Body.Len() == 0 || rec.Body.Len() >= len(data) {
		t.Fatalf("cancelled stream delivered %d/%d bytes (status %d)", rec.Body.Len(), len(data), rec.Code)
	}
}

func TestMediaStreamingAndSecurity(t *testing.T) {
	root := t.TempDir()
	wav := append([]byte("RIFF\x24\x04\x00\x00WAVE"), bytes.Repeat([]byte{0}, 1024)...)
	if err := os.WriteFile(filepath.Join(root, "sample.wav"), wav, 0600); err != nil {
		t.Fatal(err)
	}
	h := newSnapshotServer(&mediaTestRepo{fakeRepo: &fakeRepo{}, disk: gitx.Repository{Root: root}})
	request := func(method, path, byteRange string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "/g/"+testToken+"/api/v1/media?path="+url.QueryEscape(path), nil)
		req.Host = testHost
		if byteRange != "" {
			req.Header.Set("Range", byteRange)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	for _, tt := range []struct {
		name, method, byteRange string
		status                  int
		body                    []byte
		contentRange            string
	}{
		{"full", "GET", "", 200, wav, ""},
		{"head", "HEAD", "", 200, nil, ""},
		{"prefix", "GET", "bytes=0-15", 206, wav[:16], "bytes 0-15/1036"},
		{"suffix", "GET", "bytes=-8", 206, wav[len(wav)-8:], "bytes 1028-1035/1036"},
		{"open-ended", "GET", "bytes=1028-", 206, wav[1028:], "bytes 1028-1035/1036"},
		{"unsatisfiable", "GET", "bytes=5000-", 416, nil, "bytes */1036"},
		{"descending", "GET", "bytes=20-10", 416, nil, ""},
		{"multipart", "GET", "bytes=0-1,4-5", 416, nil, "bytes */1036"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := request(tt.method, "sample.wav", tt.byteRange)
			if rec.Code != tt.status {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body)
			}
			if tt.status < 400 && !bytes.Equal(rec.Body.Bytes(), tt.body) {
				t.Fatalf("unexpected body length=%d", rec.Body.Len())
			}
			if rec.Header().Get("Content-Range") != tt.contentRange {
				t.Fatalf("range=%s", rec.Header().Get("Content-Range"))
			}
			for key, want := range map[string]string{"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer"} {
				if rec.Header().Get(key) != want {
					t.Errorf("%s=%q", key, rec.Header().Get(key))
				}
			}
			if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox;") {
				t.Fatal("missing sandbox")
			}
			if tt.status < 400 && rec.Header().Get("Content-Type") != "audio/wav" {
				t.Fatal(rec.Header())
			}
		})
	}
	for _, path := range []string{"../escape.wav", ".git/config.wav", "missing.wav"} {
		if rec := request("GET", path, ""); rec.Code < 400 {
			t.Fatalf("served %q", path)
		}
	}
	for _, tt := range []struct{ path, body string }{
		{"fake.mp4", "<html><script>parent.document.title='owned'</script></html>"},
		{"fake.wav", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"},
		{"fake.webm", "not media"},
		{"script.html", "<script>alert(1)</script>"},
	} {
		if err := os.WriteFile(filepath.Join(root, tt.path), []byte(tt.body), 0600); err != nil {
			t.Fatal(err)
		}
		if rec := request("GET", tt.path, ""); rec.Code != 415 {
			t.Fatalf("%s: status=%d", tt.path, rec.Code)
		}
	}
	for _, path := range []string{"/api/v1/media?path=sample.wav", "/g/wrong/api/v1/media?path=sample.wav"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Host = testHost
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 404 {
			t.Fatalf("missing capability: %d", rec.Code)
		}
	}
	req := httptest.NewRequest("GET", "/g/"+testToken+"/api/v1/media?path=sample.wav", nil)
	req.Host = "attacker.example"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("bad host: %d", rec.Code)
	}
}

func TestMediaDownloadsNeverBecomeActiveDocuments(t *testing.T) {
	root := t.TempDir()
	h := newSnapshotServer(&mediaTestRepo{fakeRepo: &fakeRepo{}, disk: gitx.Repository{Root: root}})
	for _, tt := range []struct{ path, body, query string }{
		{"actions.pdf", "%PDF-1.4\n/OpenAction << /S /JavaScript /JS (app.alert('no')) >>", ""},
		{"not-a-pdf.pdf", "<script>parent.document.title='owned'</script>", ""},
		{"unsupported.mp4", "<html>not playable</html>", "&download=1"},
	} {
		if err := os.WriteFile(filepath.Join(root, tt.path), []byte(tt.body), 0600); err != nil {
			t.Fatal(err)
		}
		rec := worktreeRequest(t, h, "GET", "/media?path="+url.QueryEscape(tt.path)+tt.query, "")
		if rec.Code != 200 || rec.Body.String() != tt.body {
			t.Fatalf("download: %d %s", rec.Code, rec.Body)
		}
		if rec.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(rec.Header().Get("Content-Disposition"), "attachment;") {
			t.Fatalf("active download: %v", rec.Header())
		}
	}
}

func TestM4AContainerDetection(t *testing.T) {
	for _, tt := range []struct{ header, want string }{
		{"\x00\x00\x00\x1cftypM4A \x00\x00\x02\x00M4A isomiso2", "audio/mp4"},
		{"\x00\x00\x00\x1cftypM4A ", ""},
		{"\x00\x00\x00\x00ftypM4A \x00\x00\x02\x00", ""},
		{"<html>ftypM4A <script>alert(1)</script></html>", ""},
	} {
		if got := mediaType("sample.M4A", []byte(tt.header)); got != tt.want {
			t.Fatalf("type=%q, want %q for %q", got, tt.want, tt.header)
		}
	}
}

func TestLargeMediaRangeAndDeletedFile(t *testing.T) {
	root := t.TempDir()
	file, err := os.Create(filepath.Join(root, "large.wav"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("RIFF\x00\x00\x00\x00WAVE")); err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(2 << 30); err != nil {
		t.Fatal(err)
	}
	file.Close()
	h := newSnapshotServer(&mediaTestRepo{fakeRepo: &fakeRepo{}, disk: gitx.Repository{Root: root}})
	req := httptest.NewRequest("GET", "/g/"+testToken+"/api/v1/media?path=large.wav", nil)
	req.Host = testHost
	req.Header.Set("Range", "bytes=-1")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 206 || rec.Body.Len() != 1 || rec.Header().Get("Content-Range") != "bytes 2147483647-2147483647/2147483648" {
		t.Fatalf("large stream: %d %v", rec.Code, rec.Header())
	}
	if err := os.Remove(filepath.Join(root, "large.wav")); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("deleted: %d", rec.Code)
	}
}
