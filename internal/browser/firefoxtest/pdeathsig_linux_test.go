//go:build linux

package firefoxtest_test

import "syscall"

func setPdeathsigKill(a *syscall.SysProcAttr) { a.Pdeathsig = syscall.SIGKILL }
