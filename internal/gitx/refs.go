package gitx

import (
	"context"
	"fmt"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// validateRevision checks the transport-level safety of a Git revision
// expression. Git remains the authority for parsing extended revision syntax.
func validateRevision(value string) error {
	if value == "" || len(value) > 1024 {
		return fmt.Errorf("%w: empty or too long", protocol.ErrInvalidRef)
	}
	if value[0] == '-' || strings.IndexByte(value, 0) >= 0 {
		return fmt.Errorf("%w: option-like value or NUL byte", protocol.ErrInvalidRef)
	}
	// A revision parameter must resolve to one object. Range notation names a
	// set rather than one revision.
	if strings.Contains(value, "..") {
		return fmt.Errorf("%w: revision range is not a single object", protocol.ErrInvalidRef)
	}
	for _, r := range value {
		if r <= ' ' || r == '\u007f' {
			return fmt.Errorf("%w: whitespace or control character", protocol.ErrInvalidRef)
		}
	}
	return nil
}

func (r Repository) validateCommitRevision(ctx context.Context, runner Runner, value string) error {
	if err := validateRevision(value); err != nil {
		return err
	}
	res, err := runner.Run(ctx, r.Root, "rev-parse", "--verify", "--quiet", value+"^{commit}")
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("%w: revision is not a commit", protocol.ErrInvalidRef)
	}
	return nil
}

func (r Repository) validateLiteralRef(ctx context.Context, runner Runner, namespace, name string) error {
	if err := validateRevision(name); err != nil {
		return err
	}
	if strings.HasPrefix(name, "@{-") {
		return fmt.Errorf("%w: checkout shorthand is not a literal name", protocol.ErrInvalidRef)
	}
	candidate := namespace + name
	args := []string{"check-ref-format", candidate}
	if namespace == "refs/heads/" {
		args = []string{"check-ref-format", "--branch", name}
	}
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("%w: invalid literal name", protocol.ErrInvalidRef)
	}
	return nil
}

func (r Repository) validateBranchName(ctx context.Context, runner Runner, name string) error {
	return r.validateLiteralRef(ctx, runner, "refs/heads/", name)
}

func (r Repository) validateTagName(ctx context.Context, runner Runner, name string) error {
	return r.validateLiteralRef(ctx, runner, "refs/tags/", name)
}

func (r Repository) refExists(ctx context.Context, runner Runner, fullName string) (bool, error) {
	res, err := runner.Run(ctx, r.Root, "show-ref", "--verify", "--quiet", fullName)
	if err != nil {
		return false, err
	}
	switch res.ExitCode {
	case 0:
		return true, nil
	case 1:
		return false, nil
	default:
		return false, opError("verify ref", res)
	}
}

func (r Repository) requireRef(ctx context.Context, runner Runner, fullName string) error {
	exists, err := r.refExists(ctx, runner, fullName)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: reference does not exist", protocol.ErrInvalidRef)
	}
	return nil
}

func (r Repository) validateRemote(ctx context.Context, runner Runner, name string) error {
	if name == "" || len(name) > 256 || name[0] == '-' || strings.IndexByte(name, 0) >= 0 {
		return fmt.Errorf("%w: invalid remote name", protocol.ErrInvalidRef)
	}
	for _, char := range name {
		if char <= ' ' || char == '\u007f' {
			return fmt.Errorf("%w: invalid remote name", protocol.ErrInvalidRef)
		}
	}
	remotes, err := r.ListRemotes(ctx, runner)
	if err != nil {
		return err
	}
	for _, remote := range remotes {
		if remote == name {
			return nil
		}
	}
	return fmt.Errorf("%w: remote does not exist", protocol.ErrInvalidRef)
}
