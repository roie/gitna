package gitx

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ErrOutputLimit is returned when a Git command produces more output than the
// configured cap. The process is terminated rather than allowed to run away.
var ErrOutputLimit = errors.New("gitx: git output exceeds limit")

// Default output caps. Mutable via ExecRunner fields.
const (
	DefaultStdoutLimit = 64 << 20 // 64 MiB
	DefaultStderrLimit = 4 << 20  // 4 MiB
)

// Result is the outcome of a Git invocation.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// Runner executes Git commands against a repository.
type Runner interface {
	Run(ctx context.Context, repoRoot string, args ...string) (Result, error)
	// RunInput runs a Git command with stdin fed from the provided bytes.
	RunInput(ctx context.Context, repoRoot string, stdin []byte, args ...string) (Result, error)
}

// ExecRunner invokes a Git executable directly with exec.CommandContext.
// Arguments are passed verbatim; no shell is involved. Repository-routing Git
// variables are removed from the inherited environment so the selected folder
// remains authoritative. GIT_TERMINAL_PROMPT and GIT_OPTIONAL_LOCKS default to
// 0 so prompts cannot hang the server and snapshot reads do not contend with
// mutations for optional index refresh locks.
type ExecRunner struct {
	// Exec is the git binary. Empty means "git" from PATH. Overridable for
	// tests.
	Exec string
	// Env provides extra environment variables appended to the caller's
	// environment (after the runner defaults above). Nil means none.
	Env []string
	// StdoutLimit caps captured stdout. Zero means DefaultStdoutLimit.
	StdoutLimit int
	// StderrLimit caps captured stderr. Zero means DefaultStderrLimit.
	StderrLimit int
	// WaitDelay bounds waits for descendant processes that retain Git's output
	// pipes after Git exits. Zero means two seconds.
	WaitDelay time.Duration
}

func (r *ExecRunner) Run(ctx context.Context, repoRoot string, args ...string) (Result, error) {
	return r.run(ctx, repoRoot, nil, args...)
}

// RunInput runs Git with the given stdin payload, for commands that consume
// input from standard input (for example git apply or git commit -F -).
func (r *ExecRunner) RunInput(ctx context.Context, repoRoot string, stdin []byte, args ...string) (Result, error) {
	return r.run(ctx, repoRoot, stdin, args...)
}

// RunNUL streams NUL-delimited stdout records without retaining the complete
// command output in memory. The visitor must not retain the supplied slice.
func (r *ExecRunner) RunNUL(
	ctx context.Context,
	repoRoot string,
	visit func([]byte) error,
	args ...string,
) (Result, error) {
	exe := r.Exec
	if exe == "" {
		exe = "git"
	}
	stderrLimit := r.StderrLimit
	if stderrLimit <= 0 {
		stderrLimit = DefaultStderrLimit
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.WaitDelay = r.WaitDelay
	if cmd.WaitDelay <= 0 {
		cmd.WaitDelay = 2 * time.Second
	}
	cmd.Dir = repoRoot
	cmd.Env = r.environment()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, fmt.Errorf("gitx: open git stdout: %w", err)
	}
	stderr := &cappedBuffer{limit: stderrLimit, onOverflow: cancel}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return Result{}, fmt.Errorf("gitx: start git: %w", err)
	}
	reader := bufio.NewReader(stdout)
	var visitErr error
	for {
		record, readErr := reader.ReadBytes(0)
		if len(record) > 0 {
			if record[len(record)-1] == 0 {
				record = record[:len(record)-1]
			}
			if len(record) > 0 {
				if visitErr = visit(record); visitErr != nil {
					cancel()
					break
				}
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				visitErr = fmt.Errorf("gitx: read git stdout: %w", readErr)
			}
			break
		}
	}
	waitErr := cmd.Wait()
	if visitErr != nil {
		return Result{}, visitErr
	}
	if stderr.overflowed {
		return Result{ExitCode: -1}, ErrOutputLimit
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return Result{}, ctxErr
	}
	result := Result{Stderr: stderr.Bytes(), ExitCode: 0}
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			result.ExitCode = exitErr.ExitCode()
			return result, nil
		}
		return Result{}, fmt.Errorf("gitx: wait for git: %w", waitErr)
	}
	return result, nil
}

