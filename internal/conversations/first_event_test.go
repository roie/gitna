package conversations

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func libraryStore(t *testing.T, base, key string) *Store {
	t.Helper()
	l := NewLibrary(base)
	t.Cleanup(func() {
		if err := l.Close(); err != nil {
			t.Error(err)
		}
	})
	s, err := l.Store(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestStoreWaitsForFirstEvent(t *testing.T) {
	base := filepath.Join(t.TempDir(), "conversations")
	s := libraryStore(t, base, "folder")
	if list, seq, err := s.List(""); err != nil || len(list) != 0 || seq != 0 {
		t.Fatalf("list = %v, %d, %v", list, seq, err)
	}
	if agents, err := s.Agents(); err != nil || len(agents) != 0 {
		t.Fatalf("agents = %v, %v", agents, err)
	}
	if pending, seq, err := s.Pending("agent:absent"); err != nil || len(pending) != 0 || seq != 0 {
		t.Fatalf("pending = %v, %d, %v", pending, seq, err)
	}
	if read, err := s.Read(human.ID); err != nil || len(read) != 0 {
		t.Fatalf("read = %v, %v", read, err)
	}
	if seq, err := s.Cursor("agent:absent"); err != nil || seq != 0 {
		t.Fatalf("cursor = %d, %v", seq, err)
	}
	if _, err := s.Ack("agent:absent", 100, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MarkRead(human.ID, "absent", 100); err != ErrNotFound {
		t.Fatalf("mark read = %v", err)
	}
	entries, err := os.ReadDir(base)
	if err != nil || len(entries) != 0 {
		t.Fatalf("empty base = %v, %v", entries, err)
	}
	if s.watcher != nil {
		t.Fatal("detached store has a watcher")
	}
	if _, err := s.Create(human, "first", anchorAt("a", 1, 1, "x"), "hello", nil); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(s.dir, logName))
	if err != nil || len(data) == 0 {
		t.Fatalf("first log = %q, %v", data, err)
	}
	data, err = os.ReadFile(filepath.Join(s.dir, "worktree"))
	if err != nil || string(data) != "folder\n" {
		t.Fatalf("worktree = %q, %v", data, err)
	}
}

func TestJoinCreatesStore(t *testing.T) {
	s := libraryStore(t, t.TempDir(), "folder")
	if _, err := s.Join("helper"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(s.dir, logName)); err != nil || info.Size() == 0 {
		t.Fatalf("join log = %v, %v", info, err)
	}
}

func TestCloseDetached(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "absent"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := NewLibrary(t.TempDir()).Close(); err != nil {
		t.Fatal(err)
	}
}

func TestFirstEventWakesAnotherLibrary(t *testing.T) {
	base := t.TempDir()
	a := libraryStore(t, base, "folder")
	b := libraryStore(t, base, "folder")
	_, changed, err := b.Events(0)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result := make(chan []Event, 1)
	go func() {
		events, err := b.Wait(ctx, 0)
		if err != nil {
			t.Error(err)
		}
		result <- events
	}()
	if _, err := a.Create(human, "first", anchorAt("a", 1, 1, "x"), "hello", nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-ctx.Done():
		t.Fatal("Events did not wake")
	}
	if events := <-result; len(events) != 1 {
		t.Fatalf("Wait = %v", events)
	}
}

func TestConcurrentFirstEvent(t *testing.T) {
	base := t.TempDir()
	a := libraryStore(t, base, "folder")
	b := libraryStore(t, base, "folder")
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i, s := range []*Store{a, b} {
		wg.Go(func() {
			<-start
			if _, err := s.Create(human, fmt.Sprintf("c%d", i), anchorAt("a", 1, 1, "x"), "hello", nil); err != nil {
				t.Error(err)
			}
		})
	}
	close(start)
	wg.Wait()
	assertFirstEvents(t, libraryStore(t, base, "folder"), 2)
}

func assertFirstEvents(t *testing.T, s *Store, count int) {
	t.Helper()
	list, _, err := s.List("")
	if err != nil || len(list) != count {
		t.Fatalf("list = %v, %v", list, err)
	}
	f, err := os.Open(filepath.Join(s.dir, logName))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	lines := bufio.NewScanner(f)
	n := 0
	for lines.Scan() {
		if !json.Valid(lines.Bytes()) {
			t.Fatalf("invalid JSON line: %q", lines.Text())
		}
		n++
	}
	if err := lines.Err(); err != nil {
		t.Fatal(err)
	}
	if n != count {
		t.Fatalf("log lines = %d, want %d", n, count)
	}
}

func TestFirstEventProcesses(t *testing.T) {
	if base := os.Getenv("GITNA_TEST_FIRST_BASE"); base != "" {
		s := libraryStore(t, base, "folder")
		fmt.Println("ready")
		if _, err := io.ReadFull(os.Stdin, make([]byte, 1)); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Create(human, "", anchorAt("a", 1, 1, "x"), "hello", nil); err != nil {
			t.Fatal(err)
		}
		return
	}
	start := func(base string) (*exec.Cmd, io.WriteCloser) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		t.Cleanup(cancel)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestFirstEventProcesses$")
		cmd.Env = append(os.Environ(), "GITNA_TEST_FIRST_BASE="+base)
		cmd.Stderr = os.Stderr
		stdin, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		line, err := bufio.NewReader(stdout).ReadString('\n')
		if err != nil || line != "ready\n" {
			t.Fatalf("helper readiness = %q, %v", line, err)
		}
		return cmd, stdin
	}
	t.Run("observe", func(t *testing.T) {
		base := t.TempDir()
		s := libraryStore(t, base, "folder")
		if _, err := os.Stat(s.dir); !os.IsNotExist(err) {
			t.Fatalf("store already exists: %v", err)
		}
		_, changed, err := s.Events(0)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		result := make(chan []Event, 1)
		go func() {
			events, err := s.Wait(ctx, 0)
			if err != nil {
				t.Error(err)
			}
			result <- events
		}()
		cmd, stdin := start(base)
		if _, err := stdin.Write([]byte{1}); err != nil {
			t.Fatal(err)
		}
		stdin.Close()
		if err := cmd.Wait(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-changed:
		case <-ctx.Done():
			t.Fatal("Events did not wake")
		}
		if events := <-result; len(events) != 1 {
			t.Fatalf("Wait = %v", events)
		}
		assertFirstEvents(t, s, 1)
	})
	t.Run("create", func(t *testing.T) {
		for range 20 {
			base := t.TempDir()
			a, inA := start(base)
			b, inB := start(base)
			for _, in := range []io.WriteCloser{inA, inB} {
				if _, err := in.Write([]byte{1}); err != nil {
					t.Fatal(err)
				}
				in.Close()
			}
			for _, cmd := range []*exec.Cmd{a, b} {
				if err := cmd.Wait(); err != nil {
					t.Fatal(err)
				}
			}
			assertFirstEvents(t, libraryStore(t, base, "folder"), 2)
		}
	})
}
