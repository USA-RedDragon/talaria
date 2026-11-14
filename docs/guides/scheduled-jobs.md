# Scheduled jobs and background work

Talaria runs work that nobody watches: scheduled jobs (Hermes cron), background commands, background prompts and subagents that wait on a long job. This page covers how to see and manage them, how their results come back to a chat (and when they start a turn there), and how you hear about them.

Approvals do not apply the way they do in a chat: Hermes asks nobody in a scheduled job. See [Approvals and trust](approvals-and-trust.md#unattended-runs). Subagents are in [Subagents, agent messages and goals](subagents-and-lanes.md).

## Scheduled jobs

"Scheduled" in the sidebar, with the number of jobs, opens a page with the Hermes cron jobs of every backend the user may use. Times show in `ui.time_zone` (default: the server's time zone, else UTC). "Next 7 days" lists the next run of each job that runs in the coming week. Filters show all jobs, those that need attention (the last run failed or needs a login), active ones or paused ones. A job's row shows its state (a green, red, amber, gray or pulsing dot), its next run, its schedule, where it runs, a badge (Last run failed, Needs login, Result not delivered, Paused, Running) and the result of its last run. "Needs login" uses the same words as the job notices (see [Notifications](../../hub/README.md#notifications)).

A row opens to the schedule (with its cron expression), where the job runs, its model, its skills, where its results go, its instructions and its 5 latest runs, with Run now (Cancel run while it runs), Pause or Resume, Edit and Delete, which asks first. "Open chat" on a run opens the chat of that run. A run row says only how the run ended (Finished, Running, Stopped, or Failed with the latest run's error), not text from the chat.

The hub reads and changes jobs through the cron routes of the Hermes dashboard on the Webapp listener, with its own dashboard login: `GET /api/cron/jobs`, `GET /api/cron/jobs/<id>/runs`, `POST /api/cron/jobs`, `PUT /api/cron/jobs/<id>`, `POST /api/cron/jobs/<id>/pause`, `resume`, `trigger` and `cancel`, and `DELETE /api/cron/jobs/<id>` (`hermes_cli/web_routers/cron.py`). The run list is Hermes's own: agent runs are the sessions of source `cron` of the job, and runs of script jobs come from the job's output files and `cron/executions.db`. The model list comes from `GET /api/model/options` and `GET /api/model/info`, and Hermes's time zone from `GET /api/config`.

- **Run now.** Hermes runs the job inside the trigger call and answers when the run ends, so the hub keeps the call open in the background, for up to 6 hours. Hermes resumes a paused job when it runs it; the hub pauses it again as soon as Hermes claimed the run.
- **New job and Edit.** Hermes reads every schedule; the page never parses one. While the user types, the hub sets the text on a paused draft job of that user (paused reason `Talaria draft: not saved yet`), and Hermes parses it with its own `parse_schedule`. The draft never runs, the page never shows it, and the hub removes it when the form closes, or on a later list when it is older than an hour. "Next:" shows the next two times of what Hermes made of the text: a cron expression on the wall clock of Hermes's time zone, an interval from now, or the time of a one-shot. A six-field cron expression gets no times until the job is saved. A new job is made paused (from the draft, when there is one); the hub then records who made it (`talaria_owner`) and where its results go (`talaria_results`) on the job and resumes it, and removes it again when Hermes does not resume it. A saved job shows Hermes's own `next_run_at`.
- **Fields.** The form sends only the name, the schedule, the instructions, the model with its provider (empty to follow the chat model) and where the results go. It never sends a script, `no_agent`, `workdir`, `monitor_script`, `monitor_url`, `interpreter`, `base_url` or another field that runs or fetches on the Hermes server. A job that has such a field can only be paused, stopped or deleted from the hub, as the talaria plugin allows from a device session (`CRON_SAFE_ACTIONS`).
- **Runs in.** "Sandbox" on a backend with `devices` and a service device, since the talaria plugin runs the tools of a cron run on the sandbox with `fallback: device` (the hub does not read that setting), else "Hermes server". When the talaria plugin gave the job a computer's Firefox (`$HERMES_HOME/device/browser.json`, read through the dashboard's file download), it adds "Firefox on" and the computer's name. Only a chat can give a job a browser, since the plugin asks the user's OK for it (`browser_use_device` with `job_id`), so the form shows this but cannot change it.
- **Results go to.** Hermes saves the result of a job made in the hub with the run (`deliver: local`); the choice sets how the hub tells the user. "This hub only": no Telegram notice for its runs, also not for a failure; Web Push follows the user's settings. "Telegram, General topic": a notice for each finished run, in General or the private chat, also when the user's "Scheduled jobs" notices are off. "Telegram, its own topic": in a linked group each run's chat gets its own topic (see [A topic for each chat](../../hub/README.md#a-topic-for-each-chat)), and General gets only its failures; without a linked group it acts as General. A job that a chat made sends its results into that chat until the user picks one of these (see [A result that wakes its chat](#a-result-that-wakes-its-chat)). Other failure notices follow the user's settings.

The hub checks on every request that the user may use the backend. On a backend that more than one person may use (more than one name in `users`, or any `groups`), a job shows only to the person who made it: the owner that the talaria plugin recorded (`job_owners` in `browser.json`), else the `talaria_owner` the hub recorded. A job whose maker is not known shows to nobody there, and its notices go to every user of the backend as before. On a backend of one person, that person sees every job. The hub acts only on a job's id, though Hermes also takes a name. Every change needs the CSRF token.

### A result that wakes its chat

A chat can ask Hermes to schedule a task (Hermes cron, `cronjob_manage`). Since patch `0103` the result of such a job can start a turn in the chat, not only leave a note, so an agent that scheduled "check the temperature at 6 pm" reads the answer without you asking "so?".

Every job has a `wake` setting, a `cronjob_manage` argument on create and update that its listing shows:

| Job | A result in the chat |
|---|---|
| `wake: true` | Starts a turn. |
| `wake` unset, result goes back to the chat the job was made in (`deliver: origin`) | Starts a turn. |
| `wake: false` | A note. |
| Delivers to another chat of the app, or a script-made job with no origin | A note. |
| A failure | Always a note. |

The result is queued as an input of the chat like any message, so a running turn finishes first and the result then runs as the next turn. Nothing is dropped, and one delivery starts one turn. A note shows as a result card; the Telegram bot sends it to every Telegram chat attached to the session, and a chat started on the page sends its results only to the page until a Telegram chat attaches. A turn that a result started streams like any other turn, on the page and in Telegram. The hub's Scheduled form does not set `wake`; an agent does, in the chat.

A job can also send agent messages when its `enabled_toolsets` include `device-agents`; see [Agent messages](subagents-and-lanes.md#agent-messages).

### How you hear about jobs

The hub reads each backend's jobs every `notify.job_interval` (default 1m) and sends a notice for each run it had not seen: done, failed, or result not delivered. "Scheduled jobs" notices are off by default, failures are on, and each person chooses under Settings, Notifications. A failure whose error names a login says the job needs you to sign in again. A job's chat shows in a linked Telegram group as a topic named "scheduled". See [Notifications](../../hub/README.md#notifications) and [Telegram](../../hub/README.md#telegram).

## Background work

**Background** has the chat's background commands (`terminal` with `background`) and its `/bg` prompts. Stop kills one command (`process.kill`). "Full output" shows what Hermes keeps of a command's output, the last 32,768 characters: Hermes v0.23.1 names no output file for a background command, so there is no file to open. There is no "Run again": Hermes has no method that starts a command again. `/bg <prompt>` (or `/background`) in the message box starts a background prompt (`prompt.background`): a separate agent runs it with the chat's settings, and its answer shows in the row when it is done (`background.complete`). Its tokens come from Hermes's records through the device plugin's usage route. The hub refuses `/bg` in a chat on a computer, and in one taken off its computer: Hermes runs the prompt as a session of its own, so its commands would run where new chats run (the sandbox or the Hermes server) and not on the computer. Hermes stores a background prompt as a chat of its own (`bg_...`). Its row has no link to the chat that started it, so the hub knows it by the `bg_` ID prefix. The hub keeps such chats out of the chat list, the search and Telegram topics, since they belong to the chat that started them. "Open chat" on a finished prompt's row opens its full transcript.

**Run in background.** A running `terminal` card in the chat has a "Run in background" button when the backend's `runtime.describe` lists `tool-background-v1` (from the Talaria Hermes patches in hermes/; Hermes v0.23.1 does not). It sends `POST /api/sessions/<backend>/<session>/tools/<tool call id>/background`, which calls `session.background_tool` with the turn's execution generation. Hermes asks the command to yield: it hands its live process to the background process registry, the tool returns to the model, and the turn goes on. The command then shows in the Background tab, where Stop kills it. The hub answers 501 when the backend lacks the capability and 409 when no command of the turn runs. The hub reads the capabilities once per connection, and the snapshot's `tool_background` tells the page whether to show the button.

### Commands that finish while nobody watches

- **A command that outlives its wait.** `terminal.auto_background_seconds` (0 = off, Talaria Hermes patch `0002`) turns a foreground command that still runs after N seconds into a tracked background process with `notify_on_complete`, instead of running on to its timeout. The talaria device plugin (0.19.5 and later) does the same for commands on a computer.
- **When it ends.** The end of a background command reaches the chat as a "Background command finished" notice card (see [Notices from Hermes](../../hub/README.md#notices-from-hermes)). With `sessions.unviewed_completion_turns` (0 = off, patch `0007`), a `notify_on_complete` exit or a background subagent's result in a chat with no viewer runs as a turn, up to N in a row, instead of waiting as a note.
- **A restart.** With `terminal.process_handoff_backends` (the install lists `device`), a graceful restart hands the background processes of those backends to the next gateway, which reattaches them with the same session, output and `notify_on_complete` routing. Processes on the Hermes server itself still stop with the gateway.
- **A subagent waits for it.** A subagent can end its turn waiting on a background process and wake when it exits; see [Waiting on a background job](subagents-and-lanes.md#waiting-on-a-background-job).
- **Child processes.** With `delegation.keep_child_processes` (patch `0027`, off by default), background processes a subagent leaves running when it ends move to its parent, which can poll, wait on and kill them.

### Unattended runs

Hermes does not ask anyone in a scheduled job or a one-shot query. The talaria device plugin's browser tools refuse a step that needs an approval in such a run, and the hub then sends a failure notice that names the tool and says to approve it once with Always.

### When the gateway stops answering

The patched gateway runs a stall watchdog (patch `0093`). A thread pings the event loop every second. When a ping is not answered within `logging.stall_watchdog_threshold_seconds` (5), it writes `logs/stalls/stall-<UTC time>.txt` with every thread's stack (file, line and function; no locals or arguments), the coroutine chain of the running task, the live child processes by command name and the requests in flight per method, and later the length of the stall. It writes at most one report per 60 seconds and keeps the newest 50. `SIGUSR2` dumps all stacks to `logs/stalls/sigusr2.txt`. `logging.stall_watchdog: false` turns it off. Attach a report to a bug about a slow or frozen chat.
