// Package skills embeds the agent skills shipped with Gitna so the binary can
// hand them to any agent runtime.
package skills

import _ "embed"

//go:embed gitna/SKILL.md
var Gitna string
