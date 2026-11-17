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
	t.Setenv("PATH", dir)
	found := Discover(nil)
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
	saved := []Definition{{ID: "x", Name: "Mine", Executable: opencode, Args: []string{"acp"}}}
	if found := Discover(saved); len(found) != 1 || found[0].Name != "Codex" {
		t.Fatalf("with a saved definition: %+v", found)
	}
	t.Setenv("PATH", t.TempDir())
	if found := Discover(nil); len(found) != 0 {
		t.Fatalf("empty PATH: %+v", found)
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
	i := slices.IndexFunc(Discover(nil), func(f Found) bool { return f.Executable == wrapper })
	if i < 0 {
		t.Fatalf("wrapper not found: %+v", Discover(nil))
	}
	found := Discover(nil)[i]
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
