# Fix server problems

Admins can start in the hub: **Settings, Diagnostics** shows whether each part is working (the hub, the agent,
the sandbox, your computers, Telegram), runs a health check of the agent (it lists real problems and only counts optional logins and tools you have not
set up), and shows the newest lines of the agent's
log with a filter for warnings and errors. **Copy support info** copies all of it for a bug report.

On the server, start with what is running and what it says.

```bash
docker compose ps -a                 # every service, and why one stopped
docker compose logs init             # first start: the address
docker compose logs hub hermes       # the two parts you talk to
```

On Kubernetes: `kubectl -n talaria get pods`, `kubectl -n talaria logs deploy/talaria-hermes` and `kubectl -n talaria logs deploy/talaria-hub -c hub`.

## The images will not pull

- `pull access denied`: every Talaria image is public and needs no login. Check the image names you set (`TALARIA_HERMES_IMAGE` in compose, `images.*` in Helm) and that the host reaches ghcr.io. See [Images](images.md).
- On Kubernetes, the pod is in `ImagePullBackOff`: the same checks; a pull secret (`imagePullSecrets`) is only needed for an image of your own in a private registry.

## I cannot log in

- The setup page says the hub is already set up, and you did not make the account: someone else opened it first.
  Stop Talaria, and if you do not know who that was, start over with `docker compose down -v` (this deletes
  everything), then keep the port closed to others until you made the account.
- You forgot the password: another admin sets a new one under Settings, Users. With no other admin, restore a
  backup or start over (no shell reset command yet).
- Locked after 5 wrong passwords in a row (`auth.local.max_failures`): wait 15 minutes (`lockout`), or an admin sets a new password.
- A redirect to the wrong host after login: `TALARIA_PUBLIC_URL` does not match how you open Talaria. Use the same
  address in both, then `docker compose up -d`.
