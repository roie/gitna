package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os/signal"
	"syscall"

	"github.com/roie/gitna/internal/app"
)

var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print the Gitna version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

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
