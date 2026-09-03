package gitx

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// DefaultDiffBytes caps the content of a single diff side. Anything larger is
// reported as too large instead of being shipped to the browser.
const DefaultDiffBytes = 512 << 10

// MaxImageBytes allows practical raster previews without applying the larger
// allowance to text diffs or arbitrary binary files.
const MaxImageBytes = 4 << 20

// maxPatchOutputBytes bounds the unified diff patch shipped for hunk
// operations. A patch is roughly the change plus context, so this stays a
// small multiple of the per-side content cap.
const maxPatchOutputBytes = 4 * DefaultDiffBytes

// Diff resolves the before/after content for one changed file in the requested
// scope. Tracked versions come from Git blobs so the comparison is independent
// of worktree races; the untracked/worktree side is read from disk with an
// explicit byte limit after confirming the path stays inside the repository
// root. No external diff or textconv programs are executed.
func (r Repository) Diff(ctx context.Context, runner Runner, scope protocol.DiffScope, opts protocol.DiffOptions) (protocol.FileDiff, error) {
	return r.diff(ctx, runner, scope, opts, true)
}

func (r Repository) reviewDiff(ctx context.Context, runner Runner, scope protocol.DiffScope, opts protocol.DiffOptions) (protocol.FileDiff, error) {
	return r.diff(ctx, runner, scope, opts, false)
}

func (r Repository) diff(ctx context.Context, runner Runner, scope protocol.DiffScope, opts protocol.DiffOptions, includePatch bool) (protocol.FileDiff, error) {
	if err := validatePath(opts.Path); err != nil {
		return protocol.FileDiff{}, err
	}
	if opts.OldPath != "" {
		if err := validatePath(opts.OldPath); err != nil {
			return protocol.FileDiff{}, err
		}
	}

	fromPath := opts.Path
	if opts.OldPath != "" {
		fromPath = opts.OldPath
	}

	var (
		beforeRaw, afterRaw []byte
		beforePresent       bool
		afterPresent        bool
		tooLarge            bool
		err                 error
	)

	switch scope {
	case protocol.DiffUnstaged:
		beforeRaw, beforePresent, err = r.readBlob(ctx, runner, ":0:"+fromPath)
		if err != nil {
			return protocol.FileDiff{}, err
		}
		afterRaw, tooLarge, afterPresent, err = r.readWorktree(opts.Path, MaxImageBytes)
		if err != nil {
			return protocol.FileDiff{}, err
		}
	case protocol.DiffStaged:
		beforeRaw, beforePresent, err = r.readBlob(ctx, runner, "HEAD:"+fromPath)
		if err != nil {
			return protocol.FileDiff{}, err
		}
		afterRaw, afterPresent, err = r.readBlob(ctx, runner, ":0:"+opts.Path)
		if err != nil {
			return protocol.FileDiff{}, err
		}
	case protocol.DiffCommit:
		if err := r.validateCommitRevision(ctx, runner, opts.Commit); err != nil {
			return protocol.FileDiff{}, err
		}
		beforeRaw, beforePresent, err = r.readBlob(ctx, runner, opts.Commit+"^:"+fromPath)
		if err != nil {
			return protocol.FileDiff{}, err
		}
		afterRaw, afterPresent, err = r.readBlob(ctx, runner, opts.Commit+":"+opts.Path)
		if err != nil {
			return protocol.FileDiff{}, err
		}
	case protocol.DiffCompare:
		if err := r.validateCommitRevision(ctx, runner, opts.CompareFrom); err != nil {
			return protocol.FileDiff{}, err
		}
		if err := r.validateCommitRevision(ctx, runner, opts.CompareTo); err != nil {
			return protocol.FileDiff{}, err
		}
		beforeRaw, beforePresent, err = r.readBlob(ctx, runner, opts.CompareFrom+":"+fromPath)
		if err != nil {
			return protocol.FileDiff{}, err
		}
		afterRaw, afterPresent, err = r.readBlob(ctx, runner, opts.CompareTo+":"+opts.Path)
		if err != nil {
			return protocol.FileDiff{}, err
		}
	case protocol.DiffConflict:
		// Conflict diff shows ours (stage 2) vs theirs (stage 3).
		if err := validatePath(opts.Path); err != nil {
			return protocol.FileDiff{}, err
		}
		beforeRaw, beforePresent, err = r.readBlob(ctx, runner, ":2:"+fromPath)
		if err != nil {
			return protocol.FileDiff{}, err
		}
		afterRaw, afterPresent, err = r.readBlob(ctx, runner, ":3:"+opts.Path)
		if err != nil {
			return protocol.FileDiff{}, err
		}
	default:
		return protocol.FileDiff{}, fmt.Errorf("gitx: unknown diff scope %q", scope)
	}

	if len(beforeRaw) > MaxImageBytes {
		beforeRaw = nil
		tooLarge = true
	}
	if len(afterRaw) > MaxImageBytes {
		afterRaw = nil
		tooLarge = true
	}

	fd := protocol.FileDiff{
		Before:   protocol.FileVersion{Path: fromPath, Language: languageFor(fromPath)},
		After:    protocol.FileVersion{Path: opts.Path, Language: languageFor(opts.Path)},
		TooLarge: tooLarge,
	}
	if !tooLarge {
		beforeImage := rasterImageContent(beforeRaw)
		afterImage := rasterImageContent(afterRaw)
		allPresentSidesAreImages := (!beforePresent || beforeImage != nil) && (!afterPresent || afterImage != nil)
		if allPresentSidesAreImages && (beforeImage != nil || afterImage != nil) {
			fd.Binary = true
			fd.Before.Image = beforeImage
			fd.After.Image = afterImage
			return fd, nil
		}
	}
	if len(beforeRaw) > DefaultDiffBytes {
		beforeRaw = nil
		fd.TooLarge = true
	}
	if len(afterRaw) > DefaultDiffBytes {
		afterRaw = nil
		fd.TooLarge = true
	}
	if isBinary(beforeRaw) || isBinary(afterRaw) {
		fd.Binary = true
		return fd, nil
	}
	if beforePresent {
		fd.Before.Content = string(beforeRaw)
	}
	if afterPresent {
		fd.After.Content = string(afterRaw)
	}
	if includePatch && !fd.TooLarge && (scope == protocol.DiffUnstaged || scope == protocol.DiffStaged) && opts.OldPath == "" {
		patch, err := r.diffPatch(ctx, runner, scope == protocol.DiffStaged, opts.Path)
		if err != nil {
			return protocol.FileDiff{}, err
		}
		fd.Patch = patch
	}
	return fd, nil
}

