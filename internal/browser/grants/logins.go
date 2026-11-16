package grants

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// savedLogins counts the logins Firefox saved for https://host in the first
// of dirs that exists, reading only the hostname field of logins.json. It is
// -1 when no profile is known or logins.json cannot be read. It never reads
// or returns user names or passwords.
func savedLogins(dirs []string, host string) int {
	for _, dir := range dirs {
		if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, "logins.json"))
		if os.IsNotExist(err) {
			return 0
		}
		if err != nil {
			return -1
		}
		var f struct {
			Logins []struct {
				Hostname string `json:"hostname"`
			} `json:"logins"`
		}
		if json.Unmarshal(data, &f) != nil {
			return -1
		}
		n := 0
		for _, l := range f.Logins {
			if strings.EqualFold(strings.TrimRight(l.Hostname, "/"), "https://"+host) {
				n++
			}
		}
		return n
	}
	return -1
}

// DesktopProfileDirs returns the default Firefox profile of the user's
// desktop Firefox, found through profiles.ini, or none.
func DesktopProfileDirs(home string) []string {
	var roots []string
	switch runtime.GOOS {
	case "darwin":
		roots = []string{filepath.Join(home, "Library", "Application Support", "Firefox")}
	case "windows":
		if ad := os.Getenv("APPDATA"); ad != "" {
			roots = []string{filepath.Join(ad, "Mozilla", "Firefox")}
		}
	default:
		roots = []string{filepath.Join(home, ".mozilla", "firefox"),
			filepath.Join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
			filepath.Join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox")}
	}
	var out []string
	for _, r := range roots {
		if p := defaultProfile(r); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// defaultProfile parses root/profiles.ini: the install's Default path wins,
// then the profile marked Default=1.
func defaultProfile(root string) string {
	f, err := os.Open(filepath.Join(root, "profiles.ini")) //nolint:gosec // root is a fixed Firefox profile location under the user's home
	if err != nil {
		return ""
	}
	defer f.Close()
	type sec struct{ kv map[string]string }
	var secs = map[string]*sec{}
	var order []string
	var cur *sec
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]"):
			name := line[1 : len(line)-1]
			cur = &sec{kv: map[string]string{}}
			secs[name] = cur
			order = append(order, name)
		case cur != nil && strings.Contains(line, "="):
			k, v, _ := strings.Cut(line, "=")
			cur.kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	resolve := func(path string, relative bool) string {
		if path == "" {
			return ""
		}
		if relative {
			return filepath.Join(root, filepath.FromSlash(path))
		}
		return filepath.FromSlash(path)
	}
	for _, name := range order {
		if strings.HasPrefix(name, "Install") {
			if p := secs[name].kv["Default"]; p != "" {
				return resolve(p, true)
			}
		}
	}
	for _, name := range order {
		if strings.HasPrefix(name, "Profile") && secs[name].kv["Default"] == "1" {
			return resolve(secs[name].kv["Path"], secs[name].kv["IsRelative"] != "0")
		}
	}
	return ""
}
