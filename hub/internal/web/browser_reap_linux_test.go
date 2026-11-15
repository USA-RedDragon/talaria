package web_test

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// setPdeathsig has the kernel SIGTERM the node script if the test binary
// dies by any means; the script's exit hook then kills its browser.
func setPdeathsig(a *syscall.SysProcAttr) { a.Pdeathsig = syscall.SIGTERM }

// killAllGroups kills the process group of every child of this binary. Each
// browser script leads its own group (browserCmd), so no registry is needed.
func killAllGroups() {
	files, _ := filepath.Glob("/proc/self/task/*/children")
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		for _, p := range strings.Fields(string(b)) {
			if pid, err := strconv.Atoi(p); err == nil {
				_ = syscall.Kill(-pid, syscall.SIGKILL)
			}
		}
	}
}
