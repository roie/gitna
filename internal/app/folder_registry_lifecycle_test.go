package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/protocol"
	"github.com/roie/gitna/internal/server"
	"github.com/roie/gitna/internal/watch"
)

type testWatcher struct {
	events  chan watch.InvalidationKind
	onClose func()
	once    sync.Once
}

func (w *testWatcher) Events() <-chan watch.InvalidationKind { return w.events }
func (w *testWatcher) Close() error {
	w.once.Do(func() {
		if w.onClose != nil {
			w.onClose()
		}
		close(w.events)
	})
	return nil
}

type fakeDormancyTimer struct {
	mu      sync.Mutex
	stopped bool
	fired   bool
	fn      func()
}

func (t *fakeDormancyTimer) Stop() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

func (t *fakeDormancyTimer) fire() bool {
	t.mu.Lock()
	if t.stopped || t.fired {
		t.mu.Unlock()
		return false
	}
	t.fired = true
	fn := t.fn
	t.mu.Unlock()
	fn()
	return true
}

type fakeDormancyScheduler struct {
	mu     sync.Mutex
	delays []time.Duration
	timers []*fakeDormancyTimer
}

func (s *fakeDormancyScheduler) after(delay time.Duration, fn func()) dormancyTimer {
	timer := &fakeDormancyTimer{fn: fn}
	s.mu.Lock()
	s.delays = append(s.delays, delay)
	s.timers = append(s.timers, timer)
	s.mu.Unlock()
	return timer
}

func (s *fakeDormancyScheduler) fireNext(t *testing.T) {
	t.Helper()
	s.mu.Lock()
	timers := append([]*fakeDormancyTimer(nil), s.timers...)
	s.mu.Unlock()
	for _, timer := range timers {
		if timer.fire() {
			return
		}
	}
	t.Fatal("no active dormancy timer")
}

func (s *fakeDormancyScheduler) active() int {
	s.mu.Lock()
	timers := append([]*fakeDormancyTimer(nil), s.timers...)
	s.mu.Unlock()
	active := 0
	for _, timer := range timers {
		timer.mu.Lock()
		if !timer.stopped && !timer.fired {
			active++
		}
		timer.mu.Unlock()
	}
	return active
}