- With your own OIDC provider, the hub refuses you and logs a `sub`: make an account with their email, turn on `auto_create`, or list the `sub`. See [Set up logins](auth.md#your-own-oidc-provider).

## Chats do not stream, or stop after a while

Behind your own reverse proxy, turn off response buffering and request timeouts for the hub. Replies stream as server-sent events, and the device connections on `/api/device/` are WebSockets. In nginx that is `proxy_buffering off;`, a long `proxy_read_timeout` and the WebSocket upgrade headers. With a Gateway API route, set `timeouts.request: 0s`.

## The model does not answer

- "Talaria has no model yet" (or, for people who are not admins, "No model is set up yet") in the chat area, or
  the model menu is empty: no model is connected yet. This is the required "Connect a model" step of your install
  guide. An admin clicks **Connect a model** there, or opens Settings, Models ([Choosing models and
  providers](models.md#connect-a-model-from-talaria)). Or run `hermes model` inside Talaria's container (Talaria
  has its own agent; nothing else needs to be installed): [Compose](compose.md#step-4-connect-a-model),
  [Unraid](unraid.md), [TrueNAS](truenas.md), [all-in-one](all-in-one.md), [Helm](helm.md#quick-start-try-it-with-port-forward),
  and [Choosing models and providers](models.md#set-a-model-on-the-server).
- Connect a model is not there: only hub admins see it. The first account (made on the setup page) is one; others
  are made admins in Settings, Users, or named in `auth.admins` (login proxy, OIDC). With `models.admins` set, only
  the `user=backend` pairs it names see it, for those backends.
- A model, server or key in Settings, Models says "Set in the deployment config" or "Set in the deployment", with
  no Edit or Remove: the deployment sets it (its managed Hermes config or the container's environment). Change it
  there ([Models the deployment sets](models.md#models-the-deployment-sets)).
- "Could not reach http://localhost:11434/v1/models." when you test an address: The agent runs in its own container,
  so `localhost` is that container. Use the address of the machine that runs the server, and let the server
  listen on it (Ollama: `OLLAMA_HOST=0.0.0.0:11434`).
- "That API key was rejected": the provider refused the key, and nothing was saved. A key "saved, but not
  checked" is one the agent cannot check before it saves it; if replies then fail with an authentication error, edit
  the key in Settings, Models.
- "The sign-in code ran out": a code works for 15 minutes, and a restart of the agent forgets it. Click **Get a new code**.
- "Could not reach the agent" in Connect a model or Settings, Models: the agent is restarting or down. Try again in a moment.
- "Context too small" in the chat, or Talaria warns that a model's window is under 64,000 tokens: pick another
  model (Settings, Models, or `hermes model`). In Ollama, `qwen3` has 40K and `qwen2.5` 32K.
- An error with a status like 401 or 404 from the model: the address, the model name or the key the agent has is
  wrong. Test it again in Settings, Models, or run `hermes model` again.
- A local model is very slow: expected without a GPU. See [Choosing models and providers](models.md#ollama).
- Still the canned reply: the agent still uses `talaria-demo`. Pick another model in `hermes model`.

## The agent is not answering, or a reply stalls

The hub watches every request it sends to the agent. When the agent has not answered one for 15 seconds, the hub ends that connection, logs `gateway connection lost` (the error says `gateway stopped answering on this connection: no answer to <method> in 15s`), and opens a new one. A list of chats is tried once more on the new connection (`gateway stopped answering, listing again on a new connection`). What you see:

- The chat list or a backend shows "The agent is not answering" (it stalled) or "The agent is restarting or cannot be reached" (the connection failed). If it clears in a minute, the agent was busy or restarting. If it stays, look at the agent: `docker compose logs hermes` (`kubectl -n talaria logs deploy/talaria-hermes`), and Settings, Diagnostics.
- You send a message while the agent restarts: the chat says "The agent is restarting. Your message will send when it is back." The hub holds it for up to 10 minutes (`hold.timeout`). Then it says "The agent did not come back in time." and the message shows "Not sent" with **Send again**. If the text says "The agent may have received it before the connection dropped: check before you send it again", look at the chat before you send it twice.
- The reply stops in the middle with no error: the hub drops a page that cannot keep up (`viewer too slow, dropping it`) and you see the rest when you reload the page. If it only happens behind your own proxy, see [Chats do not stream](#chats-do-not-stream-or-stop-after-a-while).
- A turn that runs for a very long time is not stalled: press **Stop**, or send `/stop` on Telegram.
- When the agent stops or updates, compose and the TrueNAS file wait up to 2 minutes (`stop_grace_period`), and the Helm rolling update up to 780 seconds, for running turns to finish. A turn still running after that is interrupted; the chat says so, and you send the message again. Unraid's Docker Stop Timeout (10 seconds by default) is much shorter.

## An approval or question is stuck

The agent asks before it runs something risky (an approval) or when it needs you to choose (a question). It waits until someone answers.

- You do not see the card: open the chat it belongs to. Turn on [notifications](notifications.md) to be told; a prompt that still waits after 5 minutes gets one reminder.
- You pressed a button and the card keeps waiting: the card settles only when the agent confirms it took the answer. Wait a few seconds. If it stays, press Stop and send the request again. The hub logs `Failed to record an approval's answer` when it could not save the answer.
- The card says "Closed: the agent no longer waits for this. It was answered elsewhere, or the agent restarted and dropped it. Nothing was sent from this page.": another page or Telegram answered first, or the agent restarted, which forgets open prompts. Ask the agent again.
- Telegram shows the buttons Once, This chat, Always and Deny.
- You cannot change how often it asks: the install may lock the approval mode (`approvals.mode` shows "Set in the deployment config", read-only, in Settings, Agent). Change it in the deployment config.
- A scheduled job or another unattended run cannot ask. A step that needs your answer is blocked there, and the job reports it.
- Firefox steps ask on the page of the chat too: see [Let the agent use Firefox](../guides/browser-extension.md#when-it-asks-you).

## A Claude account hits its limit or needs a sign-in

This applies when the agent runs Claude subscription accounts (the Claude accounts plugin), shown in Settings, Claude accounts and on the Usage page.

- The line under the model picker says "No Claude account can run this chat now.": every account is signed out or used up for its window. The Usage page shows each account's 5-hour and weekly use, with when it resets, and "Next room back" for the pool. Wait for the reset, add an account, or pick another model.
- With several accounts, a chat runs on the account with the soonest reset that still has room ("Runs on <account>").
- "No account's usage could be read": the hub could not read the usage. The accounts may be signed out, or the plugin is unavailable (`claude-accounts plugin unavailable` in `docker compose logs hub`). Check the agent first.
- A chat ends with a sign-in card ("A Claude account needs a sign-in"): the account lost its login. A Claude admin of that agent server (`claude.admins`) sees **Sign in** or **Sign in again** on the Usage page or under Settings, Claude accounts; everyone else sees "Ask a Claude admin of this server to sign it in." Admins also get a notification. Open the sign-in page it shows, sign in, and send the message again. The hub logs `Claude account needs a sign-in`.
- Sign-in says "The sign-in took too long and was stopped": start it again. "The agent has not shown the sign-in link yet": close the dialog and try again in a moment.
- API credits show "no estimate": the hub only counts what the agent itself spent with that key.

## A scheduled job did not run

Scheduled jobs live in the agent and run while it runs. The Scheduled page lists them with the next run, the last result and a flag.

- No jobs listed, or the page reports an error: the hub could not read the agent's jobs (`Failed to read scheduled jobs` in `docker compose logs hub`). Check that the agent is up.
- The job says **Paused**: press **Resume**. **Done** means a job set to run once has run; it does not run again.
- The next run is at the wrong hour: jobs and the agent's clock use the time zone that an admin picks in Settings, Agent ("For scheduled jobs and the agent's clock"). If the install locks it, it is set in the deployment config.
- The job ran and **Last run failed**, or **Result not delivered**: open the job for the run's error. A job that needs a signed-in site says **Needs login**; sign in again, then use **Run now** to test it.
- **Run now** works but the schedule never fires: jobs fire from inside the agent, so the agent must be running at that time. Check `docker compose ps` and `docker compose logs hermes` for an agent that restarts in a loop.
- No notice when it finishes: "Scheduled jobs" notices are off by default. Failures notify when "Failures" is on. See [Notifications do not arrive](#notifications-do-not-arrive).
- A job that uses a computer's Firefox needs that computer set on the job and online: see [The agent says Firefox is not connected](../guides/troubleshooting.md#the-agent-says-firefox-is-not-connected).

## Pages and notifications do not work

Pages (the agent's HTML pages) and Web Push need HTTPS or `localhost`. On a plain `http://<LAN address>` they stay off. Put the hub behind HTTPS: see [Reach it from other computers](compose.md#reach-it-from-other-computers).

## Notifications do not arrive

Start with Settings, Notifications: choose "Send a test". It sends one test notice to each channel, so you see which one fails.

- No "Turn on for this device" button: the page is not on HTTPS or `localhost`, or the hub has no Web Push key. The install files make the key on the first start; check `docker compose logs hub` for `Web Push enabled`.
- The hub logs `Web Push disabled: set notify.vapid_subject to a mailto: or https: URL, or use an https http.public_url`: the public URL is `http://` and no `notify.vapid_subject` is set. The compose files set it for you.
- A browser stopped getting notices after an upgrade: the key changed. Keep `talaria_secrets` (or the `<release>-keys` Secret) across upgrades and backups, then turn notifications on again in each browser.
- The test arrives on Telegram but not in the browser: the browser blocked notifications for the site (allow them in the site settings, then turn it on again), or the push service is not reachable from the server. The hub logs `Failed to send a push` with the reason. Allow outbound HTTPS to the push services listed in [Notifications](notifications.md#web-push).
- The test arrives in the browser but not on Telegram: your Telegram account is not linked (Settings, Telegram), or the bot is stopped. The hub logs `Failed to send a Telegram notice`. See [Telegram does not answer](#telegram-does-not-answer).
- The test works but the real event does not notify. Check, in order:
  - The event is off in Settings, Notifications. "Long tasks done" (a reply of 2 minutes or more) and "Scheduled jobs" are off by default.
  - Quiet hours are on. Nothing is sent during them; an approval or question that is still open afterwards gets its one reminder later.
  - You have that chat open on a visible page (the hub sees this for about 90 seconds), so there is nothing to tell you. Telegram also stays quiet for a chat attached to a Telegram chat, since the prompt is already there.
  - More than 20 notices went to you in 10 minutes. The hub logs `Too many notices, holding back` and sends the next ones later.
  - A chat that nobody has open is looked at every 15 seconds (`notify.watch_interval`), and scheduled jobs are read every minute (`notify.job_interval`), so allow a short delay.

## A computer will not pair or shows offline

See [Fix computer problems](../guides/troubleshooting.md): [pairing fails](../guides/troubleshooting.md#pairing-fails), [a computer that does not show up](../guides/troubleshooting.md#the-computer-does-not-show-up-in-the-hub-or-in-the-new-chat-menu) and [one that shows offline](../guides/troubleshooting.md#the-computer-shows-offline-on-the-hub). The usual causes: the computer cannot open the hub's public address, the pairing code expired (10 minutes), or the service on the computer is not running. If the hub has no `/device/pair` page, computers are off for it: the hub needs `device.enabled` and `backends[].devices` (the install files set both). In the hub, Settings, Computers shows when each computer last connected and how the last connection ended.

## Telegram does not answer

- Check the token in Settings, Telegram with **Test**, or with `curl https://api.telegram.org/bot<token>/getMe`.
- Only one process can read a bot's messages. Stop any other copy that uses the same token.
- You must link your account first: send `/link` to the bot in a direct message and confirm on the hub page. The bot says "This Telegram account is not linked to a hub user yet" until you do. A link works once and expires after 10 minutes; send `/link` again for a new one.
- The bot does not start, or Settings, Telegram is read-only: a token set by the install (`TALARIA_TELEGRAM_TOKEN`, or the Helm secret) wins over one in Settings. Change it there. The hub logs `Failed to get Telegram updates` with the reason, and retries with a longer wait each time.
- "The hub is restarting. Send your message again in a moment." or "Too many messages are waiting for the agent to come back": the agent is down. See [The agent is not answering](#the-agent-is-not-answering-or-a-reply-stalls).
- Topics do not appear: the group needs Topics turned on, and the bot must be an admin who can manage topics and delete messages. Send `/link` in the group. See [Telegram](telegram.md#a-topic-for-each-chat).
- A file is ignored: the bot cannot download files over 20 MB, and answers with a note.

## Memory (Honcho) is empty

Honcho needs a few chats before it writes facts. Check `docker compose logs honcho honcho-deriver`. If the embedding dimensions in `.env` do not match the model, Honcho fails: they cannot change after it stored facts.

## Out of memory or disk

The agent uses about 275 MB idle and up to about 1 GB during a turn, plus the hub (about 40 MB) and the sandbox (a few MB). The agent's data grows with use: a few GB after weeks. `docker system df` and `docker volume ls` show what is big. Do not remove `talaria_*` volumes: they hold your chats.

## Start over

This deletes all chats and settings:

```bash
docker compose down -v
```

Helm: `helm uninstall talaria -n talaria`, then delete the PVCs and the `<release>-keys` Secret, which uninstall keeps.

## Report a problem

Open an issue in [talaria](https://github.com/USA-RedDragon/talaria/issues) with the install path, the output of `docker compose ps -a` (or `kubectl get pods`) and the relevant log lines. Remove tokens and passwords from anything you paste.
