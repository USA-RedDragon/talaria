//go:build !unix

package executor

import (
	"errors"
	"time"
)

// ErrNoSpool is returned where commands cannot outlive the daemon.
var ErrNoSpool = errors.New("commands cannot outlive the daemon on this system")

// Spool is unused outside Unix: commands end with the daemon there.
type Spool struct{ Dir string }

// spooled is unused outside Unix.
type spooled struct{ released chan struct{} }

func (*spooled) markKilled()           {}
func (*spooled) setDeadline(time.Time) {}
func (*spooled) release()              {}
func (*spooled) confirm(int64, int64)  {}
func (*spooled) forget()               {}

// NewSpool returns ErrNoSpool.
func NewSpool(string, string, *Scope) (*Spool, error) { return nil, ErrNoSpool }

// Adoptable is unused outside Unix.
type Adoptable struct {
	ID         string
	File, Wire int64
}

// Start returns ErrNoSpool.
func (*Spool) Start(string, string, Request, func([]byte)) (*Process, error) { return nil, ErrNoSpool }

// Adoptable returns nothing.
func (*Spool) Adoptable() []Adoptable { return nil }

// Lock returns ErrNoSpool.
func (*Spool) Lock(time.Duration) (func(), error) { return nil, ErrNoSpool }

// Adopt returns nil.
func (*Spool) Adopt(Adoptable, func([]byte)) *Process { return nil }

// HolderInvocation never starts a holder outside Unix.
func HolderInvocation([]string) (string, bool) { return "", false }

// RunHolder is unused outside Unix.
func RunHolder(string) int { return 1 }
