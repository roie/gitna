package agentrun

import (
	"strings"
	"testing"

	"github.com/roie/gitna/internal/conversations"
)

func TestPromptContainsAnchorThreadAndInstructions(t *testing.T) {
	self := conversations.Participant{ID: "agent:one", Name: "Helper"}
	c := conversations.Conversation{ID: "thread", Anchor: conversations.Anchor{Path: "src/a.go", StartLine: 3, EndLine: 4, Code: "return x", Source: "commit", Revision: "abc"}, Location: &conversations.Location{Path: "src/b.go", StartLine: 5, EndLine: 6, Status: "moved"}, Status: "open", Messages: []conversations.Message{{ID: "first", Body: "Earlier question"}, {ID: "current", Body: "Please change it"}}}
	prompt := BuildPrompt(c, c.Messages[1], self, "/work/repo")
	for _, want := range []string{"src/a.go", "return x", "commit", "abc", "src/b.go", "moved", "Earlier question", "Please change it", "Helper", "/work/repo", "reply to", "edit files", "never commit or push"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("missing %q in %s", want, prompt)
		}
	}
}

func TestPromptCutsTheMiddleOfLongThreads(t *testing.T) {
	c := conversations.Conversation{Anchor: conversations.Anchor{Path: "keep-anchor", Code: "immutable code"}, Messages: []conversations.Message{{Body: "KEEP-FIRST"}}}
	for i := range 40 {
		c.Messages = append(c.Messages, conversations.Message{Body: strings.Repeat("middle", 3000), ID: string(rune('A' + i))})
	}
	c.Messages = append(c.Messages, conversations.Message{Body: "KEEP-NEWEST"})
	prompt := BuildPrompt(c, c.Messages[len(c.Messages)-1], conversations.Participant{}, "root")
	if len(prompt) > 256<<10 {
		t.Fatalf("prompt is %d bytes", len(prompt))
	}
	for _, want := range []string{"keep-anchor", "immutable code", "KEEP-FIRST", "KEEP-NEWEST", "omitted"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("missing %s", want)
		}
	}
}
