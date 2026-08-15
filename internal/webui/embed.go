// Package webui embeds the built frontend assets into the executable.
//
// The embedded tree is produced by `pnpm --dir web build`, which writes to
// this package's dist/ directory. Because dist/ is ignored by git, the embed
// uses the all: prefix so build outputs are embedded regardless of .gitignore.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Assets returns the embedded frontend rooted at the dist directory.
func Assets() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}
