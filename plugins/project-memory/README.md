# project-memory

One memory per project, next to Hermes's global memory. A project is the git repository of the
folder a chat is bound to on a device (the Talaria device plugin's `/device <device> <dir>`), identified by its
normalized origin URL (`github.com/alice/demo`), else the upstream or only remote, else the oldest root commit;
a folder outside git is identified by device and folder. Clones, worktrees and mirrors on several computers
share one memory.

The memory has three parts, modeled on how Claude Code keeps project knowledge:

- **The index** (`MEMORY.md`): short lines, one fact each, in the system prompt of every chat in the project. It has
  a character budget (`char_limit`, below). It is the only part that is always loaded.
- **Topics** (`topics/<name>.md`): the detail behind the index, as markdown with a name, a one-line description and
  a last-changed date. Any number, any length (one file holds at most 1,000,000 characters; long ones are read in
  pages of 150,000). Only their names are in the prompt; the agent reads one when a task needs it.
- **Path notes** (`paths/<name>.md`): rules for one folder or file type, with glob `paths` relative to the
  repository root (`src/ppu/**`, `*.sql`; a pattern without a slash matches at any depth). The first time in a chat
  that `read_file`, `write_file` or `patch` touches a matching file, the note is added to that tool result. Each note
  loads once per chat, up to 6,000 characters per tool result; other matching notes are named so the agent can read
  them.

Provides:

- the `project_memory` tool:
  - `read`: the index, the topics and the path notes; `topic=<name>` or `path_note=<name>` reads one (with
    `offset` for long ones); `query=<words>` searches the index, topics and path notes. `list` lists the topics and
    path notes.
  - `write` with `operations`: `add`, `patch`, `replace`, `remove` on the index (as before; `add` with `topic` puts
    the text in that topic and a one-line pointer in the index); `topic_write`, `topic_append`, `topic_patch`,
    `topic_remove`; `path_write` (with `paths`), `path_remove`.
  - same write approval queue and background-review staging as Hermes's own memory tool (topic and path note
    rewrites and deletions count as changes);
- a `project-memory` prompt section: the index, the topic and path note names, an inbox count, and a warning at 80%
  of the index budget; frozen with the prompt like the global memory block;
- a `transform_tool_result` hook that adds matching path notes to file tool results;
- hub routes under `/api/plugins/project-memory/` for the Memory page;
- a note in the built-in `memory` tool description that sends project facts here.

Subagents can read project memory (index, topics, path notes) but not write it, as they cannot write the global
memory.

## A full index never refuses a write

When an index write would go over the budget, it still succeeds:

