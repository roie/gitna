package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/roie/gitna/internal/protocol"
)

// ErrTagExists is returned when creating a tag whose name is already taken.
var ErrTagExists = errors.New("gitx: tag already exists")

// ErrNoTag is returned when deleting a tag that does not exist.
var ErrNoTag = errors.New("gitx: no such tag")

// tagListFormat emits name, object, peeled object, and object type for each
// tag. Annotated tags have objecttype "tag" and a peeled commit; lightweight
// tags point directly at a commit with an empty peeled field.
const tagListFormat = "%(refname:short)%00%(objectname)%00%(*objectname)%00%(objecttype)"

// ListTags returns every tag with the commit it points at.
func (r Repository) ListTags(ctx context.Context, runner Runner) ([]protocol.Tag, error) {
	res, err := runner.Run(ctx, r.Root, "for-each-ref", "refs/tags", "--format="+tagListFormat)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, opError("tag list", res)
	}
	return parseTagList(res.Stdout)
}

// parseTagList splits the NUL-separated tag records. The peeled field of a
// lightweight tag is empty; git drops only trailing empty fields, so a
// lightweight tag still emits its (empty) peeled field before the type.
func parseTagList(raw []byte) ([]protocol.Tag, error) {
	var tags []protocol.Tag
	for _, rec := range bytes.Split(raw, []byte{'\n'}) {
		if len(bytes.TrimSpace(rec)) == 0 {
			continue
		}
		fields := bytes.Split(rec, []byte{0})
		if len(fields) != 4 {
			return nil, fmt.Errorf("gitx: malformed tag record %q", rec)
		}
		oid := string(fields[2])
		if oid == "" {
			oid = string(fields[1])
		}
		tags = append(tags, protocol.Tag{
			Name:      string(fields[0]),
			OID:       oid,
			Annotated: string(fields[3]) == "tag",
		})
	}
	return tags, nil
}

// CreateTag creates a tag at target (HEAD when empty). A non-empty message
// produces an annotated tag; otherwise the tag is lightweight. Tags are never
// pushed implicitly with a normal commit.
func (r Repository) CreateTag(ctx context.Context, runner Runner, name, target, message string) error {
	if err := validateRef(name); err != nil {
		return err
	}
	if target != "" {
		if err := validateRef(target); err != nil {
			return err
		}
	}
	args := []string{"tag"}
	if message != "" {
		args = append(args, "-a", name, "-m", message)
	} else {
		args = append(args, name)
	}
	if target != "" {
		args = append(args, target)
	}
	res, err := runner.Run(ctx, r.Root, args...)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if strings.Contains(string(res.Stderr), "already exists") {
			return ErrTagExists
		}
		return opError("create tag", res)
	}
	return nil
}

// DeleteTag removes a local tag.
func (r Repository) DeleteTag(ctx context.Context, runner Runner, name string) error {
	if err := validateRef(name); err != nil {
		return err
	}
	res, err := runner.Run(ctx, r.Root, "tag", "-d", name)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if strings.Contains(string(res.Stderr), "not found") {
			return ErrNoTag
		}
		return opError("delete tag", res)
	}
	return nil
}

// PushTag uploads the named tag to the remote, pushed explicitly by the user.
// The ref is spelled refs/tags/ so a branch of the same name is never selected.
func (r Repository) PushTag(ctx context.Context, runner Runner, remote, name string) error {
	if err := validateRef(remote); err != nil {
		return err
	}
	if err := validateRef(name); err != nil {
		return err
	}
	res, err := runner.Run(ctx, r.Root, "push", remote, "refs/tags/"+name)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		if strings.Contains(string(res.Stderr), "[rejected]") {
			return ErrPushRejected
		}
		return opError("push tag", res)
	}
	return nil
}
