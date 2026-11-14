# Approvals and trust

Talaria asks you before the agent does something risky, and it never lets a message from a file, a web page or another agent answer for you. This page covers how a question reaches you, what you can answer, how smart approval decides when to ask, and the settings that tell the agent whom to trust.

The chat, the notices and Telegram are described in the [hub guide](../../hub/README.md). The patches behind smart approval are in [Talaria Hermes patches](../../hermes/README.md).

## How an approval reaches you

An approval is a card in the chat with the command or action and a button for each choice Hermes offers. The same prompt shows in other places, and the first answer wins:

- **The page.** The card sits in the chat. The chat list marks a chat that waits with an amber "Approval" badge (or "Question" for a question), and Alt+Shift+Down jumps to the next chat that needs you. A card that you answered shows "Sent. Waiting for the agent to confirm." until Hermes settles it, and offers its buttons again if Hermes does not confirm in time.
- **Telegram.** A chat attached to Telegram, or a chat's topic, shows the prompt with buttons: Once, This chat, Always, This source in this chat (when Hermes offers it) and Deny. Afterwards the message says what became of it and where, such as "Allowed always (in the hub)". See [Telegram](../../hub/README.md#telegram).
- **Your phone.** An approval or question that nobody answers gets a notice (Telegram and Web Push), and one reminder after `notify.remind_after`. See [Notifications](../../hub/README.md#notifications).
- **A paired computer or an editor.** They can answer too. The hub records answers that pass through it. For an answer given in an app that talks to Hermes directly it shows only "Allowed (in another app)" or "Denied (in another app)", without a scope.

An approval waits for as long as Hermes's `approvals.timeout` says, and a question for `agent.clarify_timeout`; a question that runs out returns Hermes's usual timed-out reply to the agent, and Telegram then shows "Expired". A prompt that Hermes cancels or that is answered elsewhere closes the card with a line that says so.

### Subagents ask in the parent chat

A background subagent that needs an approval, or has a question, asks in the chat that started it. The card names the subagent, as `Subagent "<goal>" asks: ...`, and the prompt belongs to the chat, not to the turn that started the subagent: it stays when that turn ends, and you can answer it from an idle chat. The Activity sidebar puts an approval into a subagent's row when it can tell which row asked, and the chat card always shows it. The hub does not link such an approval to a tool call of the chat, because the call that runs in the chat did not ask. A question of a subagent takes your typed message only while it waits for free text; to answer a choice question, use the card's buttons, so that a message meant for the idle chat never cancels it. See [Subagents and lanes](subagents-and-lanes.md).

## The choices

| Choice | What it does |
|---|---|
| Allow (Once) | Runs this one action. |
| Allow in this chat (This chat) | Runs this kind of action in this chat from now on. |
| Always allow (Always) | Adds the command to the agent's allowlist, for every chat that uses this Hermes profile. It writes only `command_allowlist` in `config.yaml`; the deployment's locked settings stay as they are. |
| Always allow code from this source in this chat (This source) | Records a [grant](#chat-grants) for the repository this code comes from, kept with this chat. Only smart approval offers it. |
| Deny | Does not run the action. The agent reads that the user denied it. |

Hermes decides which choices a prompt offers; the page and Telegram show exactly those.

## When Talaria asks

Under Settings, Agent, "Before risky commands" has three settings, for everyone on the backend (admins change it):

- **Ask every time** (`approvals.mode: manual`): every command that Hermes treats as risky asks.
- **Ask only when a command looks risky** (`smart`): smart approval decides, see below.
- **Never ask** (`off`): nothing asks, for every chat of the profile. Agent messages run without approvals too.

Anyone can turn asking off for their own chat only ("Never ask in this chat", what `/yolo` does). The hub does not deliver an agent message to a chat in that mode, because what the message leads to would run with no approval you see. The keys that the install owns (`agent.locked_keys`, which the Helm chart fills from `hermes.config`) show read-only as "Set in the deployment config", `approvals.mode` can be one of them.

## Smart approval with provenance review

Upstream's smart mode looks only at commands that match a pattern list. Talaria's patched Hermes adds a review that asks one question of every tool call that is not plainly read-only: did the user ask for this, or something that includes it? It is patch `0077-smart-approval-provenance` and is on in a Talaria install (`approvals.smart_provenance: true`, set by the install's init step unless you set your own value). It takes effect when `approvals.mode` is `smart`.

**What the review sees.**

- The user's own words: your typed messages, steers, messages that still wait, your answers to the agent's questions (see [below](#your-answers-to-questions-count)), and answers sent from a page, each with its time.
- The session's earlier calls that were not read-only, each with an ok, error or blocked line.
- Repo instruction files, labeled as not the user.

**What it never sees.** Tool results. A file, a page, a script's output or another agent's message therefore cannot approve a risky action, however it is worded. Peer-agent messages, subagent results, a parent agent's goal or steers, recalled memory and gateway notices are never read as the user's words.

**How it decides.** Stage 1 is a one-token check that leans toward blocking (`approvals.smart_fast_model`). Only its blocks go to stage 2, which reasons about the user's intent, applies the allow exceptions and names the rule it blocks on (`approvals.smart_model`). Both fall back to the approval task's model (`auxiliary.approval`) when empty. The rules come in three kinds:

- **Hard rule.** Secrets or private data leaving the machine. Nothing said in chat clears it, and a hard block is final.
- **Soft rules.** Risky actions such as a force push, a deletion or a publish. They clear when the user's words name the action and its target, or when the target is clear from what you or the agent's own work set up.
- **Allow exceptions.** Ordinary work that the rules let through. Plain project file writes are not judged by their text; writes to instruction, config, credential and shell-startup files are reviewed.

`approvals.smart_rules` adds your own rules: `hard_block`, `soft_block`, `allow` and `environment` lists, each entry `{name, must_name, text}` or `"Name: text"`.

**The override card.** A soft block, or a review that cannot decide, becomes a one-time card that reads `Smart approval rule "<name>": <reason>` with the usual choices. You approve it or deny it yourself. When nobody can answer, the action is blocked. A held card is reviewed again when you write in the chat, and it settles as allowed once if your new words clear it.

**When the review model fails.** A failure never allows. If the call fails for a provider limit or a transient error (429, a plan limit, a timeout, an overload, a 5xx), the review tries once more on the same route (a `claude-pool` provider moves to its next account) and then runs stage 2 on the stage-1 route. If every route fails the card says "Smart approval could not review this: the review model was unavailable ... Approve or deny it yourself." with the reset time of the pool when it has one. A reply with no verdict is retried once with a stricter format line.

**Subagents.** A subagent is judged against the root chat's user messages, read from the session store at each review, so a message you write after the subagent started counts. A nested subagent reads the same root chat. If the root chat cannot be read, the review is unsure and asks you; a subagent's own transcript is never read as yours.

**Local review models.** A self-hosted judge (an `http(s)` endpoint such as Ollama, llama.cpp or vLLM; a `process://` provider such as `claude-pool` counts as hosted) is held to stricter rules, because small models allow too much:

- A command that runs in, or names, a path the session cloned, unpacked or downloaded (code from outside) skips stage 1 and goes to stage 2. A self-hosted stage-2 allow on it becomes a question to you. A hosted judge's allow stands.
- A command that upstream's dangerous-command patterns flag (such as `curl | sh` or a force push) also skips stage 1, and a self-hosted allow on it asks you.
- A prompt larger than the judge's served window is not sent, and a reply that shows the server cut the prompt is not used. Both ask you, with the reason in the log.
- A command made only of reading programs never carries the clone hold, also with `2>/dev/null` or `git -C dir`.

### Your answers to questions count

When the agent asks a question (`clarify`) and you pick a choice or type an answer, the review reads it as your own statement, in order with your messages: `User: (answering the assistant's question "...") chose: ...`, or `typed: ...` for free text under "Other". Patch `0102` reads it only from Hermes's own record of an answered question. The same JSON in a terminal command's output, a file, a page, a subagent result or assistant text counts for nothing, and neither does a question that timed out, was cancelled or skipped. A subagent's question that was routed to the chat covers that subagent's next command. A command unrelated to your answer is reviewed as before. Compaction keeps these answers too: the decision ledger records them as yours, with the question each answered.

### Chat grants

A message you write in a chat that lets agents run code from a named repository ("It is approved for agents and subagents to run code in clones of github.com/owner/repo") covers later commands that run code in a clone of exactly that repository (host and `owner/repo`), for that chat and its subagents at any depth, until you withdraw it in the chat. The card choice "Always allow code from this source in this chat" records the same grant. Grants are kept with the chat in the session store (`approval_grants:<session>`), never in `config.yaml`, and compaction does not drop them.

Only your own words grant. Peer-agent messages, subagent results, a parent's goals and steers, tool output and files never do, and another repository, a fork name or a look-alike host is not covered.

### Trusted sources

`approvals.trusted_sources` lists URL prefixes of repositories you own. A path cloned from one of them is not outside code, so running, installing or building it needs no question:

```yaml
approvals:
  trusted_sources:
    - git@github.com:me/
    - https://github.com/me/
```

There is no default. A `..` path, a look-alike host, and a clone made with `-c`, `-u` or `--upload-pack` are not trusted, and a dangerous command pattern still skips stage 1. A grant (above) is per chat and is made by you in the chat; `trusted_sources` is per backend and is set in its config.

## What never approves

| Source | Counts as your approval? |
|---|---|
| Your click, your typed message, your answer to a question, a page you clicked | Yes |
| An agent message from another chat or a subagent | No. It is text, and the frame says so. Only `approval.respond` from your page, Telegram or an editor answers an approval. |
| A subagent's result, a parent's goal or steer | No |
| A file, a web page, a script's output, a PDF | No. PDF text is marked as data from the file. |
| An approval claimed in a summary | No. Compaction labels such claims by their source and never as yours. |

## Settings in one place

| Setting | Where | Meaning |
|---|---|---|
| `approvals.mode` | Settings, Agent, or `config.yaml` | `manual`, `smart` or `off` |
| `approvals.smart_provenance` | `config.yaml` | Turns the provenance review on. True in a Talaria install. |
| `approvals.smart_fast_model`, `approvals.smart_model` | `config.yaml` | Models of stage 1 and stage 2. A name on the approval task's provider, or `{provider, model, base_url}`. |
| `approvals.smart_rules` | `config.yaml` | Your hard, soft, allow and environment rules |
| `approvals.trusted_sources` | `config.yaml` | URL prefixes of repositories you own |
| `approvals.timeout` | `config.yaml` | How long an approval waits for you |
| `agent.clarify_timeout` | `config.yaml` | How long a question waits for you |
| "Never ask in this chat" | Settings, in a chat | `/yolo` for one chat |
| `notify.remind_after` | hub `config.yaml` | When an unanswered prompt gets its reminder |
| `agent.locked_keys` | hub `config.yaml` | Keys the install owns, shown read-only |

## Unattended runs

Hermes does not ask anyone in a scheduled job or a one-shot query. A tool that needs your approval is refused at once in such a run, and the hub sends a failure notice that names the tool and says to approve it once with Always. See [Scheduled jobs and background work](scheduled-jobs.md).
