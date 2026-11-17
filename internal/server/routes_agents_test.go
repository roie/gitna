package server

import (
	"net/http"
	"path/filepath"
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
			Enabled bool
			Agents  []agentrun.Definition
		}](t, rec)
		if got.Enabled != enabled || got.Agents == nil || len(got.Agents) != 0 {
			t.Fatalf("settings = %+v", got)
		}
	}
	if rec := f.agentDo(t, http.MethodGet, "/conversations/settings", "", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("agent settings = %d %s", rec.Code, rec.Body)
	}
}
