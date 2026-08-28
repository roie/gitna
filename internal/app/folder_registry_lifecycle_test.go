package app

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/roie/gitna/internal/folder"
	"github.com/roie/gitna/internal/gitx"
	"github.com/roie/gitna/internal/server"
	"github.com/roie/gitna/internal/watch"
)

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