// diffPatch returns the exact unified diff Git shows for the file in the given
// index surface so partial staging can feed the same patch back through git
// apply. Color, external diff programs, and pager configuration are disabled;
// empty or oversized output returns an empty patch (hunk operations
// unavailable) rather than shipping megabytes to the browser.
func (r Repository) diffPatch(ctx context.Context, runner Runner, cached bool, path string) (string, error) {
	args := []string{"-c", "diff.color=never", "diff", "--no-ext-diff", "--no-textconv"}
	if cached {
		args = append(args, "--cached")
	}
	args = append(args, "--", path)
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 || len(res.Stdout) == 0 || len(res.Stdout) > maxPatchOutputBytes {
		return "", nil
	}
	return string(res.Stdout), nil
}

// readBlob returns a blob's content from the given treeish:path expression.
// A missing object (the path does not exist in that tree, or the parent of a
// root commit) reports present=false without an error.
func (r Repository) readBlob(ctx context.Context, runner Runner, treeish string) ([]byte, bool, error) {
	res, err := runner.Run(ctx, r.Root, "cat-file", "-s", treeish)
	if err != nil {
		return nil, false, err
	}
	if res.ExitCode != 0 {
		return nil, false, nil
	}
	res, err = runner.Run(ctx, r.Root, "cat-file", "blob", treeish)
	if err != nil {
		return nil, false, err
	}
	if res.ExitCode != 0 {
		return nil, false, nil
	}
	return res.Stdout, true, nil
}

