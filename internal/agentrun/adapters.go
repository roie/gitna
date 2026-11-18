package agentrun

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
)

type archive struct {
	url    string
	sha256 string
	size   int64
}

// adapter is a pinned ACP adapter Gitna can install for a known agent whose
// vendor CLI is installed. Versions change only with Gitna.
type adapter struct {
	version  string
	archives map[string]archive
	npm      string
	size     int64
}

// adapters are keyed by program. Claude's archives, checksums and sizes come
// from the ACP registry (registry.json) and its GitHub release, 2026-11-17.
var adapters = map[string]adapter{
	"claude-agent-acp": {version: "0.108.0", archives: map[string]archive{
		"darwin/arm64":  {"https://github.com/agentclientprotocol/claude-agent-acp/releases/download/v0.108.0/claude-agent-acp-darwin-arm64.zip", "e0850a19689c14db31a71a655cfdd50d5e298dfdfe10e0ea6c16770508eea836", 198924579},
		"darwin/amd64":  {"https://github.com/agentclientprotocol/claude-agent-acp/releases/download/v0.108.0/claude-agent-acp-darwin-x64.zip", "b2d1d83bd6a21dbbb8c1eb07234ebf51cae64dbc76485947acf1fd7d6a9871d9", 209341593},
		"linux/arm64":   {"https://github.com/agentclientprotocol/claude-agent-acp/releases/download/v0.108.0/claude-agent-acp-linux-arm64.tar.gz", "969d747d0d662663e2aab56667be5819e2716890c2188e32672ac7ab4e47873f", 221731921},
		"linux/amd64":   {"https://github.com/agentclientprotocol/claude-agent-acp/releases/download/v0.108.0/claude-agent-acp-linux-x64.tar.gz", "30a744c1cba84c551beb418dfbccdff71f6e33e98c46d95727a00d1c45f7df69", 222391015},
		"windows/arm64": {"https://github.com/agentclientprotocol/claude-agent-acp/releases/download/v0.108.0/claude-agent-acp-windows-arm64.zip", "529a6dbd2921b0060d922a376737ea35dbf25a178f51064d04bc1260564fea6a", 221436593},
		"windows/amd64": {"https://github.com/agentclientprotocol/claude-agent-acp/releases/download/v0.108.0/claude-agent-acp-windows-x64.zip", "0b2e7079febace92156a7a2ede68f4faab1e343162b4b0d1ec855660515910ff", 232779663},
	}},
	"codex-acp": {version: "2.7.0", npm: "@agentclientprotocol/codex-acp@2.7.0", size: 480_000_000},
}

// Download describes an adapter install before the person confirms it.
type Download struct {
	Source       string `json:"source"`
	Version      string `json:"version"`
	Size         int64  `json:"size"`
	Folder       string `json:"folder"`
	RequiresNode bool   `json:"requiresNode"`
}

// Adapter is an installed adapter and the space it takes.
type Adapter struct {
	Program string `json:"program"`
	Folder  string `json:"folder"`
	Size    int64  `json:"size"`
}

var ErrRequiresNode = errors.New("requires Node.js")

var installing sync.Map

func platform() string { return runtime.GOOS + "/" + runtime.GOARCH }

func (a adapter) folder(dir, program string) string {
	return filepath.Join(dir, program, a.version)
}

func (a adapter) executable(dir, program string) string {
	folder, name := a.folder(dir, program), program
	if a.npm != "" {
		if runtime.GOOS == "windows" {
			name += ".cmd"
		}
		return filepath.Join(folder, "node_modules", ".bin", name)
	}
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(folder, name)
}

// download returns what installing program's adapter involves on this
// platform, or nil when Gitna has none for it.
func download(dir, program string) *Download {
	a, ok := adapters[program]
	if !ok || dir == "" {
		return nil
	}
	d := &Download{Version: a.version, Folder: a.folder(dir, program)}
	if a.npm != "" {
		_, err := exec.LookPath("npm")
		d.Source, d.Size, d.RequiresNode = "npm "+a.npm, a.size, err != nil
		return d
	}
	ar, ok := a.archives[platform()]
	if !ok {
		return nil
	}
	d.Source, d.Size = ar.url, ar.size
	return d
}

// installed returns the executable of program's adapter under dir, if any.
func installed(dir, program string) (string, bool) {
	a, ok := adapters[program]
	if !ok || dir == "" {
		return "", false
	}
	path := a.executable(dir, program)
	_, err := os.Stat(path)
	return path, err == nil
}

