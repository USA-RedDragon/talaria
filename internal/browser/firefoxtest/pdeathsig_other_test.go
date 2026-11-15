//go:build unix && !linux

package firefoxtest_test

import "syscall"

func setPdeathsigKill(*syscall.SysProcAttr) {}
