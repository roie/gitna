package agentrun

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/roie/gitna/internal/conversations"
)

func BuildPrompt(c conversations.Conversation, message conversations.Message, self conversations.Participant, root string) string {
	anchor := c.Anchor
	anchor.Before, anchor.After = "", ""
	encode := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	header := fmt.Sprintf("You are %s (%s), working in %s.\nInstructions: reply to the addressed message; edit files in the working tree when asked; never commit or push.\nImmutable anchor: %s\nCurrent location: %s\nStatus: %s\nAddressed message: %s\nThread:\n", self.Name, self.ID, root, encode(anchor), encode(c.Location), c.Status, encode(message))
	lines := make([]string, len(c.Messages))
	total := len(header)
	for i, m := range c.Messages {
		lines[i] = encode(m) + "\n"
		total += len(lines[i])
	}
	const limit = 256 << 10
	if total <= limit {
		return header + strings.Join(lines, "")
	}
	const cut = "[Middle of thread omitted]\n"
	if len(lines) == 0 {
		return header
	}
	remaining := limit - len(header) - len(lines[0]) - len(cut)
	tail := len(lines)
	for tail > 1 && len(lines[tail-1]) <= remaining {
		tail--
		remaining -= len(lines[tail])
	}
	return header + lines[0] + cut + strings.Join(lines[tail:], "")
}
