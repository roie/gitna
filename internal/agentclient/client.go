// Package agentclient is the transport that coding-agent front ends (such as
// the gitna CLI) use to reach a running Gitna's agent API.
package agentclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/roie/gitna/internal/agentlink"
)

// ErrNoSession reports that no running Gitna has the repository open.
var ErrNoSession = errors.New("no running Gitna session has this folder open; start one with `gitna <folder>`")

type Client struct {
	endpoint    agentlink.Endpoint
	repo        string
	participant string
	http        *http.Client
}

// APIError is a non-2xx response from Gitna.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("gitna: %s (HTTP %d)", e.Message, e.Status) }

// Discover finds the running Gitna process that has repo open and returns a
// client for it together with the session description.
// participant is the id Gitna issued at join, or "" before joining.
func Discover(ctx context.Context, dir, repo, participant string) (*Client, json.RawMessage, error) {
	endpoints, err := agentlink.List(dir)
	if err != nil {
		return nil, nil, err
	}
	var lastErr error = ErrNoSession
	for _, endpoint := range endpoints {
		client := &Client{endpoint: endpoint, repo: repo, participant: participant, http: &http.Client{}}
		var session json.RawMessage
		// One attempt: an endpoint left by a crashed process refuses at once,
		// and retrying it would delay every command.
		probe, cancel := context.WithTimeout(ctx, 3*time.Second)
		_, err := client.once(probe, http.MethodGet, "/session?"+url.Values{"repo": {repo}}.Encode(), nil, &session)
		cancel()
		if err == nil {
			return client, session, nil
		}
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Status != http.StatusNotFound {
			lastErr = err
		}
	}
	return nil, nil, lastErr
}

// Do performs one request. Writes carry client-chosen ids, so transport
// failures are retried without risking duplicates.
func (c *Client) Do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	if query == nil {
		query = url.Values{}
	}
	query.Set("repo", c.repo)
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	var err error
	for attempt := range 3 {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		var retry bool
		retry, err = c.once(ctx, method, path+"?"+query.Encode(), payload, out)
		if !retry {
			return err
		}
	}
	return err
}

func (c *Client) once(ctx context.Context, method, target string, payload []byte, out any) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, method, c.endpoint.URL+"/agent/v1"+target, bytes.NewReader(payload))
	if err != nil {
		return false, err
	}
	request.Header.Set("Authorization", "Bearer "+c.endpoint.Token)
	if c.participant != "" {
		request.Header.Set("Gitna-Participant", c.participant)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return ctx.Err() == nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return ctx.Err() == nil, err
	}
	if response.StatusCode/100 != 2 {
		var failure struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &failure) != nil || failure.Error == "" {
			failure.Error = http.StatusText(response.StatusCode)
		}
		return response.StatusCode == http.StatusServiceUnavailable, &APIError{Status: response.StatusCode, Message: failure.Error}
	}
	if out == nil {
		return false, nil
	}
	return false, json.Unmarshal(data, out)
}
