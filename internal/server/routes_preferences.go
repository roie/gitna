package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/roie/gitna/internal/prefs"
)

func (s *Server) servePreferencesScript(w http.ResponseWriter, r *http.Request) {
	stored := map[string]string{}
	if s.preferences != nil {
		if all, err := s.preferences.All(); err == nil {
			stored = all
		}
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		http.Error(w, "preferences unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write([]byte("try{const p=" + string(encoded) + ";for(const k in p)localStorage.setItem(k,p[k])}catch{}\n"))
}

func (s *Server) handleSetPreference(w http.ResponseWriter, r *http.Request) {
	if s.preferences == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "preferences unavailable"})
		return
	}
	var body struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	switch err := s.preferences.Set(body.Key, body.Value); {
	case errors.Is(err, prefs.ErrUnknownKey), errors.Is(err, prefs.ErrValueTooLong):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	default:
		if s.preferenceChanged != nil {
			s.preferenceChanged(body.Key)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
