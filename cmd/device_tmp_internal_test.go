package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/internal/config"
)

func TestDeviceTempDirDefaultsToPrivateStateFolder(t *testing.T) {
	t.Parallel()
	state := t.TempDir()
	tmp := filepath.Join(state, "tmp")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"hermes-snap-aaaa.sh", "hermes-cwd-aaaa.txt", "keep.txt"} {
		if err := os.WriteFile(filepath.Join(tmp, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got, err := deviceTempDir(&config.Config{}, state)
	if err != nil {
		t.Fatal(err)
	}
	if got != tmp {
		t.Fatalf("deviceTempDir = %q, want %q", got, tmp)
	}
	if fi, err := os.Stat(got); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("tmp dir mode = %v, %v; want 0700", fi, err)
	}
	for name, want := range map[string]bool{"hermes-snap-aaaa.sh": false, "hermes-cwd-aaaa.txt": false, "keep.txt": true} {
		if _, err := os.Stat(filepath.Join(tmp, name)); (err == nil) != want {
			t.Errorf("%s present = %v, want %v", name, err == nil, want)
		}
	}
}

func TestDeviceTempDirKeepsExplicitSetting(t *testing.T) {
	t.Parallel()
	explicit := filepath.Join(t.TempDir(), "mine")
	cfg := &config.Config{}
	cfg.Device.TempDir = explicit
	got, err := deviceTempDir(cfg, t.TempDir())
	if err != nil || got != explicit {
		t.Fatalf("deviceTempDir = %q, %v; want %q", got, err, explicit)
	}
}

func TestDeviceTempDirWithoutStateDirUsesSystemTemp(t *testing.T) {
	t.Parallel()
	got, err := deviceTempDir(&config.Config{}, "")
	if err != nil || got != os.TempDir() {
		t.Fatalf("deviceTempDir = %q, %v; want %q", got, err, os.TempDir())
	}
}
