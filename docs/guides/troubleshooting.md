# Fix computer problems

Start with the daemon's log. On Linux:

```sh
systemctl --user status talaria
journalctl --user -u talaria -n 100 --no-pager
```

On macOS: `tail -n 100 ~/Library/Logs/talaria.log`. On Windows, in PowerShell: `Get-Content -Tail 100 $env:LOCALAPPDATA\talaria\talaria.log`. For more detail, set `log-level: debug` in the config and restart the service. To check the config file without starting anything, run `talaria run --check-config`.

## Setup says `give the hub URL`

Release builds do not know any hub. Pass the address: `talaria setup https://hub.example.com`.

## Pairing fails

Pairing is the step where setup (or `talaria login`) prints a link and a code, and you confirm it on the hub. What goes wrong, by what you see:

- `the pairing code expired; run talaria login again`: nobody confirmed the code within 10 minutes (the hub's `device.pairing_ttl`). Run `talaria login` (or `talaria setup`) again and confirm the new code at once.
- `pairing was declined on the hub`: someone chose "Do not connect" on the hub page. Run `talaria login` again.
- The hub page says "That code is wrong or has expired": check the code against the terminal (the form takes `ABCD-EFGH`), or run `talaria login` for a new one. After 10 wrong codes in 15 minutes the page says "Too many wrong codes. Wait 15 minutes, then try again."
- The hub page says "None of your agent servers is set up for computers yet", or `/device/pair` is not found: this hub has computers turned off for your agent server. The owner turns it on (`device.enabled` and `backends[].devices` in the hub config; the install files do this for you).
- The page says "You already have a computer with that name": pick another name in the form, or remove the old computer in Settings, Computers.
- The terminal says `too many pairing requests from this address; try again later`: wait a few minutes. The hub limits how often one address can ask for a code.
- The link does not load, or the hub refuses you at that address: the hub's address must be the one people use in the browser (its `public_url`). Open the link the terminal prints yourself, from a browser that is signed in to the hub.
- The terminal says `hub refused the device token; run talaria login`: the stored token is no longer valid (the computer was removed on the hub). Run `talaria setup` or `talaria login` again.

If the code is confirmed and the terminal still waits, the computer cannot reach the hub: see [The computer shows offline](#the-computer-shows-offline-on-the-hub).

## The computer does not show up in the hub, or in the new chat menu

- Settings, Computers lists every computer that was paired, online or not. If it is not listed at all, pairing never finished: see [Pairing fails](#pairing-fails). A computer that was removed there needs a new pairing.
- If it is listed as Offline, the daemon is not connected: see the next section. In the new chat menu an offline computer is greyed out, and when every computer is offline the menu says "All your computers are offline. Turn one on and check that talaria runs on it." A chat that is already on a computer says "<name> is offline" above the message box, and messages you send then fail until it is back.
- Open the computer's row in Settings, Computers. "Disconnected ... The computer closed the connection (code N)" says who ended the last connection (the computer, the agent or the hub) and why.
- The computer belongs to one agent server (the pairing form asks which, when you have more than one). Only chats on that agent server can use it.

## The computer shows offline on the hub

1. Is the daemon running? `systemctl --user status talaria` on Linux, `launchctl list | grep talaria` on macOS (a number in the first column is its process id), `schtasks /Query /TN talaria` on Windows.
2. Can the computer reach the hub? `curl -fsS https://hub.example.com/healthz`.
3. Does the log say `unknown or revoked device token`, or `hub refused the device token`? The computer was removed on the hub, or the hub's database was reset. Pair again with `talaria login`. A log line `this device's agent server is no longer available to its user` means the hub owner took the agent server away from your account.
4. On a headless Linux machine, the service stops when you log out. Run `loginctl enable-linger "$USER"` once.
5. On macOS with a hub on your local network, a log full of `connect: no route to host` means macOS has not let talaria use the local network yet: answer the question on the Mac's screen with Allow, or turn talaria on under System Settings, Privacy & Security, Local Network. See [Add a computer](../start/add-a-computer.md#on-macos).
6. On Windows, `schtasks /Query /TN talaria` should say `Running`. See [Windows: the scheduled task does not run](#windows-the-scheduled-task-does-not-run).

## macOS: `talaria` waits and prints nothing

This happens only with an unsigned build (see Add a computer). macOS blocked a program downloaded with a browser and shows "talaria" Not Opened on the Mac's screen. Press Ctrl-C, choose Done, unpack the archive again and run `xattr -d com.apple.quarantine ./talaria` before the first run. See [Add a computer](../start/add-a-computer.md#on-macos).

## macOS over SSH: `could not read the device token from the OS keyring`

The token is in the login keychain, which macOS keeps locked in SSH sessions. Run the command in Terminal on the Mac, or unlock the keychain first with `security unlock-keychain`.

## The computer keeps disconnecting, or a running command seems stuck

The daemon keeps one WebSocket to the hub and reconnects by itself, waiting a little longer after each failure. These log lines tell what happened:

- `Exec leg lost; reconnecting`: the connection ended. The error after it says why (the network, the hub restarting, a proxy closing it).
- `WebSocket ping failed; dropping the exec leg` or `No message from the device plugin; dropping the exec leg` (silent for 60 seconds): the hub or the agent stopped answering, or something between the computer and the hub holds the connection without passing data. Behind your own reverse proxy, turn off response buffering and request timeouts for `/api/device/` (see [Fix server problems](../deploy/troubleshooting.md#chats-do-not-stream-or-stop-after-a-while)).
- `Keeping commands for a resume`: commands that were running when the connection dropped keep running for a short grace period (up to 10 minutes), so the agent can pick them up again when the computer reconnects. After that they are killed (`Killing commands`).

If a command in a chat never ends, press Stop in the chat: the command is killed (`Killing command` in the log). A command the agent started with a time limit ends at that limit.

## No systemd user manager

Setup stops with `no systemd user manager, launchd or Task Scheduler to run talaria run`. This happens on Alpine, in containers and in WSL without systemd. Run `talaria setup --no-service https://hub.example.com`, then start `~/.talaria/bin/talaria run` yourself from your own supervisor.

## Windows: "Windows protected your PC"

This is Microsoft Defender SmartScreen. Windows shows it when you start a downloaded program from Explorer that has no reputation with Microsoft yet, as unsigned programs such as talaria usually do. Choose More info, check that the app is `talaria.exe`, then Run anyway. Or run `.\talaria.exe setup ...` from a terminal, which does not show it, or run `Unblock-File` on the zip before you unpack it. See [Add a computer](../start/add-a-computer.md#on-windows).

## Windows: Defender removed `talaria.exe`

Microsoft Defender can flag new, unsigned programs. Check the zip against the release's checksum file and its attestation (see [Releases and verification](../releases.md)). If both match, restore the file under Windows Security, Virus & threat protection, Protection history, and report it to Microsoft as a false positive at <https://www.microsoft.com/en-us/wdsi/filesubmission>.

## Windows: PowerShell execution policy

You do not need to change it. `talaria.exe` is a program, not a script, and with the `powershell` shell each command starts PowerShell with `-ExecutionPolicy Bypass` and `-NoProfile`, for that process only. With `git-bash` or `wsl`, commands do not use PowerShell.

## Windows: `WSL has no distribution` or `Git Bash is not installed`

The shell in the config is missing on this PC, and the log repeats the error every 5 seconds while the computer shows offline:

- `WSL has no Linux distribution`: install one, for example `wsl --install -d Ubuntu`, then open it once to create your Linux user.
- `WSL has no distribution "Debian" (found Ubuntu)`: `device.wsl-distro` names a distribution that `wsl --list` does not show. Set it to one that does, or remove it to use your default distribution.
- `Git Bash is not installed`: install [Git for Windows](https://git-scm.com/download/win) (`winget install Git.Git`). The `powershell` shell needs it too.

Then restart the service: `schtasks /End /TN talaria`, then `schtasks /Run /TN talaria`. To pick another shell, set `device.shell` in `%LOCALAPPDATA%\talaria\config.yaml`, or run `talaria setup --overwrite-config --shell <shell>`.

## Windows: the scheduled task does not run

`schtasks /Query /TN talaria` shows the task's status:

- `Running`: the service runs. If the computer is still offline, read the log.
- `Ready`: it is not running. Start it with `schtasks /Run /TN talaria`. The task starts when you log on to Windows and runs only while you are logged on, so it does not run before the first logon after a restart.
- `ERROR: The system cannot find the file specified`: there is no task. Run `talaria setup` again.

Log lines `talaria service: the daemon exited (code N, <error>); starting it again in 5s` mean that the daemon starts and fails; the daemon's own error is on the lines just before. After an automatic update the line says `starting it again in 0s`, which is normal.

## Windows over SSH: `no device token stored`

When setup ran in a desktop session, the token is in Windows Credential Manager, which an SSH session cannot read. The service is not affected. Run commands that need the token, such as `talaria chat`, in a terminal on the PC's desktop.

## `talaria: command not found`

`~/.talaria/bin` is not on your `PATH`. Run `talaria setup` again and say yes when it offers to fix this, then open a new terminal. Commands the agent runs use `bash -l`, so the directory must be on the `PATH` of a login shell too.

## A command was refused: working directory outside the roots

The agent tried to work in a folder that is not under `device.roots`. Add the folder to the config and restart the service, or tell the agent to work inside an allowed folder.

## A command was killed: out of memory

The agent sees `[killed: out of memory ...]`. Only that command was killed. Either the computer ran out of memory, or you set `device.command-memory-max` (there is no cap by default) and the command used more. Raise the cap (for example `16G`) or turn it off with `off`. macOS has no per-command cap.

## The Talaria extension does not connect

- The toolbar button should show a green "on" badge, and its tooltip should read "Talaria: connected". With no badge, the tooltip says "Talaria: not connected": the extension cannot reach the daemon. The tooltip "another Firefox took over; open this button to use this one" means a second Firefox (another profile or window) connected; only one Firefox works at a time, so open the button in the one you want.
- Check that `browser.enabled: true` is in your config and that setup (or `talaria browser install`) registered the native messaging host, then restart the daemon. The daemon log says `Browser extension connected` when it works, `Browser extension disconnected` when Firefox closes, and `Refusing browser host for another extension` when a different extension tried to connect.
- The extension needs Firefox 139 or newer. Flatpak Firefox cannot reach the host. Use a Firefox from your distribution or from Mozilla. Snap Firefox probably cannot either.
- Setup waits 10 minutes (`--wait`) for the extension and then says `The Firefox extension has not connected yet. Install it, or restart Firefox if it is installed`. Install the signed `.xpi` from the release (or choose "Continue to Installation", then "Add" on the page setup opened). If the extension is already installed, restart Firefox.

## The agent says Firefox is not connected

The agent's browser tools stop with one of these messages. The computer is the one the chat runs on, or for a scheduled job the one the job is set to:

- `does not offer browser control`: `browser.enabled` is off on that computer, or the daemon was not restarted after it was turned on. Set `browser.enabled: true`, make sure the host is registered (`talaria browser install`), and restart `talaria run`.
- `Firefox is not running on device ...` or `Firefox ... was not running, so it was started and is connected now. Make the same browser call again.`: the agent starts Firefox itself when the extension is not connected (`browser.start-firefox`, on by default, in your graphical session). Tell the agent to try again. If it did not start (`Could not start Firefox` in the log), check `browser.firefox-command`, and that you are logged in to a desktop session: a computer reached only over SSH has none.
- `the Hermes Firefox extension on device ... is not connected. Firefox must be running with the extension loaded`: Firefox runs but the extension does not reach the daemon. Work through the list above.
- `device ... is not connected, so its browser cannot be used`: the computer is offline. See [The computer shows offline](#the-computer-shows-offline-on-the-hub).
- `scheduled job ... has no browser device`: a scheduled job that needs the browser must name the computer whose Firefox it uses. Edit the job on the Scheduled page.
- The agent waits for you instead of acting: for clicks, typing and other steps you cannot undo, it asks first. The question is an approval; see [Approvals](../deploy/troubleshooting.md#an-approval-or-question-is-stuck).

## `update` refuses a release

- `the release archive's attestation did not verify`: do not install it. Check you are connected to GitHub directly and try again. Only on an emergency, and only if you checked the file by hand, `--insecure-skip-attestation` skips the check.
- `refusing to replace a newer talaria`: you have a newer release. Use `--force` to go back.
- GitHub rate limit: the program caches the lookup and backs off by itself. Try again later.

## `chat` cannot start the agent

- On Linux, `chat` downloads the server's agent build on first use. Check disk space (about 1.4 GB) and that the computer can reach the registry that holds the image. `talaria chat --status` shows what it knows.
- With a local agent install (macOS, or `chat.managed: false`), it must be the same release as the server's. `talaria chat` says which two releases differ.

## Still stuck

Collect the version (`talaria --version`), the last 100 lines of the log and the steps you took, and open an issue at [github.com/USA-RedDragon/talaria](https://github.com/USA-RedDragon/talaria/issues). Remove tokens from anything you paste.
