package server

import (
	"net/http"

	"github.com/roie/gitna/internal/agentrun"
)

func (c *Conversations) settings(w http.ResponseWriter) {
	var settings agentrun.Settings
	if c.Settings != nil {
		settings = c.Settings.Get()
	}
	enabled := c.Enabled != nil && c.Enabled()
	writeJSON(w, http.StatusOK, struct {
		Enabled bool                  `json:"enabled"`
		Agents  []agentrun.Definition `json:"agents"`
	}{Enabled: enabled, Agents: nonNil(settings.Agents)})
}
