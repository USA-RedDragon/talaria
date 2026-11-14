# Claude accounts

A Talaria server can run its chats on Claude **subscription accounts** (Pro, Max, Team or Enterprise logins) instead of, or next to, an API key. You can give the agent several accounts. They form a **pool**: a chat picks the Claude model like any other model, and the agent chooses which account runs it.

This page is for the person who runs the server. It covers adding accounts, signing them in, how the pool picks an account, what the limits mean, and what to do when it does not work.

## What does what

Two programs share the work:

- **The agent** (Hermes, with the Claude accounts plugin) owns the accounts. The plugin keeps the Claude accounts, runs the chats on them, reads their usage and names the account for each chat. Its routes are under `/api/plugins/claude-accounts` on the agent's dashboard. The plugin is not part of the hub.
- **The hub** shows the accounts and their usage, signs an account in on request, and tells people when an account lost its login. It stores no Claude login and no Claude token. It reaches the plugin with its own dashboard login to the agent.

The hub does not choose accounts and has no setting that changes the pick. What it shows about the pick is the plugin's answer. A server whose agent has no Claude accounts plugin shows none of this: the Claude cards and the sign-in controls do not appear.

## Add an account

An account is a **slot** in the agent's settings. Add the slot there, then sign it in from the hub.

1. Add the slot to the agent's `config.yaml`, under the plugin's settings:

   ```yaml
   plugins:
     entries:
       claude-accounts:
         settings:
           accounts:
             - id: main
               label: Claude (main)
             - id: spare
               label: Claude (spare)
   ```

   - `id` is lowercase letters, digits and dashes, starting with a letter or digit, at most 32 characters. A bad or repeated id is skipped.
   - `label` is the name people see. Without one, the id is the name. A label in the form `Claude (name)` shows as just `name` in the pool card's "Next room back" line.
   - With the Helm chart, put this under `hermes.config`, which is merged over Talaria's settings on every start. Elsewhere, edit the agent's `config.yaml` in its data folder.
2. Each slot keeps its login in its own folder, `<accounts root>/<id>`. The Claude Code usage counter (see the last section) looks for these folders in `$CLAUDE_ACCOUNTS_ROOT`, else in the `claude` folder inside `$HERMES_HOME`. Keep the folders on the agent's persistent volume.
3. A slot that has no login shows as **Not signed in**.
4. Sign it in (below).

An account's **API credits** are billed through a provider named `claude-api-<slot>`. Its models show in the model list under "Claude API credits", such as "Opus 5.5 (main credits)". These providers are separate from the subscription pool and are never part of its totals.

## Choose who signs accounts in

Signing in decides which Claude login the agent uses, so the hub keeps it to named people. Set `claude.admins` in the hub's settings (environment variable `HUB_CLAUDE_ADMINS`) as `user=backend` pairs:

```yaml
claude:
  admins: [alice=main]
```

- Empty, the default, means nobody. Hub admins are not Claude admins unless listed.
- The user and the backend must exist, or the hub refuses to start.
- Other people who may use the backend see usage only. They never see a sign-in link, and the hub answers `403` when they try to start, read, answer or cancel a sign-in.
- `claude.time_zone` sets the time zone of reset times. It defaults to `ui.time_zone`, then the server's zone.

## Sign an account in

Only a Claude admin of the backend sees the buttons. On **Usage**, under **Subscription accounts**, each account has **Sign in** (or **Sign in again** when it is signed in):

1. Click **Sign in**. The dialog names the account and why it needs a sign-in: the first time, or the login expired or was revoked. It also shows the email the account last used.
2. Open the Claude sign-in link and sign in with the Claude account that belongs to that slot. Compare with the email the dialog names.
3. Claude shows a code. Copy all of it, paste it into the dialog and click **Send code**.
4. The dialog shows the email the account signed in to, or why it failed. **Cancel sign-in** stops a running one.

Things to know:

- A sign-in that is not finished expires. The dialog then says "The sign-in took too long and was stopped." Start again.
- Sending the code can take up to 90 seconds.
- The code goes straight to the agent. The hub does not log, store or send it back, and the box is cleared when you send it. The sign-in link goes only to the admin who asked.
- The hub trims spaces around the code. A code with a space inside it, a control character, or more than 4096 bytes is refused before it reaches the agent.
- If a sign-in is already running for the slot, the dialog continues it instead of starting a second one.

### Sign in from Telegram

When a chat's account loses its login, each Claude admin of that backend gets the notice "A Claude account needs a sign-in" (the **Claude sign-ins** kind in the notification settings, which only Claude admins see). On Telegram the bot starts the sign-in for that admin and sends the link, in their private chat or in the General topic of their linked group. Reply to that message with the code. Only that admin's reply counts. The bot deletes the message with the code when it may, and edits the sign-in message to show the result. Web Push notices never carry the link; they say to open the hub.

## How the pool picks an account

The pick happens in the agent's plugin, for each turn. What the hub shows about it:

- **A chat stays on its account.** The pool answer says whether the chat is already pinned to an account. The line under the model picker reads "Runs on *account*" and, with the account's weekly reset time, when there is one.
- **A new chat gets the soonest reset with room.** For a chat that is not pinned yet, the line reads "Runs on *account*, the soonest reset with room."
- **Nothing to run on.** When the plugin names no account, the line shows its reason, or "No Claude account can run this chat now."

Both the 5-hour session window and the weekly window are reported per account. The hub's pool totals use the weekly window.

To read the pick from a script, call `GET /api/claude/<backend>/pool?session=<chat>&model=<model>` (see the [Hub API](../../hub/docs/api.md)).

