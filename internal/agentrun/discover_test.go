package agentrun

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"testing"
)

// writeProgram writes an npm-style wrapper named program into dir: a shell
// script, or a .cmd batch file on Windows.
func writeProgram(t *testing.T, dir, program, unix, windows string) string {
	t.Helper()
	path, body := filepath.Join(dir, program), "#!/bin/sh\n"+unix+"\n"
	if runtime.GOOS == "windows" {
		path, body = path+".cmd", "@"+windows+"\r\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDiscoverFindsKnownAgentsWithoutRunningThem(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(t.TempDir(), "ran")
	opencode := writeProgram(t, dir, "opencode", "echo ran > '"+marker+"'", `echo ran> "`+marker+`"`)
	codex := writeProgram(t, dir, "codex-acp", "echo ran > '"+marker+"'", `echo ran> "`+marker+`"`)
	writeProgram(t, dir, "claude", "echo ran > '"+marker+"'", `echo ran> "`+marker+`"`)
	t.Setenv("PATH", dir)
	found, setup := Discover(nil, "")
	want := []Found{
		{Name: "Codex", Command: "codex-acp", Executable: codex, Args: []string{}},
		{Name: "OpenCode", Command: "opencode acp", Executable: opencode, Args: []string{"acp"}},
	}
	if !reflect.DeepEqual(found, want) {
		t.Fatalf("found %+v, want %+v", found, want)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("discovery ran a program: %v", err)
	}
	if len(setup) != len(known)-2 || setup[0] != (Setup{Name: "Claude Agent", Command: "claude-agent-acp", Install: "npm install -g @agentclientprotocol/claude-agent-acp", Website: "https://github.com/agentclientprotocol/claude-agent-acp", AdapterMissing: true, Program: "claude-agent-acp"}) {
		t.Fatalf("setup %+v", setup)
	}
	for _, s := range setup[1:] {
		if s.AdapterMissing || s.Website == "" {
			t.Fatalf("setup entry %+v", s)
		}
	}
	saved := []Definition{{ID: "x", Name: "Mine", Executable: opencode, Args: []string{"acp"}}}
	if found, setup := Discover(saved, ""); len(found) != 1 || found[0].Name != "Codex" || len(setup) != len(known)-2 {
		t.Fatalf("with a saved definition: %+v %+v", found, setup)
	}
	t.Setenv("PATH", t.TempDir())
	if found, setup := Discover(nil, ""); len(found) != 0 || len(setup) != len(known) || setup[0].AdapterMissing {
		t.Fatalf("empty PATH: %+v %+v", found, setup)
	}
}

func TestDiscoveredWrapperRunsThroughTheTransport(t *testing.T) {
	t.Setenv("GITNA_FAKE_AGENT", "1")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	wrapper := writeProgram(t, dir, "opencode", `exec "`+exe+`" "$@"`, `"`+exe+`" %*`)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	all, _ := Discover(nil, "")
	i := slices.IndexFunc(all, func(f Found) bool { return f.Executable == wrapper })
	if i < 0 {
		t.Fatalf("wrapper not found: %+v", all)
	}
	found := all[i]
	def, err := Resolve(found.Name, found.Command)
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(t.Context(), def, t.TempDir(), ""); err != nil {
		t.Fatal(err)
	}
	reply, err := Run(t.Context(), def, t.TempDir(), "Question", Hooks{})
	if err != nil || reply != "Hello." {
		t.Fatalf("reply=%q err=%v", reply, err)
	}
	def.Args = []string{"child"}
	assertCancelStopsTheProcessTree(t, def)
}
