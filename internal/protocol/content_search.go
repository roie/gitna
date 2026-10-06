package protocol

// ContentSearchResults is a bounded search response for the active folder.
type ContentSearchResults struct {
	Generation        uint64              `json:"generation"`
	Results           []ContentSearchFile `json:"results"`
	Complete          bool                `json:"complete"`
	Truncated         bool                `json:"truncated"`
	SkippedLargeFiles int                 `json:"skippedLargeFiles,omitempty"`
	SkippedLongLines  int                 `json:"skippedLongLines,omitempty"`
}

type ContentSearchFile struct {
	Path    string               `json:"path"`
	Matches []ContentSearchMatch `json:"matches"`
}

type ContentSearchMatch struct {
	Line    int    `json:"line"`
	Column  int    `json:"column"`
	Length  int    `json:"length"`
	Excerpt string `json:"excerpt"`
	// Column and excerpt offsets use UTF-16 code units, as in the browser editor.
	MatchStart int `json:"matchStart"`
	MatchEnd   int `json:"matchEnd"`
}
