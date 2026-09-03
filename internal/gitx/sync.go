package gitx

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// ErrNoUpstream is returned by Push when the current branch has no upstream
// branch. The caller can then offer `git push --set-upstream <remote> <branch>`
// after the user chooses the remote.
var ErrNoUpstream = errors.New("gitx: current branch has no upstream branch")

// ErrPushRejected is returned when the remote refuses a push, for example a
// non-fast-forward update. The client should fetch or pull before retrying.
var ErrPushRejected = errors.New("gitx: push rejected by remote")

func pushWasRejected(stdout []byte) bool {
	for _, line := range strings.Split(string(stdout), "\n") {
		if strings.HasPrefix(line, "!\t") {
			return true
		}
	}
	return false
}

// opError turns a failed git invocation into an error carrying git's output.
func opError(action string, res Result) error {
	msg := strings.TrimSpace(string(res.Stderr))
	if msg == "" {
		msg = strings.TrimSpace(string(res.Stdout))
	}
	if msg == "" {
		return fmt.Errorf("gitx: %s failed with exit code %d", action, res.ExitCode)
	}
	return fmt.Errorf("gitx: %s: %s", action, msg)
}

// Fetch downloads refs and objects from the configured remote, honoring the
// user's git config (fetch refspecs and hooks included).
func (r Repository) Fetch(ctx context.Context, runner Runner) error {
	res, err := runner.Run(ctx, r.Root, "fetch")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("fetch", res)
	}
	return nil
}

// Pull integrates remote changes into the current branch following the user's
// pull configuration (merge or rebase). A pull that hits conflicts leaves the
// repository in the corresponding operation state; the error carries git's
// output so the client can surface it.
func (r Repository) Pull(ctx context.Context, runner Runner) error {
	res, err := runner.Run(ctx, r.Root, "pull")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("pull", res)
	}
	return nil
}

// Push uploads the current branch to its upstream, honoring the user's push
// configuration. When the branch has no upstream, ErrNoUpstream is returned so
// the caller can offer to create one.
func (r Repository) Push(ctx context.Context, runner Runner) error {
	res, err := runner.Run(ctx, r.Root, "push", "--porcelain")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		upstream, upstreamErr := runner.Run(ctx, r.Root, "rev-parse", "--verify", "--quiet", "@{upstream}")
		if upstreamErr == nil && upstream.ExitCode != 0 {
			return ErrNoUpstream
		}
		if pushWasRejected(res.Stdout) {
			return ErrPushRejected
		}
		return opError("push", res)
	}
	return nil
}

// PushSetUpstream uploads branch to remote and records it as the branch's
// upstream so later plain pushes succeed.
func (r Repository) PushSetUpstream(ctx context.Context, runner Runner, remote, branch string) error {
	if err := r.validateRemote(ctx, runner, remote); err != nil {
		return err
	}
	if err := r.validateBranchName(ctx, runner, branch); err != nil {
		return err
	}
	if err := r.requireRef(ctx, runner, "refs/heads/"+branch); err != nil {
		return err
	}
	res, err := runner.Run(ctx, r.Root, "push", "--set-upstream", remote, branch)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return opError("push --set-upstream", res)
	}
	return nil
}
