package drafts

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	SchemaVersion       = 1
	DefaultMaxContent   = 512 << 10
	DefaultMaxRecords   = 128
	DefaultMaxTotalSize = 64 << 20
)

var (
	ErrStaleRevision = errors.New("draft revision is stale")
	ErrQuota         = errors.New("draft journal quota exceeded")
	ErrInvalidRecord = errors.New("invalid draft record")
	opaqueIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

type Record struct {
	Schema       int       `json:"schema"`
	DocumentID   string    `json:"documentId"`
	ClientID     string    `json:"clientId"`
	FolderKey    string    `json:"folderKey,omitempty"`
	Path         string    `json:"path,omitempty"`
	Label        string    `json:"label"`
	Revision     uint64    `json:"revision"`
	Contents     string    `json:"contents"`
	BaselineHash string    `json:"baselineHash,omitempty"`
	UpdatedAt    time.Time `json:"updatedAt"`
	Recovery     string    `json:"recovery,omitempty"`
}

type Options struct {
	MaxContent   int
	MaxRecords   int
	MaxTotalSize int64
	Now          func() time.Time
}

type Journal struct {
	mu           sync.Mutex
	dir          string
	maxContent   int
	maxRecords   int
	maxTotalSize int64
	now          func() time.Time
}

func Open(dir string, options Options) (*Journal, error) {
	if dir == "" {
		return nil, errors.New("draft journal directory is empty")
	}
	if options.MaxContent <= 0 {
		options.MaxContent = DefaultMaxContent
	}
	if options.MaxRecords <= 0 {
		options.MaxRecords = DefaultMaxRecords
	}
	if options.MaxTotalSize <= 0 {
		options.MaxTotalSize = DefaultMaxTotalSize
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	return &Journal{
		dir:          dir,
		maxContent:   options.MaxContent,
		maxRecords:   options.MaxRecords,
		maxTotalSize: options.MaxTotalSize,
		now:          options.Now,
	}, nil
}

func (j *Journal) Put(record Record) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.validate(record); err != nil {
		return err
	}
	path := j.recordPath(record.DocumentID)
	current, readErr := readRecord(path)
	replacing := readErr == nil
	if readErr != nil && !errors.Is(readErr, fs.ErrNotExist) {
		return readErr
	}
	if replacing {
		if record.Revision < current.Revision ||
			(record.Revision == current.Revision && record.Contents != current.Contents) {
			return fmt.Errorf("%w: %s", ErrStaleRevision, record.DocumentID)
		}
		if record.Revision == current.Revision && record.Contents == current.Contents {
			return nil
		}
	}
	record.Schema = SchemaVersion
	record.UpdatedAt = j.now().UTC()
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err := j.checkQuota(record.DocumentID, int64(len(data)), replacing); err != nil {
		return err
	}
	return j.publish(path, data)
}

func (j *Journal) Get(documentID string) (Record, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := validateID(documentID); err != nil {
		return Record{}, err
	}
	return readRecord(j.recordPath(documentID))
}

func (j *Journal) List() ([]Record, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return nil, err
	}
	records := make([]Record, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		record, err := readRecord(filepath.Join(j.dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	sort.Slice(records, func(i, k int) bool { return records[i].UpdatedAt.Before(records[k].UpdatedAt) })
	return records, nil
}

func (j *Journal) Delete(documentID string, expectedRevision uint64) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := validateID(documentID); err != nil {
		return err
	}
	path := j.recordPath(documentID)
	record, err := readRecord(path)
	if err != nil {
		return err
	}
	if record.Revision != expectedRevision {
		return fmt.Errorf("%w: %s", ErrStaleRevision, documentID)
	}
	return os.Remove(path)
}

func (j *Journal) validate(record Record) error {
	if err := validateID(record.DocumentID); err != nil {
		return err
	}
	if err := validateID(record.ClientID); err != nil {
		return err
	}
	if record.Label == "" || record.Schema != 0 && record.Schema != SchemaVersion {
		return ErrInvalidRecord
	}
	if len([]byte(record.Contents)) > j.maxContent {
		return fmt.Errorf("%w: content exceeds %d bytes", ErrQuota, j.maxContent)
	}
	return nil
}

func (j *Journal) checkQuota(documentID string, size int64, replacing bool) error {
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return err
	}
	if !replacing && len(entries) >= j.maxRecords {
		return fmt.Errorf("%w: maximum record count reached", ErrQuota)
	}
	var total int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || entry.Name() == documentID+".json" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
	}
	if total+size > j.maxTotalSize {
		return fmt.Errorf("%w: maximum serialized size reached", ErrQuota)
	}
	return nil
}

func (j *Journal) publish(path string, data []byte) error {
	tempName := ".tmp-" + randomSuffix()
	tempPath := filepath.Join(j.dir, tempName)
	file, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	cleanup = false
	directory, err := os.Open(j.dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (j *Journal) recordPath(documentID string) string {
	return filepath.Join(j.dir, documentID+".json")
}

func readRecord(path string) (Record, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Record{}, err
	}
	var record Record
	if err := json.Unmarshal(data, &record); err != nil {
		return Record{}, fmt.Errorf("decode draft %q: %w", path, err)
	}
	if record.Schema != SchemaVersion || validateID(record.DocumentID) != nil || validateID(record.ClientID) != nil {
		return Record{}, fmt.Errorf("%w: %s", ErrInvalidRecord, filepath.Base(path))
	}
	return record, nil
}

func validateID(id string) error {
	if !opaqueIDPattern.MatchString(id) {
		return fmt.Errorf("%w: invalid opaque id", ErrInvalidRecord)
	}
	return nil
}

func randomSuffix() string {
	var bytes [12]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return hex.EncodeToString([]byte(fmt.Sprint(time.Now().UnixNano())))
	}
	return hex.EncodeToString(bytes[:])
}
