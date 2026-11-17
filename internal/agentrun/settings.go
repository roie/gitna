package agentrun

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
)

type Definition struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
}

type Settings struct {
	Agents []Definition `json:"agents"`
}

type SettingsFile struct {
	mu       sync.Mutex
	path     string
	settings Settings
}

func Open(path string) (*SettingsFile, error) {
	file := &SettingsFile{path: path}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &file.settings); err != nil {
		return nil, err
	}
	return file, nil
}

func cloneSettings(settings Settings) Settings {
	settings.Agents = slices.Clone(settings.Agents)
	for i := range settings.Agents {
		settings.Agents[i].Args = slices.Clone(settings.Agents[i].Args)
	}
	return settings
}

func (f *SettingsFile) Get() Settings {
	f.mu.Lock()
	defer f.mu.Unlock()
	return cloneSettings(f.settings)
}

func (f *SettingsFile) Update(update func(*Settings) error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	next := cloneSettings(f.settings)
	if err := update(&next); err != nil {
		return err
	}
	data, err := json.Marshal(next)
	if err != nil {
		return err
	}
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "settings.json.tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), f.path); err != nil {
		return err
	}
	f.settings = cloneSettings(next)
	return nil
}
