// Package agentlink lets local coding-agent clients find running Gitna
// processes. Each process publishes its agent endpoint and bearer token in a
// user-private file; the browser capability token is never written there.
package agentlink

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/roie/gitna/internal/statedir"
)

type Endpoint struct {
	PID     int    `json:"pid"`
	URL     string `json:"url"`
	Token   string `json:"token"`
	Version string `json:"version"`
}

// Dir is the discovery directory under the state directory.
func Dir() (string, error) {
	state, err := statedir.Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(state, "agents"), nil
}

// Publish writes endpoint for this process and returns a function that
// removes it.
func Publish(dir string, endpoint Endpoint) (func(), error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	data, err := json.Marshal(endpoint)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, fmt.Sprintf("%d.json", endpoint.PID))
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(temp, path); err != nil {
		os.Remove(temp)
		return nil, err
	}
	return func() { os.Remove(path) }, nil
}

// Remove deletes the endpoint file of pid.
func Remove(dir string, pid int) error {
	return os.Remove(filepath.Join(dir, fmt.Sprintf("%d.json", pid)))
}

// List returns published endpoints. Files of exited processes may remain
// after a crash, so callers probe each endpoint.
func List(dir string) ([]Endpoint, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var endpoints []Endpoint
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var endpoint Endpoint
		if json.Unmarshal(data, &endpoint) == nil && endpoint.URL != "" && endpoint.Token != "" {
			endpoints = append(endpoints, endpoint)
		}
	}
	return endpoints, nil
}
