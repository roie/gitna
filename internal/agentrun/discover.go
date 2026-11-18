package agentrun

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// known lists agents by the program their installer puts on PATH, the
// arguments the ACP registry starts them with, and how to install them:
// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
// An adapter names the vendor CLI it wraps, so a missing adapter can be told
// apart from a missing agent.
type knownAgent struct {
	name    string
	program string
	args    []string
	adapts  string
	install string
	website string
}

var known = []knownAgent{
	{"Claude Agent", "claude-agent-acp", nil, "claude", "npm install -g @agentclientprotocol/claude-agent-acp", "https://github.com/agentclientprotocol/claude-agent-acp"},
	{"Codex", "codex-acp", nil, "codex", "npm install -g @agentclientprotocol/codex-acp", "https://github.com/agentclientprotocol/codex-acp"},
	{"Cursor", "cursor-agent", []string{"acp"}, "", "", "https://cursor.com/docs/cli/acp"},
	{"Gemini CLI", "gemini", []string{"--acp"}, "", "npm install -g @google/gemini-cli", "https://geminicli.com"},
	{"GitHub Copilot", "copilot", []string{"--acp"}, "", "npm install -g @github/copilot", "https://github.com/features/copilot/cli/"},
	{"goose", "goose", []string{"acp"}, "", "", "https://block.github.io/goose/"},
	{"OpenCode", "opencode", []string{"acp"}, "", "", "https://opencode.ai"},
	{"Qwen Code", "qwen", []string{"--acp"}, "", "npm install -g @qwen-code/qwen-code", "https://qwenlm.github.io/qwen-code-docs/en/users/overview"},
}

type Found struct {
	Name       string   `json:"name"`
	Command    string   `json:"command"`
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
}

// Setup tells the user how to install a known agent that is not on PATH.
// AdapterMissing means the vendor CLI is installed but its ACP adapter is not.
type Setup struct {
	Name           string    `json:"name"`
	Command        string    `json:"command"`
	Install        string    `json:"install"`
	Website        string    `json:"website"`
	AdapterMissing bool      `json:"adapterMissing"`
	Program        string    `json:"program"`
	Download       *Download `json:"download,omitempty"`
}

// Discover returns the known agents found on PATH or among the adapters
// installed under adapterDir that saved does not already define, and setup
// guidance for the rest. It only reads directories and starts no process.
// Each PATH directory is listed once, because probing every program and
// extension separately takes hundreds of milliseconds on Windows and WSL
// drives.
func Discover(saved []Definition, adapterDir string) ([]Found, []Setup) {
	names := pathNames()
	found, setup := []Found{}, []Setup{}
	for _, k := range known {
		args := slices.Clone(k.args)
		if args == nil {
			args = []string{}
		}
		command := strings.Join(append([]string{k.program}, args...), " ")
		path, err := "", exec.ErrNotFound
		if names[k.program] {
			path, err = exec.LookPath(k.program)
		}
		if err == nil {
			path, err = filepath.Abs(path)
		}
		if adapter, ok := installed(adapterDir, k.program); err != nil && ok {
			path, err, command = adapter, nil, adapterFound(adapterDir, k.program).Command
		}
		if err != nil {
			adapterMissing := k.adapts != "" && names[k.adapts]
			s := Setup{Name: k.name, Command: command, Install: k.install, Website: k.website, AdapterMissing: adapterMissing, Program: k.program}
			if adapterMissing {
				s.Download = download(adapterDir, k.program)
			}
			setup = append(setup, s)
			continue
		}
		if slices.ContainsFunc(saved, func(d Definition) bool {
			return strings.EqualFold(d.Executable, path) && slices.Equal(d.Args, args)
		}) {
			continue
		}
		found = append(found, Found{Name: k.name, Command: command, Executable: path, Args: args})
	}
	return found, setup
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
