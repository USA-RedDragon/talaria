package cmd

import (
	"os"
	"testing"

	"github.com/USA-RedDragon/talaria/internal/executor"
)

func TestMain(m *testing.M) {
	// runDaemon starts this test binary as the command holder.
	if dir, ok := executor.HolderInvocation(os.Args); ok {
		os.Exit(executor.RunHolder(dir))
	}
	if err := os.Setenv(NoNoticeEnv, "1"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
