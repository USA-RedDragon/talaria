//go:build !linux

package web_test

import "syscall"

func setPdeathsig(*syscall.SysProcAttr) {}
