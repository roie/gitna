package gitx

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/roie/gitna/internal/protocol"
)

func TestParseTagList(t *testing.T) {
	raw := []byte("v1\x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x00tag\n" +
		"light\x00cccccccccccccccccccccccccccccccccccccccc\x00\x00commit\n")
	got, err := parseTagList(raw)
	if err != nil {
		t.Fatalf("parseTagList: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].Name != "v1" || got[0].OID != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" || !got[0].Annotated {
		t.Fatalf("v1 = %+v, want annotated pointing at peeled commit", got[0])
	}
	if got[1].Name != "light" || got[1].OID != "cccccccccccccccccccccccccccccccccccccccc" || got[1].Annotated {
		t.Fatalf("light = %+v, want lightweight pointing at its own oid", got[1])
	}
}

func TestCreateListDeleteTag(t *testing.T) {
	root := initTestRepo(t)
	writeFile(t, filepath.Join(root, "a.txt"), "one\n")
	runGit(t, root, "add", "a.txt")
	runGit(t, root, "commit", "-qm", "a")
	oid := strings.TrimSpace(runGit(t, root, "rev-parse", "HEAD"))

	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}
	ctx := context.Background()

	if err := repo.CreateTag(ctx, runner, "v1", "", "release one"); err != nil {
		t.Fatalf("CreateTag(annotated): %v", err)
	}
	if err := repo.CreateTag(ctx, runner, "light", oid, ""); err != nil {
		t.Fatalf("CreateTag(lightweight): %v", err)
	}
	if err := repo.CreateTag(ctx, runner, "v1", "", ""); !errors.Is(err, ErrTagExists) {
		t.Fatalf("CreateTag(duplicate) = %v, want ErrTagExists", err)
	}

	tags, err := repo.ListTags(ctx, runner)
	if err != nil {
		t.Fatalf("ListTags: %v", err)
	}
	if len(tags) != 2 {
		t.Fatalf("tags = %d, want 2", len(tags))
	}
	byName := map[string]protocol.Tag{}
	for _, tag := range tags {
		byName[tag.Name] = tag
	}
	if tag := byName["v1"]; tag.OID != oid || !tag.Annotated {
		t.Fatalf("v1 = %+v, want annotated at %s", tag, oid)
	}
	if tag := byName["light"]; tag.OID != oid || tag.Annotated {
		t.Fatalf("light = %+v, want lightweight at %s", tag, oid)
	}

	if err := repo.DeleteTag(ctx, runner, "light"); err != nil {
		t.Fatalf("DeleteTag: %v", err)
	}
	if tags, err := repo.ListTags(ctx, runner); err != nil || len(tags) != 1 {
		t.Fatalf("after delete tags = %d (err=%v), want 1", len(tags), err)
	}
	if err := repo.DeleteTag(ctx, runner, "nope"); !errors.Is(err, ErrNoTag) {
		t.Fatalf("DeleteTag(missing) = %v, want ErrNoTag", err)
	}
}

func TestTagInputValidation(t *testing.T) {
	root := initTestRepo(t)
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}
	runner := &ExecRunner{}

	if err := repo.CreateTag(context.Background(), runner, "bad..name", "", ""); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("CreateTag(bad name) = %v, want ErrInvalidRef", err)
	}
	if err := repo.CreateTag(context.Background(), runner, "v1", "-x", ""); !errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("CreateTag(bad target) = %v, want ErrInvalidRef", err)
	}
	if err := repo.PushTag(context.Background(), runner, "origin", "v1"); errors.Is(err, protocol.ErrInvalidRef) {
		t.Fatalf("PushTag(valid refs) should fail at the git level, got validation error %v", err)
	}
}

func TestPushTagUploadsToRemote(t *testing.T) {
	root, bare := initRemoteRepo(t)
	runGit(t, root, "push", "-u", "origin", "main")
	runGit(t, root, "tag", "-a", "v1", "-m", "release")
	repo := Repository{Root: root, GitDir: filepath.Join(root, ".git")}

	if err := repo.PushTag(context.Background(), &ExecRunner{}, "origin", "v1"); err != nil {
		t.Fatalf("PushTag: %v", err)
	}
	got := strings.TrimSpace(runGit(t, bare, "for-each-ref", "--format=%(refname)", "refs/tags/v1"))
	if got != "refs/tags/v1" {
		t.Fatalf("remote tag = %q, want refs/tags/v1", got)
	}
}
