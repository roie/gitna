package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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

	if err := registry.removeRecentFolder(t.Context(), second); err != nil {
		t.Fatal(err)
	}
	for _, recent := range registry.folders.Recent() {
		if folder.PathKey(recent.Path) == folder.PathKey(second) {
			t.Fatalf("removed folder remains recent: %#v", registry.folders.Recent())
		}
	}
	// Removing history does not retire the live route.
	assertSnapshotRoot(t, registry, "/shared-2/api/v1/snapshot", second)
	reopenedSecond, err := registry.openFolder(t.Context(), second)
	if err != nil {
		t.Fatal(err)
	}
	if reopenedSecond.Href != secondResult.Href || registry.folders.Recent()[0].Path != second {
		t.Fatalf("reopened = %#v recent = %#v", reopenedSecond, registry.folders.Recent())
	}
}

func TestFolderRegistryRefreshesCapabilitiesWithoutChangingRouteOrQueue(t *testing.T) {
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

	route := registry.initialRoute
	entry := registry.byRoute[route]
	queue := entry.session.adapter.queue
	assertSnapshotRepository(t, registry, "/"+route+"/api/v1/snapshot", false)

	command := exec.Command("git", "-C", root, "init", "-q", "-b", "main")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	opened, err := registry.openFolder(t.Context(), root)
	if err != nil {
		t.Fatal(err)
	}
	if opened.Href != "../"+route+"/" {
		t.Fatalf("Git route = %q, want stable route %q", opened.Href, "../"+route+"/")
	}
	if registry.byRoute[route] != entry || entry.session.adapter.queue != queue {
		t.Fatal("capability refresh replaced the route session or mutation queue")
	}
	assertSnapshotRepository(t, registry, "/"+route+"/api/v1/snapshot", true)

	if err := os.RemoveAll(filepath.Join(root, ".git")); err != nil {
		t.Fatal(err)
	}
	opened, err = registry.openFolder(t.Context(), root)
	if err != nil {
		t.Fatal(err)
	}
	if opened.Href != "../"+route+"/" || entry.session.adapter.queue != queue {
		t.Fatal("removing Git capabilities changed the stable route or mutation queue")
	}
	assertSnapshotRepository(t, registry, "/"+route+"/api/v1/snapshot", false)
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

func snapshotForRoute(t *testing.T, registry *folderRegistry, path string) protocol.RepoSnapshot {
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
	return snapshot
}

func assertSnapshotRoot(t *testing.T, registry *folderRegistry, path, want string) {
	t.Helper()
	if got := snapshotForRoute(t, registry, path).Root; got != want {
		t.Fatalf("%s root = %q, want %q", path, got, want)
	}
}

func assertSnapshotRepository(t *testing.T, registry *folderRegistry, path string, want bool) {
	t.Helper()
	if got := snapshotForRoute(t, registry, path).Repository; got != want {
		t.Fatalf("%s repository = %v, want %v", path, got, want)
	}
}
