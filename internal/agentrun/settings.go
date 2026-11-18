package agentrun

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/roie/gitna/internal/filelock"
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
	// Adapters is the folder that holds the adapters Gitna installs.
	Adapters string
	mu       sync.Mutex
	path     string
	settings Settings
}

// Open reads the settings at path. Every Gitna process shares the file, so
// Get rereads it and Update changes it under a lock.
func Open(path string) (*SettingsFile, error) {
	file := &SettingsFile{path: path}
	settings, err := file.read()
	if err != nil {
		return nil, err
	}
	file.settings = settings
	return file, nil
}

func (f *SettingsFile) read() (Settings, error) {
	var settings Settings
	data, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	return settings, json.Unmarshal(data, &settings)
}

func cloneSettings(settings Settings) Settings {
	settings.Agents = slices.Clone(settings.Agents)
	for i := range settings.Agents {
		settings.Agents[i].Args = slices.Clone(settings.Agents[i].Args)
	}
	return settings
}

// Get returns the saved settings, or the last ones read if the file cannot
// be read now.
func (f *SettingsFile) Get() Settings {
	f.mu.Lock()
	defer f.mu.Unlock()
	if settings, err := f.read(); err == nil {
		f.settings = settings
	}
	return cloneSettings(f.settings)
}

func (f *SettingsFile) Update(update func(*Settings) error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(f.path+".lock", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := filelock.Lock(lock); err != nil {
		return err
	}
	defer filelock.Unlock(lock)
	next, err := f.read()
	if err != nil {
		return err
	}
	if err := update(&next); err != nil {
		return err
	}
	data, err := json.Marshal(next)
	if err != nil {
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
