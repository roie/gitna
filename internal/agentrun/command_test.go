package agentrun

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestSplitCommand(t *testing.T) {
	for _, tc := range []struct {
		line string
		want []string
	}{
		{"agent --acp", []string{"agent", "--acp"}},
		{`'/a path/agent' "two words"`, []string{"/a path/agent", "two words"}},
		{`"C:\Program Files\a\agent.exe" --acp`, []string{`C:\Program Files\a\agent.exe`, "--acp"}},
		{`agent a\b`, []string{"agent", `a\b`}},
		{`agent "" 'x'`, []string{"agent", "", "x"}},
		{" \t agent\n--acp \t", []string{"agent", "--acp"}},
		{`agent pre"two words"post`, []string{"agent", "pretwo wordspost"}},
		{"", nil},
		{" \t ", nil},
		{`agent "unclosed`, nil},
		{`agent 'unclosed`, nil},
	} {
		t.Run(tc.line, func(t *testing.T) {
			got, err := SplitCommand(tc.line)
			if tc.want == nil {
				if err == nil {
					t.Fatalf("accepted %q: %v", tc.line, got)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestResolve(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	name := "test-agent"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	def, err := Resolve("  Helper  ", name+" --acp 'two words'")
	if err != nil {
		t.Fatal(err)
	}
	if def.ID == "" || def.Name != "Helper" || def.Executable != path || !filepath.IsAbs(def.Executable) || !reflect.DeepEqual(def.Args, []string{"--acp", "two words"}) {
		t.Fatalf("definition: %+v", def)
	}
	again, err := Resolve("Helper", name)
	if err != nil || again.ID == def.ID {
		t.Fatalf("new definition: %+v, %v", again, err)
	}
	if _, err := Resolve("Helper", "missing-agent --acp"); err == nil || !strings.Contains(err.Error(), "missing-agent was not found on PATH") {
		t.Fatalf("missing program: %v", err)
	}
	for _, tc := range []struct{ name, command string }{
		{"Helper", "missing-agent"},
		{"", name},
		{"  ", name},
		{strings.Repeat("x", 129), name},
		{"Helper", ""},
		{"Helper", `""`},
	} {
		if _, err := Resolve(tc.name, tc.command); err == nil {
			t.Fatalf("accepted name=%q command=%q", tc.name, tc.command)
		}
	}
}
