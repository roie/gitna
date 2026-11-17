package agentrun

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// known lists agents by the program their installer puts on PATH and the
// arguments the ACP registry starts them with:
// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
var known = []struct {
	name    string
	program string
	args    []string
}{
	{"Claude Agent", "claude-agent-acp", nil},
	{"Codex", "codex-acp", nil},
	{"Cursor", "cursor-agent", []string{"acp"}},
	{"Gemini CLI", "gemini", []string{"--acp"}},
	{"GitHub Copilot", "copilot", []string{"--acp"}},
	{"goose", "goose", []string{"acp"}},
	{"OpenCode", "opencode", []string{"acp"}},
	{"Qwen Code", "qwen", []string{"--acp"}},
}

type Found struct {
	Name       string   `json:"name"`
	Command    string   `json:"command"`
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
}

// Discover returns the known agents found on PATH that saved does not already
// define. It only reads directories and starts no process. Each PATH directory
// is listed once, because probing every program and extension separately takes
// hundreds of milliseconds on Windows and WSL drives.
func Discover(saved []Definition) []Found {
	names := pathNames()
	found := []Found{}
	for _, k := range known {
		if !names[k.program] {
			continue
		}
		path, err := exec.LookPath(k.program)
		if err != nil {
			continue
		}
		if path, err = filepath.Abs(path); err != nil {
			continue
		}
		args := slices.Clone(k.args)
		if args == nil {
			args = []string{}
		}
		if slices.ContainsFunc(saved, func(d Definition) bool {
			return strings.EqualFold(d.Executable, path) && slices.Equal(d.Args, args)
		}) {
			continue
		}
		command := strings.Join(append([]string{k.program}, args...), " ")
		found = append(found, Found{Name: k.name, Command: command, Executable: path, Args: args})
	}
	return found
}

// pathNames returns the lowercase file names on PATH, with and without their
// extension, so Windows programs match without PATHEXT probing.
func pathNames() map[string]bool {
	names := map[string]bool{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		wg.Go(func() {
			entries, err := os.ReadDir(dir)
			if err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, e := range entries {
				name := strings.ToLower(e.Name())
				names[name] = true
				names[strings.TrimSuffix(name, filepath.Ext(name))] = true
			}
		})
	}
	wg.Wait()
	return names
}
