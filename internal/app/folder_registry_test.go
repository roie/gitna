package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
)

func TestFolderRegistryKeepsStableIndependentRoutes(t *testing.T) {
	parent := t.TempDir()
	first := filepath.Join(parent, "one", "shared")
	second := filepath.Join(parent, "two", "shared")
	for _, root := range []string{first, second} {
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	runner := &gitx.ExecRunner{}
	initial, err := gitx.OpenFolder(t.Context(), runner, first)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := newFolderRegistry(
		t.Context(),
		runner,
		fstest.MapFS{"index.html": {Data: []byte("gitna")}},
		"test",
		folder.Open(filepath.Join(t.TempDir(), "folders.json"), 20),
		server.CapabilityPath("token"),
		initial,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.close()

	firstResult, err := registry.openFolder(t.Context(), first)
	if err != nil {
		t.Fatal(err)
	}
	secondResult, err := registry.openFolder(t.Context(), second)
	if err != nil {
		t.Fatal(err)
	}
	if firstResult.Href != "../shared/" || secondResult.Href != "../shared-2/" {
		t.Fatalf("routes = %q, %q", firstResult.Href, secondResult.Href)
	}
	reopened, err := registry.openFolder(t.Context(), first)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Href != firstResult.Href {
		t.Fatalf("reopened href = %q, want %q", reopened.Href, firstResult.Href)
	}
	alias := filepath.Join(parent, "shared-alias")
	if err := os.Symlink(first, alias); err != nil {
		t.Fatal(err)
	}
	aliased, err := registry.openFolder(t.Context(), alias)
	if err != nil {
		t.Fatal(err)
	}
	if aliased.Href != firstResult.Href {
		t.Fatalf("aliased href = %q, want %q", aliased.Href, firstResult.Href)
	}

	assertSnapshotRoot(t, registry, "/shared/api/v1/snapshot", first)
	assertSnapshotRoot(t, registry, "/shared-2/api/v1/snapshot", second)
	assertSnapshotRoot(t, registry, "/shared/api/v1/snapshot", first)
}

func TestFolderRegistryRedirectsEntryPointsAndRejectsUnknownRoutes(t *testing.T) {
	root := t.TempDir()
	runner := &gitx.ExecRunner{}
	initial, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := newFolderRegistry(
		t.Context(),
		runner,
		fstest.MapFS{"index.html": {Data: []byte("gitna")}},
		"test",
		folder.Open(filepath.Join(t.TempDir(), "folders.json"), 20),
		server.CapabilityPath("token"),
		initial,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.close()

	rootRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	rootResponse := httptest.NewRecorder()
	registry.ServeHTTP(rootResponse, rootRequest)
	if rootResponse.Code != http.StatusFound || rootResponse.Header().Get("Location") != registry.initialHref() {
		t.Fatalf("root redirect = %d %q", rootResponse.Code, rootResponse.Header().Get("Location"))
	}

	slashless := httptest.NewRequest(http.MethodGet, "/"+registry.initialRoute, nil)
	slashlessResponse := httptest.NewRecorder()
	registry.ServeHTTP(slashlessResponse, slashless)
	if slashlessResponse.Code != http.StatusFound || slashlessResponse.Header().Get("Location") != registry.initialHref() {
		t.Fatalf("route redirect = %d %q", slashlessResponse.Code, slashlessResponse.Header().Get("Location"))
	}

	unknown := httptest.NewRequest(http.MethodGet, "/missing/api/v1/snapshot", nil)
	unknownResponse := httptest.NewRecorder()
	registry.ServeHTTP(unknownResponse, unknown)
	if unknownResponse.Code != http.StatusNotFound {
		t.Fatalf("unknown status = %d", unknownResponse.Code)
	}
}

func assertSnapshotRoot(t *testing.T, registry *folderRegistry, path, want string) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	response := httptest.NewRecorder()
	registry.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("%s status = %d (%s)", path, response.Code, response.Body)
	}
	var snapshot protocol.RepoSnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Root != want {
		t.Fatalf("%s root = %q, want %q", path, snapshot.Root, want)
	}
}
