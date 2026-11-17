package prefs

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
)

const (
	helperPathEnv = "GITNA_PREFS_HELPER_PATH"
	helperKeyEnv  = "GITNA_PREFS_HELPER_KEY"
	writesPerKey  = 8
)

func TestMain(m *testing.M) {
	if path := os.Getenv(helperPathEnv); path != "" {
		f := Open(path)
		key := os.Getenv(helperKeyEnv)
		for i := range writesPerKey {
			if err := f.Set(key, strconv.Itoa(i)); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func newFile(t *testing.T) (*File, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "state")
	return Open(filepath.Join(dir, "preferences.json")), dir
}

func TestMissingFileIsEmpty(t *testing.T) {
	f, dir := newFile(t)
	all, err := f.All()
	if err != nil || len(all) != 0 {
		t.Fatalf("All() = %v, %v", all, err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reading created %s: %v", dir, err)
	}
}

func TestSetThenReadFromAFreshFile(t *testing.T) {
	f, _ := newFile(t)
	if err := f.Set("theme", "dark"); err != nil {
		t.Fatal(err)
	}
	all, err := Open(f.path).All()
	if err != nil || all["theme"] != "dark" || len(all) != 1 {
		t.Fatalf("All() = %v, %v", all, err)
	}
}

func TestSecondFileSeesFirstWrite(t *testing.T) {
	first, _ := newFile(t)
	second := Open(first.path)
	if err := first.Set("theme", "light"); err != nil {
		t.Fatal(err)
	}
	if err := second.Set("gitna:inline-blame", "false"); err != nil {
		t.Fatal(err)
	}
	all, _ := first.All()
	if all["theme"] != "light" || all["gitna:inline-blame"] != "false" {
		t.Fatalf("All() = %v", all)
	}
}

func TestRejectsUnknownKeyAndWritesNothing(t *testing.T) {
	f, dir := newFile(t)
	if err := f.Set("other", "x"); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("Set error = %v", err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected Set created %s: %v", dir, err)
	}
}

func TestValueLengthLimit(t *testing.T) {
	f, _ := newFile(t)
	if err := f.Set("theme", strings.Repeat("x", 513)); !errors.Is(err, ErrValueTooLong) {
		t.Fatalf("513 bytes: %v", err)
	}
	if err := f.Set("theme", strings.Repeat("x", 512)); err != nil {
		t.Fatalf("512 bytes: %v", err)
	}
}

func TestFileModeIsPrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes")
	}
	f, _ := newFile(t)
	if err := f.Set("theme", "dark"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(f.path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, %v", info.Mode(), err)
	}
}

func TestUnknownKeysInTheFileAreDropped(t *testing.T) {
	f, dir := newFile(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.path, []byte(`{"theme":"dark","stray":"1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	all, err := f.All()
	if err != nil || len(all) != 1 || all["theme"] != "dark" {
		t.Fatalf("All() = %v, %v", all, err)
	}
}

func TestUnparseableFileReadsEmptyAndIsRepaired(t *testing.T) {
	f, dir := newFile(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.path, []byte(`{"theme":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if all, err := f.All(); err != nil || len(all) != 0 {
		t.Fatalf("All() = %v, %v", all, err)
	}
	if err := f.Set("theme", "dark"); err != nil {
		t.Fatal(err)
	}
	if all, _ := f.All(); all["theme"] != "dark" {
		t.Fatalf("All() = %v", all)
	}
}

func TestSetRemovesLeftoverTemporaryFiles(t *testing.T) {
	f, dir := newFile(t)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "preferences.json.tmp-123"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.Set("theme", "dark"); err != nil {
		t.Fatal(err)
	}
	assertDirectory(t, dir)
}

func TestDirectoryHoldsOnlyTheFileAndItsLock(t *testing.T) {
	f, dir := newFile(t)
	for i := range 3 {
		if err := f.Set("theme", strconv.Itoa(i)); err != nil {
			t.Fatal(err)
		}
	}
	assertDirectory(t, dir)
	info, err := os.Stat(filepath.Join(dir, "preferences.lock"))
	if err != nil || info.Size() != 0 {
		t.Fatalf("lock file: %v, %v", info, err)
	}
}

func assertDirectory(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"preferences.json", "preferences.lock"}) {
		t.Fatalf("directory holds %v", names)
	}
}

func TestConcurrentSetsOfDifferentKeysAreNotLost(t *testing.T) {
	path := filepath.Join(t.TempDir(), "preferences.json")
	keys := []string{"theme", "gitna:inline-blame"}
	var wg sync.WaitGroup
	for _, key := range keys {
		f := Open(path)
		wg.Go(func() {
			for i := range writesPerKey {
				if err := f.Set(key, strconv.Itoa(i)); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	wg.Wait()
	assertFinalValues(t, path, keys)
}

func TestSeparateProcessesDoNotLoseUpdates(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "preferences.json")
	keys := []string{"theme", "gitna:inline-blame"}
	commands := make([]*exec.Cmd, len(keys))
	outputs := make([]*strings.Builder, len(keys))
	for i, key := range keys {
		cmd := exec.Command(exe, "-test.run=^$")
		cmd.Env = append(os.Environ(), helperPathEnv+"="+path, helperKeyEnv+"="+key)
		outputs[i] = &strings.Builder{}
		cmd.Stdout, cmd.Stderr = outputs[i], outputs[i]
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		commands[i] = cmd
	}
	for i, cmd := range commands {
		if err := cmd.Wait(); err != nil {
			t.Fatalf("helper %d: %v\n%s", i, err, outputs[i])
		}
	}
	assertFinalValues(t, path, keys)
}

func assertFinalValues(t *testing.T, path string, keys []string) {
	t.Helper()
	all, err := Open(path).All()
	if err != nil {
		t.Fatal(err)
	}
	want := strconv.Itoa(writesPerKey - 1)
	for _, key := range keys {
		if all[key] != want {
			t.Errorf("%s = %q, want %q (all: %v)", key, all[key], want, all)
		}
	}
}
