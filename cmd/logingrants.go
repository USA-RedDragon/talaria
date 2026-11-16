package cmd

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/USA-RedDragon/talaria/internal/browser/broker"
	"github.com/USA-RedDragon/talaria/internal/browser/grants"
	"github.com/USA-RedDragon/talaria/internal/config"
	"github.com/USA-RedDragon/talaria/internal/hubapi"
	"github.com/USA-RedDragon/talaria/internal/tokenstore"
)

// newGrantGate puts the sign-in grant store in front of the broker
// (docs/browser.md section 7.4). The hub's keys and the device's user and id
// come from the hub over the device's own token.
func newGrantGate(cfg *config.Config, br *broker.Broker, hub *hubapi.Client, headlessDir string) (*grants.Gate, error) {
	dir := cfg.Store.StateDir
	if dir == "" {
		d, err := tokenstore.DefaultStateDir()
		if err != nil {
			return nil, fmt.Errorf("find the state directory: %w", err)
		}
		dir = d
	}
	store, err := grants.OpenStore(dir+string(os.PathSeparator)+grants.FileName, nil)
	if err != nil {
		return nil, err
	}
	var (
		mu             sync.Mutex
		user, deviceID string
	)
	identity := func(ctx context.Context) (string, string, error) {
		mu.Lock()
		defer mu.Unlock()
		if user != "" && deviceID != "" {
			return user, deviceID, nil
		}
		wctx, cancel := context.WithTimeout(ctx, whoamiTimeout)
		defer cancel()
		who, err := hub.Whoami(wctx)
		if err != nil {
			return "", "", err
		}
		user, deviceID = who.User, who.DeviceID
		return user, deviceID, nil
	}
	profiles := func() []string {
		if headlessDir != "" {
			return []string{headlessDir}
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return nil
		}
		return grants.DesktopProfileDirs(home)
	}
	return grants.NewGate(grants.Options{
		Inner: br, Store: store,
		Keys: &grants.KeyCache{Fetch: func(ctx context.Context) ([]ed25519.PublicKey, error) {
			kctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			return hub.HubKeys(kctx)
		}},
		Identity:    identity,
		ConfigHosts: cfg.Browser.AutologinHosts, ConfigMethods: cfg.Browser.AutologinMethods,
		Apply: br.SetAutologin, ProfileDirs: profiles,
	}), nil
}
