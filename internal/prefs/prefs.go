// Package prefs stores the browser display preferences shared by every Gitna process.
package prefs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/roie/gitna/internal/filelock"
)

const (
	MaxValueBytes = 512
	lockName      = "preferences.lock"
	tempPattern   = "preferences.json.tmp-*"
)

var (
	ErrUnknownKey   = errors.New("prefs: unknown key")
	ErrValueTooLong = errors.New("prefs: value too long")
)

var allowedKeys = []string{
	"theme",
	"diffshub-light-theme",
	"diffshub-dark-theme",
	"gitna-source-control-pane-sizes-v2",
	"gitna:inline-blame",
	"gitna:conversations",
}

// File is the preferences file. Open creates nothing.
type File struct {
	path string
}

func Open(path string) *File {
	return &File{path: path}
}

// All returns the stored preferences. A missing or unparseable file is empty.
func (f *File) All() (map[string]string, error) {
	lock, err := os.OpenFile(f.lockPath(), os.O_RDWR, 0o600)
	if errors.Is(err, os.ErrNotExist) {
		return f.read()
	}
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := filelock.Lock(lock); err != nil {
		return nil, err
	}
	defer filelock.Unlock(lock)
	return f.read()
}

// Set stores one preference. The read-modify-write is exclusive across processes.
func (f *File) Set(key, value string) error {
	if !slices.Contains(allowedKeys, key) {
		return fmt.Errorf("%w: %q", ErrUnknownKey, key)
	}
	if len(value) > MaxValueBytes {
		return fmt.Errorf("%w: %d bytes", ErrValueTooLong, len(value))
	}
	dir := filepath.Dir(f.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(f.lockPath(), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := filelock.Lock(lock); err != nil {
		return err
	}
	defer filelock.Unlock(lock)

	all, err := f.read()
	if err != nil {
		return err
	}
	all[key] = value
	leftovers, err := filepath.Glob(filepath.Join(dir, tempPattern))
	if err != nil {
		return err
	}
	for _, leftover := range leftovers {
		os.Remove(leftover)
	}
	return f.replace(all)
}

func (f *File) lockPath() string {
	return filepath.Join(filepath.Dir(f.path), lockName)
}

func (f *File) read() (map[string]string, error) {
	all := map[string]string{}
	data, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return all, nil
	}
	if err != nil {
		return nil, err
	}
	var stored map[string]string
	if json.Unmarshal(data, &stored) != nil {
		return all, nil
	}
	for _, key := range allowedKeys {
		if value, ok := stored[key]; ok {
			all[key] = value
		}
	}
	return all, nil
}

func (f *File) replace(all map[string]string) error {
	data, err := json.Marshal(all)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(f.path), tempPattern)
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), f.path)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err
}