func newLifecycleRegistry(t *testing.T, git bool) (*folderRegistry, *fakeDormancyScheduler) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "folder")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if git {
		initSessionRepository(t, filepath.Dir(root), filepath.Base(root)+"-git")
		root += "-git"
	}
	runner := &gitx.ExecRunner{}
	initial, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	scheduler := &fakeDormancyScheduler{}
	registry, err := newFolderRegistry(
		t.Context(),
		runner,
		fstest.MapFS{"index.html": {Data: []byte("gitna")}},
		"test",
		folder.Open(filepath.Join(t.TempDir(), "folders.json"), 20),
		server.CapabilityPath("token"),
		initial,
		folderRegistryOptions{
			dormancyGrace: 45 * time.Second,
			afterFunc:     scheduler.after,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return registry, scheduler
}

func TestFolderRegistryReservesRoutesWhileWatchersInitialize(t *testing.T) {
	parent := t.TempDir()
	initialRoot := filepath.Join(parent, "initial")
	targetRoot := filepath.Join(parent, "target")
	for _, root := range []string{initialRoot, targetRoot} {
		if err := os.Mkdir(root, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	runner := &gitx.ExecRunner{}
	initial, err := gitx.OpenFolder(t.Context(), runner, initialRoot)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan string, 4)
	watchFactory := func(ctx context.Context, repo gitx.Repository, _ gitx.Runner, _ watch.Options) (watch.Watcher, error) {
		started <- repo.Root
		<-ctx.Done()
		return nil, ctx.Err()
	}
	registry, err := newFolderRegistry(
		t.Context(), runner, fstest.MapFS{"index.html": {Data: []byte("gitna")}}, "test",
		folder.Open(filepath.Join(t.TempDir(), "folders.json"), 20), server.CapabilityPath("token"), initial,
		folderRegistryOptions{dormancyGrace: 45 * time.Second, newWatcher: watchFactory},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.close()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("initial watcher did not start")
	}
	opened := make(chan protocol.OpenFolderResult, 1)
	openErr := make(chan error, 1)
	go func() {
		result, err := registry.openFolder(t.Context(), targetRoot)
		opened <- result
		openErr <- err
	}()
	select {
	case result := <-opened:
		if err := <-openErr; err != nil {
			t.Fatal(err)
		}
		if result.Href != "../target/" {
			t.Fatalf("href = %q", result.Href)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("route reservation waited for recursive watcher setup")
	}

	// The destination shell and APIs are usable while watcher setup is blocked.
	shell := httptest.NewRecorder()
	registry.ServeHTTP(shell, httptest.NewRequest(http.MethodGet, "/target/", nil))
	if shell.Code != http.StatusOK || shell.Body.String() != "gitna" {
		t.Fatalf("shell = %d %q", shell.Code, shell.Body.String())
	}
	assertSnapshotRoot(t, registry, "/target/api/v1/snapshot", targetRoot)
}

func TestFolderRegistryDrainsConcurrentCapabilityRefreshBeforeServingAPI(t *testing.T) {
	initialRoot := t.TempDir()
	targetRoot := t.TempDir()
	runner := &gitx.ExecRunner{}
	initial, err := gitx.OpenFolder(t.Context(), runner, initialRoot)
	if err != nil {
		t.Fatal(err)
	}
	activationStarted := make(chan struct{})
	releaseActivation := make(chan struct{})
	var targetResolutions atomic.Int32
	resolve := func(ctx context.Context, path string) (gitx.Repository, error) {
		if folder.PathKey(path) != folder.PathKey(targetRoot) {
			return gitx.OpenFolder(ctx, runner, path)
		}
		switch targetResolutions.Add(1) {
		case 1:
			return gitx.Repository{Root: targetRoot}, nil
		case 2:
			close(activationStarted)
			select {
			case <-releaseActivation:
				return gitx.Repository{Root: targetRoot}, nil
			case <-ctx.Done():
				return gitx.Repository{}, ctx.Err()
			}
		default:
			return gitx.OpenFolder(ctx, runner, targetRoot)
		}
	}
	watchFactory := func(context.Context, gitx.Repository, gitx.Runner, watch.Options) (watch.Watcher, error) {
		return &testWatcher{events: make(chan watch.InvalidationKind)}, nil
	}
	registry, err := newFolderRegistry(
		t.Context(), runner, fstest.MapFS{"index.html": {Data: []byte("gitna")}}, "test",
		folder.Open(filepath.Join(t.TempDir(), "folders.json"), 20), server.CapabilityPath("token"), initial,
		folderRegistryOptions{
			dormancyGrace: 45 * time.Second,
			openFolder:    resolve,
			newWatcher:    watchFactory,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.close()
	opened, err := registry.openFolder(t.Context(), targetRoot)
	if err != nil {
		t.Fatal(err)
	}

	route := strings.TrimSuffix(strings.TrimPrefix(opened.Href, "../"), "/")
	responseDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		registry.ServeHTTP(
			response,
			httptest.NewRequest(http.MethodGet, "/"+route+"/api/v1/snapshot", nil),
		)
		responseDone <- response
	}()
	select {
	case <-activationStarted:
	case <-time.After(time.Second):
		t.Fatal("destination activation did not start")
	}
	if output, err := exec.Command("git", "-C", targetRoot, "init", "-q", "-b", "main").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	refreshed, err := registry.openFolder(t.Context(), targetRoot)
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.Href != opened.Href {
		t.Fatalf("refreshed href = %q, want %q", refreshed.Href, opened.Href)
	}
	close(releaseActivation)

	select {
	case response := <-responseDone:
		if response.Code != http.StatusOK {
			t.Fatalf("snapshot status = %d: %s", response.Code, response.Body)
		}
		var snapshot protocol.RepoSnapshot
		if err := json.Unmarshal(response.Body.Bytes(), &snapshot); err != nil {
			t.Fatal(err)
		}
		if !snapshot.Repository {
			t.Fatal("destination API exposed stale ordinary-folder capability")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("destination API did not finish after capability refresh")
	}
}

func TestFolderRegistryWatcherFailureKeepsFolderUsableAndReconcilesOnSuccess(t *testing.T) {
	root := t.TempDir()
	runner := &gitx.ExecRunner{}
	initial, err := gitx.OpenFolder(t.Context(), runner, root)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	watchFactory := func(context.Context, gitx.Repository, gitx.Runner, watch.Options) (watch.Watcher, error) {
		if calls.Add(1) == 1 {
			return nil, errors.New("watch limit reached")
		}
		return &testWatcher{events: make(chan watch.InvalidationKind)}, nil
	}
	registry, err := newFolderRegistry(
		t.Context(), runner, fstest.MapFS{"index.html": {Data: []byte("gitna")}}, "test",
		folder.Open(filepath.Join(t.TempDir(), "folders.json"), 20), server.CapabilityPath("token"), initial,
		folderRegistryOptions{dormancyGrace: 45 * time.Second, newWatcher: watchFactory},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.close()
	assertSnapshotRoot(t, registry, "/"+registry.initialRoute+"/api/v1/snapshot", root)

	entry := registry.byRoute[registry.initialRoute]
	deadline := time.Now().Add(time.Second)
	for {
		entry.session.mu.Lock()
		watchErr := entry.session.watchErr
		entry.session.mu.Unlock()
		if watchErr != nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("watcher failure was not stored")
		}
		time.Sleep(time.Millisecond)
	}

	// A capability refresh starts a replacement watcher and its ready
	// reconciliation advances route generation.
	if output, err := exec.Command("git", "-C", root, "init", "-q", "-b", "main").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	if _, err := registry.openFolder(t.Context(), root); err != nil {
		t.Fatal(err)
	}
	assertSnapshotRepository(t, registry, "/"+registry.initialRoute+"/api/v1/snapshot", true)
	deadline = time.Now().Add(time.Second)
	for entry.server.Generation() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if entry.server.Generation() < 3 {
		t.Fatalf("generation = %d, want watcher reconciliation", entry.server.Generation())
	}
}

func TestFolderRegistryDormantShellDoesNotReviveBackend(t *testing.T) {
	registry, scheduler := newLifecycleRegistry(t, true)
	defer registry.close()
	entry := registry.byRoute[registry.initialRoute]
	registry.subscribersChanged(entry, 1)
	registry.subscribersChanged(entry, -1)
	scheduler.fireNext(t)

	response := httptest.NewRecorder()
	registry.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/"+registry.initialRoute+"/", nil))
	if response.Code != http.StatusOK || response.Body.String() != "gitna" {
		t.Fatalf("shell = %d %q", response.Code, response.Body.String())
	}
	entry.mu.Lock()
	active := entry.session != nil || entry.server != nil
	entry.mu.Unlock()
	if active {
		t.Fatal("static shell revived dormant backend")
	}
}

func TestFolderRegistryDormancyTracksFinalSubscriberAndReconnect(t *testing.T) {
	registry, scheduler := newLifecycleRegistry(t, true)
	defer registry.close()
	entry := registry.byRoute[registry.initialRoute]

	registry.subscribersChanged(entry, 1)
	registry.subscribersChanged(entry, 1)
	registry.subscribersChanged(entry, -1)
	if scheduler.active() != 0 {
		t.Fatal("one remaining subscriber started dormancy")
	}
	registry.subscribersChanged(entry, -1)
	if scheduler.active() != 1 {
		t.Fatalf("active timers = %d, want 1", scheduler.active())
	}
	if len(scheduler.delays) != 1 || scheduler.delays[0] != 45*time.Second {
		t.Fatalf("delays = %v", scheduler.delays)
	}

	registry.subscribersChanged(entry, 1)
	if scheduler.active() != 0 {
		t.Fatal("reconnect did not cancel dormancy")
	}
	registry.subscribersChanged(entry, -1)
	entry.session.events <- watch.InvalidateSnapshot
	scheduler.fireNext(t)
	entry.mu.Lock()
	dormant := entry.session == nil && entry.server == nil
	generation := entry.generation
	entry.mu.Unlock()
	if !dormant || generation < 3 {
		t.Fatalf("dormant = %v generation = %d, want drained event plus revival seed", dormant, generation)
	}
}

func TestFolderRegistryDormantRouteRevivesWithStableIdentity(t *testing.T) {
	for _, git := range []bool{false, true} {
		t.Run(map[bool]string{false: "folder", true: "git"}[git], func(t *testing.T) {
			registry, scheduler := newLifecycleRegistry(t, git)
			defer registry.close()
			route := registry.initialRoute
			entry := registry.byRoute[route]
			root := entry.root
			registry.subscribersChanged(entry, 1)
			registry.subscribersChanged(entry, -1)
			scheduler.fireNext(t)

			assertSnapshotRoot(t, registry, "/"+route+"/api/v1/snapshot", root)
			if registry.initialRoute != route || registry.byRoot[folder.PathKey(root)] != route {
				t.Fatal("revival changed stable route metadata")
			}
			entry.mu.Lock()
			active := entry.session != nil && entry.server != nil
			generation := entry.server.Generation()
			entry.mu.Unlock()
			if !active || generation < 2 {
				t.Fatalf("active = %v generation = %d", active, generation)
			}
		})
	}
}

func TestFolderRegistryDoesNotRetireActiveMutation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test uses a POSIX Git hook")
	}
	registry, scheduler := newLifecycleRegistry(t, true)
	defer registry.close()
	entry := registry.byRoute[registry.initialRoute]
	root := entry.root
	for _, args := range [][]string{
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Gitna Test"},
	} {
		if output, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "active.txt"), []byte("active\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("git", "-C", root, "add", "active.txt").CombinedOutput(); err != nil {
		t.Fatalf("git add: %v: %s", err, output)
	}
	started := filepath.Join(root, "hook-started")
	releaseHook := filepath.Join(root, "hook-release")
	hook := "#!/bin/sh\ntouch '" + started + "'\nwhile [ ! -f '" + releaseHook + "' ]; do sleep 0.01; done\n"
	hookPath := filepath.Join(root, ".git", "hooks", "pre-commit")
	if err := os.WriteFile(hookPath, []byte(hook), 0o755); err != nil {
		t.Fatal(err)
	}

	responseDone := make(chan int, 1)
	go func() {
		request := httptest.NewRequest(
			http.MethodPost,
			"/"+registry.initialRoute+"/api/v1/operations?op=commit",
			bytes.NewBufferString(`{"message":"active mutation"}`),
		)
		response := httptest.NewRecorder()
		registry.ServeHTTP(response, request)
		responseDone <- response.Code
	}()
	deadline := time.Now().Add(5 * time.Second)
	for !fileExists(started) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !fileExists(started) {
		t.Fatal("commit hook did not start")
	}
	registry.subscribersChanged(entry, 1)
	registry.subscribersChanged(entry, -1)
	if scheduler.active() != 0 {
		t.Fatal("active mutation started dormancy")
	}
	entry.mu.Lock()
	active := entry.active
	sessionPresent := entry.session != nil
	entry.mu.Unlock()
	if active == 0 || !sessionPresent {
		t.Fatalf("active = %d session present = %v", active, sessionPresent)
	}
	if err := os.WriteFile(releaseHook, []byte("release\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if status := <-responseDone; status != http.StatusOK {
		t.Fatalf("commit status = %d", status)
	}
	if scheduler.active() != 1 {
		t.Fatal("completed mutation did not start dormancy")
	}
	scheduler.fireNext(t)
	entry.mu.Lock()
	dormant := entry.session == nil
	entry.mu.Unlock()
	if !dormant {
		t.Fatal("session remained active after grace expiry")
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestFolderRegistryConcurrentRevivalCreatesOneBackend(t *testing.T) {
	registry, scheduler := newLifecycleRegistry(t, true)
	defer registry.close()
	entry := registry.byRoute[registry.initialRoute]
	registry.subscribersChanged(entry, 1)
	registry.subscribersChanged(entry, -1)
	scheduler.fireNext(t)

	const requests = 16
	start := make(chan struct{})
	errs := make(chan error, requests)
	var wg sync.WaitGroup
	for range requests {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			request := httptest.NewRequest(http.MethodGet, "/"+registry.initialRoute+"/api/v1/snapshot", nil)
			response := httptest.NewRecorder()
			registry.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				errs <- errorsForStatus(response.Code)
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	entry.mu.Lock()
	active := entry.session != nil && entry.server != nil && entry.transition == nil
	entry.mu.Unlock()
	if !active {
		t.Fatal("concurrent revival did not leave one active backend")
	}
}

func errorsForStatus(status int) error {
	return &statusError{status: status}
}

type statusError struct{ status int }

func (e *statusError) Error() string { return http.StatusText(e.status) }

func TestFolderRegistryShutdownWaitsForActiveRequest(t *testing.T) {
	registry, _ := newLifecycleRegistry(t, true)
	entry := registry.byRoute[registry.initialRoute]
	_, release, err := registry.acquire(t.Context(), entry)
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() {
		_ = registry.close()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("shutdown closed a backend with an active request")
	case <-time.After(20 * time.Millisecond):
	}
	release()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish after active request completed")
	}
}

func TestFolderRegistryShutdownRejectsRefreshAfterSessionClose(t *testing.T) {
	registry, _ := newLifecycleRegistry(t, false)
	entry := registry.byRoute[registry.initialRoute]
	session, release, err := registry.acquire(t.Context(), entry)
	if err != nil {
		t.Fatal(err)
	}
	root := entry.root
	command := exec.Command("git", "-C", root, "init", "-q", "-b", "main")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	refreshedRepo, err := gitx.OpenFolder(t.Context(), registry.runner, root)
	if err != nil {
		t.Fatal(err)
	}
	closeDone := make(chan error, 1)
	go func() { closeDone <- registry.close() }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		session.refreshMu.Lock()
		closed := session.closed
		session.refreshMu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("session did not close during registry shutdown")
		}
		time.Sleep(time.Millisecond)
	}
	if err := session.refresh(t.Context(), refreshedRepo); !errors.Is(err, errFolderSessionClosed) {
		t.Fatalf("refresh error = %v, want folder session closed", err)
	}
	session.mu.Lock()
	watcher := session.watcher
	session.mu.Unlock()
	if watcher != nil {
		t.Fatal("refresh installed a watcher after session close")
	}
	release()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("registry shutdown did not finish after rejected refresh")
	}
}

func TestFolderRegistryClosePreventsRouteCreationAfterResolution(t *testing.T) {
	registry, _ := newLifecycleRegistry(t, true)
	target := filepath.Join(t.TempDir(), "late-folder")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	releaseResolution := make(chan struct{})
	registry.resolveFolder = func(ctx context.Context, path string) (gitx.Repository, error) {
		close(started)
		select {
		case <-releaseResolution:
			return gitx.OpenFolder(ctx, registry.runner, path)
		case <-ctx.Done():
			return gitx.Repository{}, ctx.Err()
		}
	}
	type openResult struct {
		result protocol.OpenFolderResult
		err    error
	}
	opened := make(chan openResult, 1)
	go func() {
		result, err := registry.openFolder(t.Context(), target)
		opened <- openResult{result: result, err: err}
	}()
	<-started
	if err := registry.close(); err != nil {
		t.Fatal(err)
	}
	close(releaseResolution)
	outcome := <-opened
	if !errors.Is(outcome.err, errFolderRegistryClosed) {
		t.Fatalf("open error = %v, want folder registry closed", outcome.err)
	}
	if outcome.result.Href != "" || outcome.result.Root != "" {
		t.Fatalf("open result after close = %#v", outcome.result)
	}
	registry.mu.RLock()
	_, rootExists := registry.byRoot[folder.PathKey(target)]
	routeCount := len(registry.byRoute)
	registry.mu.RUnlock()
	if rootExists || routeCount != 1 {
		t.Fatalf("late route exists = %v route count = %d", rootExists, routeCount)
	}
}

func TestFolderRegistryShutdownClosesHubBeforeLateEventsSubscribe(t *testing.T) {
	registry, _ := newLifecycleRegistry(t, true)
	entry := registry.byRoute[registry.initialRoute]
	srv, release, err := registry.acquireServer(t.Context(), entry)
	if err != nil {
		t.Fatal(err)
	}
	var releaseOnce sync.Once
	releaseRequest := func() { releaseOnce.Do(release) }
	defer releaseRequest()
	closeDone := make(chan error, 1)
	go func() { closeDone <- registry.close() }()
	// The route request has acquired its server, but has not subscribed yet.
	// Wait until shutdown closes and drains the source before entering /events.
	hubClosed := make(chan struct{})
	go func() {
		srv.WaitEvents()
		close(hubClosed)
	}()
	select {
	case <-hubClosed:
	case <-time.After(5 * time.Second):
		t.Fatal("registry shutdown did not close the acquired server event hub")
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/events", nil)
	response := httptest.NewRecorder()
	streamDone := make(chan struct{})
	go func() {
		srv.ServeHTTP(response, request)
		close(streamDone)
	}()
	select {
	case <-streamDone:
	case <-time.After(5 * time.Second):
		t.Fatal("late events subscription did not observe the closed hub")
	}
	if response.Code != http.StatusOK {
		t.Fatalf("events status = %d, want 200", response.Code)
	}
	releaseRequest()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("registry shutdown did not finish after late subscription")
	}
}

func TestFolderRegistryShutdownClosesConnectedEventsStream(t *testing.T) {
	registry, _ := newLifecycleRegistry(t, true)
	entry := registry.byRoute[registry.initialRoute]
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request := httptest.NewRequest(
		http.MethodGet,
		"/"+registry.initialRoute+"/api/v1/events",
		nil,
	).WithContext(ctx)
	response := httptest.NewRecorder()
	streamDone := make(chan struct{})
	go func() {
		registry.ServeHTTP(response, request)
		close(streamDone)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		entry.mu.Lock()
		subscribers := entry.subscribers
		entry.mu.Unlock()
		if subscribers == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("events subscriber did not connect")
		}
		time.Sleep(time.Millisecond)
	}

	closeDone := make(chan error, 1)
	go func() { closeDone <- registry.close() }()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("registry shutdown blocked on connected events stream")
	}
	select {
	case <-streamDone:
	case <-time.After(5 * time.Second):
		t.Fatal("events stream remained connected after registry shutdown")
	}
	if response.Code != http.StatusOK {
		t.Fatalf("events status = %d, want 200", response.Code)
	}
	entry.mu.Lock()
	closed := entry.session == nil && entry.server == nil && entry.subscribers == 0
	entry.mu.Unlock()
	if !closed {
		t.Fatal("shutdown retained backend or events subscriber")
	}
}

func TestFolderRegistryShutdownCancelsDormancyAndRejectsRevival(t *testing.T) {
	registry, scheduler := newLifecycleRegistry(t, true)
	entry := registry.byRoute[registry.initialRoute]
	registry.subscribersChanged(entry, 1)
	registry.subscribersChanged(entry, -1)
	if scheduler.active() != 1 {
		t.Fatal("missing dormancy timer before shutdown")
	}
	if err := registry.close(); err != nil {
		t.Fatal(err)
	}
	if scheduler.active() != 0 {
		t.Fatal("shutdown did not cancel dormancy")
	}
	entry.mu.Lock()
	closed := entry.session == nil && entry.server == nil && entry.shutting
	entry.mu.Unlock()
	if !closed {
		t.Fatal("shutdown retained heavyweight backend")
	}
	request := httptest.NewRequest(http.MethodGet, "/"+registry.initialRoute+"/api/v1/snapshot", nil)
	response := httptest.NewRecorder()
	registry.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status after shutdown = %d, want 503", response.Code)
	}
}
