package gitx

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// maxCommitMessageBytes bounds commit messages accepted from the client.
const maxCommitMessageBytes = 64 << 10 // 64 KiB

// ErrCommitMessageTooLarge is returned when a commit message exceeds the
// accepted size, before any git invocation.
var ErrCommitMessageTooLarge = errors.New("gitx: commit message exceeds limit")

// CommitError carries git's output when git commit exits non-zero, for example
// when a hook rejects the commit. The output is relayed to the browser so the
// user sees the hook's reason instead of a generic failure.
type CommitError struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

func (e *CommitError) Error() string {
	if msg := strings.TrimSpace(e.Stderr); msg != "" {
		return msg
	}
	return fmt.Sprintf("gitx: commit failed with exit code %d", e.ExitCode)
}

// Commit creates a commit from the staged index with the given message, or
// amends HEAD when amend is true. The message is fed to git on stdin
// (git commit --file=-) so neither shell quoting nor command-line length
// limits apply. Hooks run untouched: a hook that rejects the commit surfaces
// as a *CommitError carrying git's exit code and output.
func (r Repository) Commit(ctx context.Context, runner Runner, message string, amend bool) (Result, error) {
	if len(message) > maxCommitMessageBytes {
		return Result{}, ErrCommitMessageTooLarge
	}
	args := []string{"commit", "--file=-"}
	if amend {
		args = append(args, "--amend")
	}
	res, err := runner.RunInput(ctx, r.Root, []byte(message), args...)
	if err != nil {
		return res, err
	}
	if res.ExitCode != 0 {
		return res, &CommitError{
			ExitCode: res.ExitCode,
			Stdout:   string(res.Stdout),
			Stderr:   string(res.Stderr),
		}
	}
	return res, nil
}
