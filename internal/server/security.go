package server

import (
	"mime"
	"net/http"
	"net/url"
	"strings"
)



// Security enforces the loopback session boundary: capability URL, Host
// validation, mutation origin/content-type checks, request size limits, and
// strict response headers.
type Security struct {
	// Token is the per-process capability token required in every URL.
	Token string
	// Host is the only permitted Host header value, derived from the loopback
	// listener address, e.g. "127.0.0.1:PORT".
	Host string
}

// Wrap returns a handler that enforces the security model around next. next
// receives requests whose URL path has the capability prefix stripped.
func (s Security) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)

		if s.Token == "" {
			http.NotFound(w, r)
			return
		}

		if r.URL.Path == "/" {
			http.Redirect(w, r, "/s/"+s.Token+"/", http.StatusFound)
			return
		}

		if r.Host != s.Host {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		prefix := "/s/" + s.Token
		if r.URL.Path == prefix {
			http.Redirect(w, r, prefix+"/", http.StatusFound)
			return
		}
		if !strings.HasPrefix(r.URL.Path, prefix+"/") {
			http.NotFound(w, r)
			return
		}

		if isMutation(r.Method) {
			if !s.sameOrigin(r) {
				http.Error(w, "forbidden: cross-origin request", http.StatusForbidden)
				return
			}
			ct, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || ct != "application/json" {
				http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
				return
			}
			if r.ContentLength > MaxRequestBody {
				http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBody)
		}

		http.StripPrefix(prefix, next).ServeHTTP(w, r)
	})
}

func (s Security) sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme != "http" || u.Host != s.Host {
		return false
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
		return true
	default:
		return false
	}
}

func isMutation(method string) bool {
	return method != http.MethodGet && method != http.MethodHead
}

func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
}
