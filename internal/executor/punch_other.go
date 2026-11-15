//go:build unix && !linux

package executor

// punchHole does nothing outside Linux: a spool file keeps the command's
// whole output until the command's entry is removed.
func punchHole(string, int64) {}