### Rotation

How accounts take turns is the plugin's rule, and the plugin is not part of this repository. The hub shows the line "the soonest reset with room" for a chat that is not pinned yet. The hub never moves a running chat to another account.

## Read the usage

**Usage**, **Subscription accounts** shows:

- **A Claude card on top**: the pool as one number. "Week: 42% used" is the average of the weekly share used over the signed-in accounts whose usage could be read, each capped at 100%. "About 1.4 accounts of room left" adds up the room left on each. "Next room back" names the full account whose week resets first, and when. If some accounts could not be read, it says so, such as "2 of 3 accounts read".
- **Accounts behind "Show accounts"**: each with its name, email, plan, whether it is signed in, and every window it reports, with the share used and the reset time. Some plans have no 5-hour window; it is left out, not shown empty.
- **API credits**, for an account that has an API key: an estimate such as "about $73 of $100 left, resets Dec 1". It is the plan's monthly credit less what the agent spent through the key since the month started. Use of the key outside Talaria is not counted, and calls with no known price are left out.
- **ChatGPT**, when the agent also runs a ChatGPT plan, listed after Claude with no sign-in button. Sign in to ChatGPT in the agent.

Under a chat's title, a chat on the pooled Claude provider shows "Claude" and the pool's week meter. A chat on one account shows that account's name with its 5-hour and weekly meters, such as "5h 12% (resets 3:40 PM CST)". A meter turns to a warning at 80%.

### How fresh the numbers are

- The hub keeps the account list and usage for 1 minute, and reads again after a reply when what it has is older than 15 seconds.
- A backend found to have no Claude accounts plugin is not asked again for 5 minutes.
- A plugin call times out after 20 seconds. A sign-in call gets more.
- "Usage not available" with a reason means the agent could not read that account's usage right now. It is not the same as 0% used.

## Limits

- **Claude's own limits apply.** Each account has the 5-hour and weekly limits of its plan. Talaria shows them. It cannot raise them.
- **A chat runs on one account at a time.** The hub never moves a running chat. A pool gives you room across chats, not a faster single chat.
- **Signing in needs a person.** The hub cannot sign an account in without an admin pasting the code from the Claude page.
- **API credits are an estimate.** Anthropic offers no API for the balance.
- **Slot ids** are 32 characters at most, of lowercase letters, digits and dashes.
- **One backend, one pool.** Each backend has its own accounts and its own `claude.admins`.
- **Signed-out accounts are left out** of the pool's average and its room.

## Troubleshooting

| You see | Why | What to do |
|---|---|---|
| No Claude cards on Usage and no sign-in buttons | The agent has no Claude accounts plugin. The hub remembers a missing plugin for 5 minutes. With the plugin but no slots, the section says "No accounts." | Add the plugin and at least one slot, and reload after 5 minutes |
| "this agent server has no Claude accounts plugin" | The agent answered 404 or 405 to the plugin's route | Check that the plugin is installed and enabled on that backend, and that the hub points at the right backend |
| "Could not reach the Claude accounts plugin on the agent server" | The hub could not reach the plugin, or its answer was not JSON | Wait for the agent, then look for "Claude request failed" in the hub's log |
| An account says **Not signed in** | First use, or the login expired or was revoked | A Claude admin clicks **Sign in** |
| A chat shows a note naming an account, with **Sign in** | A turn failed with a logged-out error and the plugin confirmed the account is signed out | A Claude admin signs it in. The hub handles one failure per chat and account a minute, and notifies admins at most once per account in 30 minutes |
| "No Claude account can run this chat now." | The plugin has no account to give the chat | Sign accounts in, wait for "Next room back", or pick another model |
| "Ask a Claude admin of this server to sign it in." | You are not in `claude.admins` for this backend | Ask someone on the list, or add the pair and restart the hub |
| 403 on a sign-in route | Same | Same |
| "that code was not accepted; copy the whole code from the Claude page" | The code was cut short, had a space in it, or was too long | Copy the whole code again |
| "that sign-in is no longer the current one; start it again" | Another admin, or the Telegram bot, started a newer sign-in for the slot | Start again. Run one sign-in per slot at a time |
| "no sign-in is running for this account" | The sign-in ended or was cancelled | Click **Sign in** again |
| Signed in, but the account still says **Not signed in** | The hub's list is up to a minute old | Reload after a minute. A sign-in that succeeds clears the hub's cache for that account |
| Accounts sign out after every restart | The accounts root is not on a persistent volume | Put `$CLAUDE_ACCOUNTS_ROOT` (default `claude` in `$HERMES_HOME`) on the agent's data volume |
| Reset times are in an unexpected zone | `claude.time_zone` is unset, so `ui.time_zone` or the server's zone is used | Set `claude.time_zone` to an IANA name such as `Europe/Berlin` |

## Claude Code token counts

This is a different feature with a similar name. Computers that run `talaria run`, and the agent's editor bridge (`acp-host`), can count the tokens Claude Code used and send the count to the hub, for the Claude Code panel on the Usage page. On the agent they read the per-account folders under the same accounts root (setting `usage.hermes-accounts-dir`). They read transcripts and the signed-in account's email, never a login token or what was said. See [Computer settings](../reference/configuration.md) and the [wire protocol](../protocol.md).

## See also

- [Hub settings](../../hub/docs/configuration.md): `claude.admins`, `claude.time_zone`
- [Users, backends and computers](../../hub/docs/admin.md)
- [Notifications](../deploy/notifications.md) and [Telegram](../deploy/telegram.md)
- [Hub API](../../hub/docs/api.md)
