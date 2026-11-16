package grants

import (
	"context"
	"crypto/ed25519"
	"sync"
	"time"
)

// refetchEvery is the least time between two fetches of the hub keys.
const refetchEvery = time.Minute

// KeyCache holds the hub's public keys in memory. It fetches them on first
// use and again, at most once a minute, when a grant does not verify with
// the cached ones (the hub rotated its key).
type KeyCache struct {
	Fetch func(ctx context.Context) ([]ed25519.PublicKey, error)
	Now   func() time.Time

	mu   sync.Mutex
	keys []ed25519.PublicKey
	last time.Time
}

func (k *KeyCache) now() time.Time {
	if k.Now != nil {
		return k.Now()
	}
	return time.Now()
}

// Keys returns the cached keys, fetching them when there are none.
func (k *KeyCache) Keys(ctx context.Context) ([]ed25519.PublicKey, error) {
	k.mu.Lock()
	have := k.keys
	k.mu.Unlock()
	if len(have) > 0 {
		return have, nil
	}
	return k.Refresh(ctx)
}

// Refresh fetches the keys again unless it did a minute ago or less, and
// returns what it holds.
func (k *KeyCache) Refresh(ctx context.Context) ([]ed25519.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.last.IsZero() && k.now().Sub(k.last) < refetchEvery {
		return k.keys, nil
	}
	k.last = k.now()
	keys, err := k.Fetch(ctx)
	if err != nil {
		return k.keys, err
	}
	k.keys = keys
	return k.keys, nil
}
