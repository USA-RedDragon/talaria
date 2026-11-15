package web_test

import "syscall"

// setPdeathsig has the kernel SIGTERM the node script if the test binary
// dies by any means; the script's exit hook then kills its browser.
func setPdeathsig(a *syscall.SysProcAttr) { a.Pdeathsig = syscall.SIGTERM }
