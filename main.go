package main

import (
	"log/slog"
	"os"

	"github.com/USA-RedDragon/talaria/cmd"
	"github.com/USA-RedDragon/talaria/internal/browser/host"
	"github.com/USA-RedDragon/talaria/internal/executor"
)

// https://goreleaser.com/cookbooks/using-main.version/
//
//nolint:gochecknoglobals
var (
	version = "dev"
	commit  = "none"
	// hubURL is the hub setup pairs with by default. The release sets it
	// from the repository variable HUB_DEFAULT_URL.
	hubURL = ""
)

func main() {
	if dir, ok := executor.HolderInvocation(os.Args); ok {
		os.Exit(executor.RunHolder(dir))
	}
	if manifest, extensionID, ok := host.Invocation(os.Args); ok {
		if err := cmd.RunNativeHost(manifest, extensionID); err != nil {
			slog.Error("Native messaging host failed.", "error", err.Error())
			os.Exit(1)
		}
		return
	}
	rootCmd := cmd.NewCommand(version, commit, cmd.WithDefaultHub(hubURL), cmd.WithMigration())
	if err := rootCmd.Execute(); err != nil {
		slog.Error("Encountered an error.", "error", err.Error())
		os.Exit(1)
	}
}
