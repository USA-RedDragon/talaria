//go:build windows

package device

import (
	"os"

	"golang.org/x/sys/windows"
)

// openNoFollow opens path for reading. Windows has no O_NOFOLLOW: the
// caller checks with Lstat before, and os.SameFile after.
func openNoFollow(path string) (*os.File, error) {
	return os.Open(path)
}

// fileIdentity returns the volume serial number, file index and link
// count of an open file. known is false when Windows does not say.
func fileIdentity(f *os.File, _ os.FileInfo) (dev, ino, nlink uint64, known bool) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info); err != nil {
		return 0, 0, 0, false
	}
	return uint64(info.VolumeSerialNumber), uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow), uint64(info.NumberOfLinks), true
}
