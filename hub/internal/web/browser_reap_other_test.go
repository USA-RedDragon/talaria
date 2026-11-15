//go:build !linux

package web_test

import "syscall"

func setPdeathsig(*syscall.SysProcAttr) {}

// killAllGroups is a no-op where children cannot be listed; the per-test
// cleanup still kills each group.
func killAllGroups() {}
