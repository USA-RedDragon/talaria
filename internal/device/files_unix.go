//go:build unix

package device

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// openNoFollow opens path for reading. It fails when the last part is a
// symbolic link, and does not block on a fifo that replaced the file.
func openNoFollow(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
}

// fileIdentity returns the device, inode and link count of an open file.
// known is false when the platform does not say.
func fileIdentity(_ *os.File, fi os.FileInfo) (dev, ino, nlink uint64, known bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, 0, false
	}
	return uint64(st.Dev), uint64(st.Ino), uint64(st.Nlink), true //nolint:unconvert,nolintlint // widths differ by platform
}
