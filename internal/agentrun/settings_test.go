package agentrun

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"testing"
)

func TestSettingsPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "conversations", "settings.json")
	file, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := file.Get(); len(got.Agents) != 0 {
		t.Fatalf("missing settings = %+v", got)
	}
	if _, err := os.Stat(filepath.Dir(path)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Open created directory: %v", err)
	}
	want := Settings{Agents: []Definition{{ID: "reviewer", Name: "Reviewer", Executable: "review", Args: []string{"--stdio"}}}}
	if err := file.Update(func(s *Settings) error { *s = want; return nil }); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get(); !reflect.DeepEqual(got, want) {
		t.Fatalf("settings = %+v", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", info.Mode())
	}
	denied := errors.New("rejected")
	if err := file.Update(func(s *Settings) error { s.Agents[0].Name = "Changed"; return denied }); !errors.Is(err, denied) {
		t.Fatal(err)
	}
	if got := file.Get(); !reflect.DeepEqual(got, want) {
		t.Fatalf("rejected update changed settings: %+v", got)
	}
}

func TestSettingsAreSharedBetweenProcesses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	a, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	add := func(f *SettingsFile, id string) {
		t.Helper()
		if err := f.Update(func(s *Settings) error { s.Agents = append(s.Agents, Definition{ID: id}); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	ids := func(f *SettingsFile) (out []string) {
		for _, d := range f.Get().Agents {
			out = append(out, d.ID)
		}
		return out
	}
	add(a, "x")
	if got := ids(b); !slices.Equal(got, []string{"x"}) {
		t.Fatalf("b sees %v", got)
	}
	add(b, "y")
	if got := ids(a); !slices.Equal(got, []string{"x", "y"}) {
		t.Fatalf("a sees %v", got)
	}
}