// readWorktree reads a repository-relative worktree file with a byte limit,
// resolving symlinks first so a link cannot escape the repository root. A
// missing file reports present=false; an oversized file reports tooLarge=true.
func (r Repository) readWorktree(path string, maxBytes int) ([]byte, bool, bool, error) {
	rootReal, err := filepath.EvalSymlinks(r.Root)
	if err != nil {
		rootReal = r.Root
	}
	full := filepath.Join(rootReal, path)
	if !withinRoot(rootReal, full) {
		return nil, false, false, fmt.Errorf("%w: %q", protocol.ErrNotInRepo, path)
	}
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		return nil, false, false, nil
	}
	if !withinRoot(rootReal, real) {
		return nil, false, false, fmt.Errorf("%w: %q", protocol.ErrNotInRepo, path)
	}
	st, err := os.Stat(real)
	if err != nil {
		return nil, false, false, nil
	}
	if !st.Mode().IsRegular() {
		return nil, false, true, nil
	}
	if st.Size() > int64(maxBytes) {
		return nil, true, true, nil
	}
	f, err := os.Open(real)
	if err != nil {
		return nil, false, false, nil
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, int64(maxBytes+1)))
	if err != nil {
		return nil, false, false, fmt.Errorf("gitx: read worktree file %q: %w", path, err)
	}
	if len(data) > maxBytes {
		return nil, true, true, nil
	}
	return data, false, true, nil
}

func withinRoot(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// validatePath rejects anything that is not a canonical repository-relative
// git path. Paths are produced by git status, but the API must not trust them.
func validatePath(p string) error {
	if p == "" {
		return fmt.Errorf("%w: empty path", protocol.ErrInvalidPath)
	}
	if strings.IndexByte(p, 0) >= 0 {
		return fmt.Errorf("%w: NUL byte", protocol.ErrInvalidPath)
	}
	if filepath.IsAbs(p) {
		return fmt.Errorf("%w: absolute path %q", protocol.ErrInvalidPath, p)
	}
	for _, part := range strings.Split(p, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("%w: non-canonical path %q", protocol.ErrInvalidPath, p)
		}
	}
	return nil
}

func rasterImageContent(data []byte) *protocol.ImageContent {
	if len(data) == 0 {
		return nil
	}
	mimeType := http.DetectContentType(data)
	switch mimeType {
	case "image/gif", "image/jpeg", "image/png", "image/webp":
		return &protocol.ImageContent{
			MIME: mimeType,
			Data: base64.StdEncoding.EncodeToString(data),
			Size: len(data),
		}
	default:
		return nil
	}
}

func isBinary(data []byte) bool {
	n := len(data)
	if n > 8000 {
		n = 8000
	}
	return bytes.IndexByte(data[:n], 0) >= 0
}

// languageFor maps a file extension to a Shiki-compatible language id. The
// frontend may also infer the language from the filename; this is provided as
// an explicit hint for ambiguous extensions.
func languageFor(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".ts", ".mts", ".cts":
		return "typescript"
	case ".tsx":
		return "tsx"
	case ".js", ".mjs", ".cjs":
		return "javascript"
	case ".jsx":
		return "jsx"
	case ".json":
		return "json"
	case ".html", ".htm":
		return "html"
	case ".css":
		return "css"
	case ".scss", ".sass":
		return "scss"
	case ".svelte":
		return "svelte"
	case ".vue":
		return "vue"
	case ".go":
		return "go"
	case ".rs":
		return "rust"
	case ".py":
		return "python"
	case ".md", ".markdown":
		return "markdown"
	case ".yaml", ".yml":
		return "yaml"
	case ".toml":
		return "toml"
	case ".sh", ".bash", ".zsh":
		return "shellscript"
	case ".sql":
		return "sql"
	case ".xml":
		return "xml"
	case ".java":
		return "java"
	case ".kt", ".kts":
		return "kotlin"
	case ".swift":
		return "swift"
	case ".c", ".h":
		return "c"
	case ".cpp", ".hpp", ".cc", ".cxx":
		return "cpp"
	case ".cs":
		return "csharp"
	case ".rb":
		return "ruby"
	case ".php":
		return "php"
	case ".dart":
		return "dart"
	case ".zig":
		return "zig"
	case ".lua":
		return "lua"
	default:
		return ""
	}
}
