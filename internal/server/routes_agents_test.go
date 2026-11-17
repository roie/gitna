package server

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/roie/gitna/internal/agentrun"
	"github.com/roie/gitna/internal/prefs"
)

func TestConversationSettings(t *testing.T) {
	f := newConversationFixture(t)
	state := t.TempDir()
	settings, err := agentrun.Open(filepath.Join(state, "conversations", "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	preferences := prefs.Open(filepath.Join(state, "preferences.json"))
	f.backend.Settings = settings
	f.backend.Enabled = func() bool { all, err := preferences.All(); return err == nil && all["gitna:conversations"] == "true" }
	bin := t.TempDir()
	goose := filepath.Join(bin, "goose")
	if runtime.GOOS == "windows" {
		goose += ".exe"
	}
	if err := os.WriteFile(goose, nil, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	for _, enabled := range []bool{false, true} {
		if enabled {
			if err := preferences.Set("gitna:conversations", "true"); err != nil {
				t.Fatal(err)
			}
		}
		rec := f.browserDo(t, http.MethodGet, "/conversations/settings", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("settings = %d %s", rec.Code, rec.Body)
		}
		got := decodeBody[struct {
			Enabled   bool
			Agents    []agentrun.Definition
			Available []agentrun.Found
		}](t, rec)
		if got.Enabled != enabled || got.Agents == nil || len(got.Agents) != 0 || got.Available == nil {
			t.Fatalf("settings = %+v", got)
		}
		if found := len(got.Available) == 1 && got.Available[0].Command == "goose acp"; found != enabled {
			t.Fatalf("available = %+v", got.Available)
		}
	}
	if rec := f.agentDo(t, http.MethodGet, "/conversations/settings", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("agent settings = %d %s", rec.Code, rec.Body)
	}
}
