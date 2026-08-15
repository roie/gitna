package main

import (
	"context"
	"flag"
	"log"
	"os/signal"
	"syscall"

	"github.com/roie/gitna/internal/app"
)

func main() {
	flag.Parse()

	path := "."
	if args := flag.Args(); len(args) > 0 {
		path = args[0]
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := app.Run(ctx, path); err != nil {
		log.Fatal(err)
	}
}
