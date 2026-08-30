package app

import (
	"errors"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestShutdownServerDoesNotReturnDeadlineExceeded(t *testing.T) {
	requestStarted := make(chan struct{})
	handlerStopped := make(chan struct{})
	server := &http.Server{
		Handler: http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
			close(requestStarted)
			<-request.Context().Done()
			close(handlerStopped)
		}),
		ReadHeaderTimeout: time.Second,
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()

	requestDone := make(chan struct{})
	go func() {
		response, requestErr := http.Get("http://" + listener.Addr().String())
		if requestErr == nil {
			response.Body.Close()
		}
		close(requestDone)
	}()

	select {
	case <-requestStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not reach server")
	}

	if err := shutdownServer(server, 10*time.Millisecond); err != nil {
		t.Fatalf("shutdownServer() error = %v", err)
	}

	for name, done := range map[string]<-chan struct{}{
		"handler": handlerStopped,
		"request": requestDone,
	} {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s did not stop", name)
		}
	}
	if err := <-serveDone; !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("Serve() error = %v", err)
	}
}
