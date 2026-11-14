# Let the agent use Firefox

With browser control on, the agent can open pages, read them, click and type in your own Firefox, with the logins you already have. It works only in its own tab group, named "Talaria", and you see every tab it opens.

This needs Firefox 139 or newer, from your distribution or from Mozilla. The Flatpak build cannot reach the native host, and the Snap build is untested. Chrome, Chromium, Edge and Safari are not supported.

## Turn it on

`talaria setup` turns browser control on when it finds Firefox. To do it by hand:

1. Set `browser.enabled: true` in `~/.config/talaria/config.yaml`.
2. Register the native messaging host, which is how Firefox starts the program the extension talks to:

   ```sh
   talaria browser install
   ```

3. Restart the daemon: `systemctl --user restart talaria` on Linux.
4. Install the extension. Download `talaria-firefox-<version>.xpi` from the [latest release](https://github.com/USA-RedDragon/talaria/releases/latest). In Firefox, open `about:addons`, choose the gear menu, then "Install Add-on From File..." and pick the file. Mozilla signs the file, so it stays installed, and Firefox updates it from later releases.

## Connect Firefox

Firefox starts the extension's connection to the daemon, so the daemon and Firefox both have to be running. Check it in either place:

- The Talaria button in Firefox's toolbar shows a green "on" badge, and its tooltip reads "Talaria: connected".
- Ask the agent to run `browser_status`. It says whether the chat has a computer with Firefox connected, and which.

If the badge is missing, check that the extension is enabled in `about:addons`, that you ran `talaria browser install` and that the daemon runs. [Troubleshooting](troubleshooting.md) lists the usual causes. Only one Firefox connects at a time: when you open the Talaria button in a second Firefox, that one takes over and the first disconnects. With more than one computer that has browser control, the agent uses the browser of the computer the chat is bound to, or the one it picks with `browser_use_device`.

If the release you installed has no `.xpi` file, no signed extension was published for it. Install the next release, or load the extension for development: `talaria browser extension --out ~/talaria-extension`, then in Firefox open `about:debugging#/runtime/this-firefox` and choose "Load Temporary Add-on...". A temporary add-on goes away when Firefox restarts.

## What the agent can do

It can list, open and close tabs in its group, go to a page, go back, read a page's text or an outline of it, take a screenshot, click, type, choose an option in a select box, press keys, hover, scroll and wait. With the saved logins of Firefox it can also sign in on the hosts in `browser.autologin-hosts` (the agent never gets the password). It cannot download or upload files, answer browser permission prompts or dialogs, or touch tabs outside its group. A tab you drag into the group becomes the agent's, and a tab you drag out is no longer.

It never opens pages on your private network. Requests from its tabs to loopback, private, link-local and `100.64/10` addresses and to `.local`, `.internal` and `.home.arpa` names are blocked. To allow one host, add it to the config:

```yaml
browser:
  allow-hosts:
    - nas.home.arpa
```

## Steps in one call

When the agent has the steps for a page, such as filling in a form, it sends the whole sequence as one `browser_batch` call (up to 25 steps: click, type, press, select, hover, scroll, wait and navigate) and reads the page once at the end. It stops at the first step that fails unless it asked to go on. If the page redraws between steps, the agent finds the same element again by its role and label. The ask-before rules below apply to each step, and a batch asks once for all of them, in plain words, before it starts. A step that needs an approval the batch did not list stops the batch.

In the web app, a batch is one card, with one line for each step and how it ended (done, failed or not run), and the page it read at the end. Cards for single browser steps and for each batch step name the element by the label the page gives it, such as "Typed into Search" or "Clicked Sign in", never by an internal reference like `e12`. What the agent typed is not shown on the card or put in the label.

## When it asks you

The agent asks before it does anything you cannot easily undo. The question appears wherever you talk to the agent: the web app, Telegram or your editor.

| The agent needs to | It asks |
|---|---|
| Read, screenshot, scroll, hover, wait, go back | Never |
| Click or type without submitting anything | Never |
| Open a site it has not used in this session | Once per site per session |
| Submit a form | Once per site per session |
| Click or type on a page with a password, payment or one-time code field | Every time, also for each step of a batch |
| Run a script on a page | Once per site per session, every time on a page with secret fields |

A site is the host name without a leading `www.`, so `accounts.example.com` and `example.com` are asked about separately. You can answer once, for the session, always, or deny.

Two settings make this stricter, and only the config file on your computer can change them, so the server cannot weaken them:

```yaml
browser:
  confirm-hosts:      # ask every time for any click or Enter here; scripts may only read
    - bank.example.com
  start-firefox: false   # do not let the agent start Firefox when it is closed
```

## Stop it

Any of these stops browser control at once: close the "Talaria" tab group, disable the extension in `about:addons`, stop the daemon (`systemctl --user stop talaria`), or remove the computer on the hub.

## Scheduled jobs

A scheduled job keeps the browser computer of the chat that created it: its commands run in the sandbox and its browser steps run on that computer. A chat that runs in the sandbox uses the Firefox of your one computer with browser control, or the one the agent picks with `browser_use_device`. With `browser.start-firefox` on (the default), the agent starts Firefox in your desktop session when it is closed, with your default profile, so a job still works at night. The computer must be logged in with a desktop session.

The design, every approval rule and the security model are in [Browser control design](../browser.md).
