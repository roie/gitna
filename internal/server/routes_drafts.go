package server

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"strconv"

	"github.com/roie/gitna/internal/drafts"
)

const draftRequestBodyLimit = drafts.DefaultMaxContent*6 + 32<<10

func (s *Server) handleDrafts(w http.ResponseWriter, r *http.Request) {
	if s.drafts == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "drafts unavailable"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		records, err := s.drafts.List()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		scoped := records[:0]
		for _, record := range records {
			if record.FolderKey == "" || record.FolderKey == s.draftFolderKey {
				scoped = append(scoped, record)
			}
		}
		writeJSON(w, http.StatusOK, scoped)
	case http.MethodPost:
		var record drafts.Record
		if err := decodeDraftRequest(w, r, &record); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if record.FolderKey == "" {
			record.FolderKey = s.draftFolderKey
		} else if record.FolderKey != s.draftFolderKey {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "draft belongs to another folder"})
			return
		}
		if err := s.drafts.Put(record); err != nil {
			writeDraftError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, record)
	case http.MethodDelete:
		documentID := r.URL.Query().Get("documentId")
		revision, err := strconv.ParseUint(r.URL.Query().Get("revision"), 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "revision must be an unsigned integer"})
			return
		}
		record, err := s.drafts.Get(documentID)
		if err != nil {
			writeDraftError(w, err)
			return
		}
		if record.FolderKey != "" && record.FolderKey != s.draftFolderKey {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "draft belongs to another folder"})
			return
		}
		if err := s.drafts.Delete(documentID, revision); err != nil {
			writeDraftError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func decodeDraftRequest(w http.ResponseWriter, r *http.Request, target any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, draftRequestBodyLimit))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing json.RawMessage
	err := decoder.Decode(&trailing)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return errors.New("request body must contain exactly one JSON value")
	}
	return err
}

func writeDraftError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "draft not found"})
	case errors.Is(err, drafts.ErrStaleRevision):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error(), "code": "stale-draft"})
	case errors.Is(err, drafts.ErrQuota):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": err.Error(), "code": "draft-quota"})
	case errors.Is(err, drafts.ErrInvalidRecord):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error(), "code": "invalid-draft"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}