func (r *ExecRunner) run(ctx context.Context, repoRoot string, stdin []byte, args ...string) (Result, error) {
	exe := r.Exec
	if exe == "" {
		exe = "git"
	}
	stdoutLimit := r.StdoutLimit
	if stdoutLimit <= 0 {
		stdoutLimit = DefaultStdoutLimit
	}
	stderrLimit := r.StderrLimit
	if stderrLimit <= 0 {
		stderrLimit = DefaultStderrLimit
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.WaitDelay = r.WaitDelay
	if cmd.WaitDelay <= 0 {
		cmd.WaitDelay = 2 * time.Second
	}
	cmd.Dir = repoRoot
	cmd.Env = r.environment()
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}

	stdout := &cappedBuffer{limit: stdoutLimit, onOverflow: cancel}
	stderr := &cappedBuffer{limit: stderrLimit, onOverflow: cancel}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err := cmd.Run()
	if stdout.overflowed || stderr.overflowed {
		return Result{ExitCode: -1}, ErrOutputLimit
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return Result{}, ctxErr
	}

	res := Result{
		Stdout:   stdout.Bytes(),
		Stderr:   stderr.Bytes(),
		ExitCode: 0,
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			res.ExitCode = exitErr.ExitCode()
			return res, nil
		}
		return Result{}, fmt.Errorf("gitx: run git: %w", err)
	}
	return res, nil
}

var repositoryRoutingEnv = []string{
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_SHALLOW_FILE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
}

func (r *ExecRunner) environment() []string {
	env := os.Environ()
	for _, key := range repositoryRoutingEnv {
		env = filterKey(env, key)
	}
	// Snapshot reads can overlap mutations; prevent optional index refreshes
	// from taking index.lock.
	env = envWith(env, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	// Explicit runner values are intentional and therefore take precedence over
	// both sanitization and defaults.
	return envWith(env, r.Env...)
}

// envWith appends key=value pairs to env, replacing any pre-existing value for
// the same key while preserving the rest of the environment.
func envWith(env []string, pairs ...string) []string {
	out := append([]string{}, env...)
	for _, kv := range pairs {
		key := strings.SplitN(kv, "=", 2)[0]
		out = filterKey(out, key)
		out = append(out, kv)
	}
	return out
}

func filterKey(env []string, key string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		candidate, _, _ := strings.Cut(kv, "=")
		// Windows environment keys are case-insensitive. EqualFold is harmless
		// elsewhere and prevents mixed-case routing variables from surviving when
		// a Windows child process receives the environment.
		if !strings.EqualFold(candidate, key) {
			out = append(out, kv)
		}
	}
	return out
}

// cappedBuffer collects output up to a limit. On overflow it records the fact,
// cancels the owning command (killing the child), and swallows further input so
// the pipe drains and the process exits promptly.
type cappedBuffer struct {
	buf        bytes.Buffer
	limit      int
	overflowed bool
	onOverflow func()
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.overflowed {
		return len(p), nil
	}
	remaining := c.limit - c.buf.Len()
	if remaining <= 0 {
		c.overflow()
		return len(p), nil
	}
	if len(p) > remaining {
		_, _ = c.buf.Write(p[:remaining])
		c.overflow()
		return len(p), nil
	}
	return c.buf.Write(p)
}

func (c *cappedBuffer) overflow() {
	c.overflowed = true
	if c.onOverflow != nil {
		c.onOverflow()
	}
}

func (c *cappedBuffer) Bytes() []byte { return c.buf.Bytes() }