// Install downloads program's pinned adapter into dir and returns it as a
// found agent. progress receives whole percentages when the size is known.
// Nothing is left behind unless the adapter is complete and verified.
func Install(ctx context.Context, dir, program string, progress func(int)) (Found, error) {
	a, ok := adapters[program]
	if !ok {
		return Found{}, fmt.Errorf("no adapter for %s", program)
	}
	if _, busy := installing.LoadOrStore(program, true); busy {
		return Found{}, fmt.Errorf("%s is already being installed", program)
	}
	defer installing.Delete(program)
	found := func() (Found, error) { return adapterFound(dir, program), nil }
	if _, err := os.Stat(a.folder(dir, program)); err == nil {
		return found()
	}
	if err := os.MkdirAll(filepath.Join(dir, program), 0o700); err != nil {
		return Found{}, err
	}
	tmp, err := os.MkdirTemp(filepath.Join(dir, program), ".install-")
	if err != nil {
		return Found{}, err
	}
	defer os.RemoveAll(tmp)
	out := filepath.Join(tmp, "out")
	if a.npm != "" {
		err = installNPM(ctx, a.npm, out)
	} else if ar, ok := a.archives[platform()]; !ok {
		err = fmt.Errorf("no %s adapter for %s", program, platform())
	} else {
		err = fetch(ctx, ar, tmp, out, progress)
	}
	if err != nil {
		return Found{}, err
	}
	if err := os.Rename(out, a.folder(dir, program)); err != nil {
		return Found{}, err
	}
	return found()
}

func installNPM(ctx context.Context, pkg, out string) error {
	npm, err := exec.LookPath("npm")
	if err != nil {
		return ErrRequiresNode
	}
	cmd := exec.CommandContext(ctx, npm, "install", "--prefix", out, "--no-audit", "--no-fund", "--loglevel=error", pkg)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("npm install %s: %v: %s", pkg, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func fetch(ctx context.Context, ar archive, tmp, out string, progress func(int)) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ar.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "gitna")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: %s", ar.url, resp.Status)
	}
	name := filepath.Join(tmp, "archive")
	f, err := os.Create(name)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, hash, &counter{total: ar.size, report: progress}), io.LimitReader(resp.Body, ar.size+1))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != ar.sha256 {
		return fmt.Errorf("download %s: checksum mismatch", ar.url)
	}
	if strings.HasSuffix(ar.url, ".zip") {
		return unzip(name, out)
	}
	return untar(name, out)
}

type counter struct {
	total, done int64
	last        int
	report      func(int)
}

func (c *counter) Write(p []byte) (int, error) {
	c.done += int64(len(p))
	if c.report != nil && c.total > 0 {
		if pct := int(min(c.done*100/c.total, 100)); pct != c.last {
			c.last = pct
			c.report(pct)
		}
	}
	return len(p), nil
}

func target(out, name string) (string, error) {
	name = filepath.FromSlash(strings.TrimPrefix(name, "./"))
	if !filepath.IsLocal(name) {
		return "", fmt.Errorf("archive entry %q leaves the folder", name)
	}
	return filepath.Join(out, name), nil
}

func write(path string, mode fs.FileMode, r io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode.Perm()|0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

func untar(name, out string) error {
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return os.MkdirAll(out, 0o700)
		}
		if err != nil {
			return err
		}
		path, err := target(out, h.Name)
		if err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(path, 0o700)
		case tar.TypeReg:
			err = write(path, h.FileInfo().Mode(), tr)
		default:
			err = fmt.Errorf("archive entry %q is not a file", h.Name)
		}
		if err != nil {
			return err
		}
	}
}

func unzip(name, out string) error {
	z, err := zip.OpenReader(name)
	if err != nil {
		return err
	}
	defer z.Close()
	for _, e := range z.File {
		path, err := target(out, e.Name)
		if err != nil {
			return err
		}
		if e.FileInfo().IsDir() {
			if err := os.MkdirAll(path, 0o700); err != nil {
				return err
			}
			continue
		}
		if !e.Mode().IsRegular() {
			return fmt.Errorf("archive entry %q is not a file", e.Name)
		}
		r, err := e.Open()
		if err != nil {
			return err
		}
		err = write(path, e.Mode(), r)
		r.Close()
		if err != nil {
			return err
		}
	}
	return os.MkdirAll(out, 0o700)
}

// Adapters lists the adapters installed under dir.
func Adapters(dir string) []Adapter {
	out := []Adapter{}
	for program := range adapters {
		folder := filepath.Join(dir, program)
		if _, ok := installed(dir, program); !ok {
			continue
		}
		var size int64
		_ = filepath.WalkDir(folder, func(_ string, d fs.DirEntry, err error) error {
			if err == nil && d.Type().IsRegular() {
				if info, err := d.Info(); err == nil {
					size += info.Size()
				}
			}
			return nil
		})
		out = append(out, Adapter{Program: program, Folder: folder, Size: size})
	}
	return out
}

// RemoveAdapter deletes program's adapters under dir and forgets the
// definitions that run them.
func RemoveAdapter(dir, program string, settings *SettingsFile) error {
	if _, ok := adapters[program]; !ok {
		return fmt.Errorf("no adapter for %s", program)
	}
	folder := filepath.Join(dir, program)
	if err := settings.Update(func(s *Settings) error {
		s.Agents = slices.DeleteFunc(s.Agents, func(d Definition) bool { return within(folder, d.Executable) })
		return nil
	}); err != nil {
		return err
	}
	return os.RemoveAll(folder)
}

func within(folder, path string) bool {
	rel, err := filepath.Rel(folder, path)
	return err == nil && filepath.IsLocal(rel)
}

func adapterFound(dir, program string) Found {
	i := slices.IndexFunc(known, func(k knownAgent) bool { return k.program == program })
	path := adapters[program].executable(dir, program)
	return Found{Name: known[i].name, Command: `"` + path + `"`, Executable: path, Args: []string{}}
}
