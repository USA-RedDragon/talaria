package executor

import (
	"os"

	"golang.org/x/sys/unix"
)

// punchHole frees the blocks of path before byte end, keeping its size, so
// that a long-running command's spool file holds only output the plugin
// has not confirmed. Errors are ignored: the file then keeps its blocks.
func punchHole(path string, end int64) {
	end &^= 4095
	if end <= 0 {
		return
	}
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return
	}
	defer f.Close()
	_ = unix.Fallocate(int(f.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, 0, end)
}
