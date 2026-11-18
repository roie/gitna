package agentrun

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

const claude = "claude-agent-acp"

func adapterArchives(t *testing.T, name string) (tgz, zipped []byte) {
	t.Helper()
	body := []byte("adapter")
	var tb bytes.Buffer
	gz := gzip.NewWriter(&tb)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "./" + name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	tw.Write(body)
	tw.Close()
	gz.Close()
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	h := &zip.FileHeader{Name: name, Method: zip.Deflate}
	h.SetMode(0o755)
	w, err := zw.CreateHeader(h)
	if err != nil {
		t.Fatal(err)
	}
	w.Write(body)
	zw.Close()
	return tb.Bytes(), zb.Bytes()
}

// serveAdapter points Claude's adapter for this platform at a local server
// that serves data under name, with checksum sum.
func serveAdapter(t *testing.T, name string, data []byte, sum string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(data) }))
	t.Cleanup(srv.Close)
	saved := adapters[claude]
	t.Cleanup(func() { adapters[claude] = saved })
	adapters[claude] = adapter{version: "1.0.0", archives: map[string]archive{
		platform(): {url: srv.URL + "/" + name, sha256: sum, size: int64(len(data))},
	}}
}

func checksum(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func program(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func TestInstallUnpacksVerifiedAdapters(t *testing.T) {
	t.Setenv("PATH", "")
	tgz, zipped := adapterArchives(t, program(claude))
	for name, data := range map[string][]byte{"adapter.tar.gz": tgz, "adapter.zip": zipped} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			serveAdapter(t, name, data, checksum(data))
			var progress []int
			found, err := Install(context.Background(), dir, claude, func(p int) { progress = append(progress, p) })
			if err != nil {
				t.Fatal(err)
			}
			want := filepath.Join(dir, claude, "1.0.0", program(claude))
			if found.Name != "Claude" || found.Executable != want {
				t.Fatalf("found %+v, want %s", found, want)
			}
			if got, err := os.ReadFile(want); err != nil || string(got) != "adapter" {
				t.Fatalf("adapter = %q, %v", got, err)
			}
			if runtime.GOOS != "windows" {
				if info, _ := os.Stat(want); info.Mode()&0o100 == 0 {
					t.Fatalf("adapter is not executable: %v", info.Mode())
				}
			}
			if len(progress) == 0 || progress[len(progress)-1] != 100 {
				t.Fatalf("progress = %v", progress)
			}
			entries, _ := os.ReadDir(filepath.Join(dir, claude))
			if len(entries) != 1 {
				t.Fatalf("left behind: %v", entries)
			}
			available, _ := Discover(nil, dir)
			if i := slices.IndexFunc(available, func(f Found) bool { return f.Name == "Claude" }); i < 0 || available[i].Executable != want {
				t.Fatalf("discover = %+v", available)
			}
			if a := Adapters(dir); len(a) != 1 || a[0].Program != claude || a[0].Size != int64(len("adapter")) {
				t.Fatalf("adapters = %+v", a)
			}
		})
	}
}

func TestInstallRejectsABadDownloadAndLeavesNothing(t *testing.T) {
	tgz, _ := adapterArchives(t, program(claude))
	var escaping bytes.Buffer
	gz := gzip.NewWriter(&escaping)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "../escape", Mode: 0o644, Size: 1, Typeflag: tar.TypeReg})
	tw.Write([]byte("x"))
	tw.Close()
	gz.Close()
	for name, c := range map[string]struct {
		data []byte
		sum  string
	}{
		"mismatch": {tgz, checksum([]byte("other"))},
		"escape":   {escaping.Bytes(), checksum(escaping.Bytes())},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			serveAdapter(t, "adapter.tar.gz", c.data, c.sum)
			if _, err := Install(context.Background(), dir, claude, nil); err == nil {
				t.Fatal("install succeeded")
			}
			entries, _ := os.ReadDir(filepath.Join(dir, claude))
			if len(entries) != 0 {
				t.Fatalf("left behind: %v", entries)
			}
			if _, err := os.Stat(filepath.Join(dir, "escape")); err == nil {
				t.Fatal("archive wrote outside its folder")
			}
		})
	}
}

func TestRemoveAdapterDeletesItAndForgetsItsAgents(t *testing.T) {
	dir := t.TempDir()
	data, _ := adapterArchives(t, program(claude))
	serveAdapter(t, "adapter.tar.gz", data, checksum(data))
	found, err := Install(context.Background(), dir, claude, nil)
	if err != nil {
		t.Fatal(err)
	}
	settings, err := Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	other := Definition{ID: "other", Name: "Other", Executable: filepath.Join(t.TempDir(), "other")}
	settings.Update(func(s *Settings) error {
		s.Agents = []Definition{{ID: "claude", Name: "Claude", Executable: found.Executable}, other}
		return nil
	})
	if err := RemoveAdapter(dir, claude, settings); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, claude)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("adapter folder remains: %v", err)
	}
	if got := settings.Get().Agents; !slices.EqualFunc(got, []Definition{other}, func(a, b Definition) bool { return a.ID == b.ID }) {
		t.Fatalf("agents = %+v", got)
	}
	if err := RemoveAdapter(dir, "../escape", settings); err == nil {
		t.Fatal("removed an unknown adapter")
	}
}

func TestCodexAdapterRequiresNode(t *testing.T) {
	t.Setenv("PATH", "")
	dir := t.TempDir()
	if d := download(dir, "codex-acp"); d == nil || !d.RequiresNode {
		t.Fatalf("download = %+v", d)
	}
	if _, err := Install(context.Background(), dir, "codex-acp", nil); !errors.Is(err, ErrRequiresNode) {
		t.Fatalf("install = %v", err)
	}
}
