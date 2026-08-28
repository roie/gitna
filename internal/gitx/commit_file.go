package gitx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"strconv"

	"github.com/roie/gitna/internal/protocol"
)

// ReadCommitFile returns one bounded file exactly as it exists in a commit.
// Revision and path are validated independently before they are combined into
// Git's treeish:path object syntax.
func (r Repository) ReadCommitFile(
	ctx context.Context,
	runner Runner,
	oid string,
	path string,
	before bool,
) (protocol.FileDiff, error) {
	if err := validateRef(oid); err != nil {
		return protocol.FileDiff{}, err
	}
	if err := validatePath(path); err != nil {
		return protocol.FileDiff{}, err
	}
	revision := oid
	if before {
		revision += "^1"
	}
	object := revision + ":" + path
	version := protocol.FileVersion{Path: path, Language: languageFor(path)}
	result := protocol.FileDiff{
		Before: protocol.FileVersion{Path: path, Language: languageFor(path)},
		After:  version,
	}

	sizeResult, err := runner.Run(ctx, r.Root, "cat-file", "-s", object)
	if err != nil {
		return protocol.FileDiff{}, err
	}
	if sizeResult.ExitCode != 0 {
		return protocol.FileDiff{}, fmt.Errorf("%w: %s at %s", os.ErrNotExist, path, revision)
	}
	size, err := strconv.ParseInt(string(bytes.TrimSpace(sizeResult.Stdout)), 10, 64)
	if err != nil || size < 0 {
		return protocol.FileDiff{}, fmt.Errorf("gitx: invalid blob size for %s at %s", path, revision)
	}
	if size > int64(MaxImageBytes) {
		result.TooLarge = true
		return result, nil
	}

	blobResult, err := runner.Run(ctx, r.Root, "cat-file", "blob", object)
	if err != nil {
		return protocol.FileDiff{}, err
	}
	if blobResult.ExitCode != 0 {
		return protocol.FileDiff{}, fmt.Errorf("%w: %s at %s", os.ErrNotExist, path, revision)
	}
	data := blobResult.Stdout
	if image := rasterImageContent(data); image != nil {
		result.Binary = true
		result.After.Image = image
		return result, nil
	}
	if len(data) > DefaultDiffBytes {
		result.TooLarge = true
		return result, nil
	}
	if isBinary(data) {
		result.Binary = true
		return result, nil
	}
	result.After.Content = string(data)
	return result, nil
}