1. Each added text (and each replaced or patched entry) goes into a topic: the one named with `topic`, else the
   existing topic it fits best (shared words with the topic's name and description), else a new topic named after
   its first words. The index gets a one-line pointer, `<first sentence> -> topic: <name>`, unless it already
   points to that topic. The result says what moved where.
2. If even the pointers do not fit, the texts go to the `inbox` topic, only the deletions in the batch apply, and
   the result says the index needs cleanup. The prompt then shows how many unsorted notes the inbox holds.

From 80% of the budget on, the tool result and the prompt warn the agent to merge or shorten old lines and move
detail into topics. The hub's add and edit of index lines follow the same rule.

## Migration

The first time the plugin loads a store from before topics (0.5.0 and earlier), it copies `MEMORY.md` to
`MEMORY.md.bak-<date>-<time>` next to it (never deleted), keeps entries of at most 200 characters in the index, and
turns each longer one into a topic with its full text, leaving its first sentence and a pointer in the index.
`meta.json` records `layout: 2`, the time and the backup's name, so it runs once per project; loading again changes
nothing. A store that cannot be migrated (an unreadable file) is left as it was and tried again on the next load.

## Project skills

With the Talaria Hermes patch `0094-project-skills`, the project also has skills, kept next to its notes in
`$HERMES_HOME/project-memories/<slug>/skills/` (same slug, so clones, worktrees and mirrors share them). The plugin
registers the project of each session with Hermes; `skill_manage` then takes `scope: project` or `scope: global`.

- A project skill is listed (marked `[project]`), loaded and edited only in chats bound to that project and in their
  subagents, and wins over a global skill of the same name there. It needs no trust entry.
- Project skills hold knowledge about the one codebase: layout, commands, people, conventions, and a project-specific
  lesson found while using a global skill. A global skill is only for a procedure that applies across projects and is
  written generically: no project names, repo paths, hostnames or usernames. The prompt block, the `skill_manage`
  description and the memory tool description say so, and a global skill that names the project gets a warning.
- A chat with no project keeps every skill global, as before. On a Hermes without the patch nothing changes.
- With the device plugin's skill mirror configured, project skills are committed to the same repository under
  `projects/<slug>/<skill>`.
- The hub's project list carries `skills`, the number of project skills, and `topics`, `path_notes`, `inbox` and
  `total` (characters in the index, topics and path notes together).
- Hub routes (under `/api/plugins/project-memory`): `GET /projects/<slug>/skills` lists them (name, folder, description,
  on or off), `GET /projects/<slug>/skills/<name>` returns one with its SKILL.md text, `DELETE` removes it.

`scripts/audit-global-skills.py` (in the plugins directory) lists global skills that look project-specific, as a
read-only report.

## Config

```yaml
plugins:
  entries:
    project-memory:
      settings:
        char_limit: 8000   # optional; default: memory.memory_char_limit; either is held between 200 and 32000
        write_approval: false   # optional; true or false overrides memory.write_approval for project notes only; unset follows it
```

`write_approval: false` saves project notes directly while Hermes's own memory stays gated. `true` stages them even when `memory.write_approval` is off. Writes already staged under `/memory pending` stay staged; only new writes follow the setting. Background review still stages changes and deletions (index patch, replace and remove; topic and path note writes, patches and deletions); `add` and `topic_append` go through.

`char_limit` is the index budget only; topics and path notes have no budget. The prompt holds the index up to `char_limit` plus a header of up to 2,000 characters (the guidance, the topic and path note names, the warnings), as far as Hermes allows a plugin section. Hermes caps a section at 4,000 characters unless `plugins.max_section_chars` is raised in its config, so with `char_limit: 8000` set `plugins.max_section_chars` to 10000 or more (the plugin asks for at most 34,000; all sections together may use that value plus 4,000). The plugin logs a warning at load when the allowed size is below that. When the index is longer than the section, the prompt shows the lines that fit, in order, and says how many it left out; the agent reads the rest with `project_memory action read`.

```yaml
plugins:
  max_section_chars: 12000
```

This setting needs the Talaria Hermes patch `0091-plugin-section-max-chars`; a Hermes without it keeps 4,000.

## Files

```
$HERMES_HOME/project-memories/<slug>/
  MEMORY.md                    the index (entries separated by a line with only §)
  MEMORY.md.bak-<date>-<time>  the store as it was before the migration
  topics/<name>.md             front matter name, description, modified; markdown
  paths/<name>.md              front matter name, description, paths, modified; markdown
  skills/                      project skills
  meta.json                    identity, aliases, folders seen, layout
```

Names are 1 to 64 lowercase letters, digits and dashes. The files are plain markdown and can be edited by hand.

## Hub routes

Under `/api/plugins/project-memory`, behind dashboard sign-in:

| Route | What it does |
|---|---|
| `GET /projects` | the projects with their counts and sizes |
| `GET /projects/<slug>` | the index (in the device plugin's `/memory` shape) plus `topics`, `path_notes`, `inbox` |
| `POST /projects/<slug>/memory/{add,edit,remove,replace}` | change the index; add and edit move detail into a topic when it is full and say so in `message` |
| `GET /projects/<slug>/topics`, `GET /projects/<slug>/paths` | the topics or path notes, without their text |
| `GET /projects/<slug>/topics/<name>`, `GET .../paths/<name>` | one, with its text |
| `PUT /projects/<slug>/topics/<name>`, `PUT .../paths/<name>` | create or change one: `content`, `description`, `paths` (path notes), `name` (rename), `create` (refuse when it exists), `base` (refuse when it changed since) |
| `DELETE /projects/<slug>/topics/<name>`, `DELETE .../paths/<name>` | delete one |
| `GET /projects/<slug>/skills`, `GET`/`DELETE .../skills/<name>` | project skills |
| `GET /pending` | staged project writes in Hermes's memory approval queue |
