# Memory

The agent keeps two kinds of memory, and the hub shows them on the Memory page.

| Kind | What it is | Needs |
| ---- | ---------- | ----- |
| Notes | The agent's own notes (`MEMORY.md`) | Nothing, on by default |
| About you | The agent's profile of you (`USER.md`) | Nothing, on by default |

Notes and About you are plain text files in the agent's data folder. You can read, edit and delete entries on the Memory page. A meter shows how much of the size limit you used. A chat keeps the memory it loaded when it started, so changes apply to new chats.

Everyone who shares one agent shares one memory. An install here has one agent, so on a hub with several people, they all see and change the same notes. Give each person their own agent if that matters.

## Project notes

When the project-memory plugin is present, the Notes tab also has a picker for per-project notes, keyed by the project's git remote. A project has four tabs: Index, the short lines every chat in the project reads (its meter counts the index only; a line that points to a topic links to it); Topics, the detail behind the index, which you can open, edit, create and delete; Path notes, rules with file patterns that load when the agent reads or edits a matching file; and Skills. The install kits here do not include this plugin, so the picker stays hidden until you add it: copy it from a `plugins/v<version>` release of the Talaria repository and enable it, as [plugins/README.md](https://github.com/USA-RedDragon/talaria/blob/main/plugins/README.md) says. Its prompt block holds up to 4,000 characters of the index unless Hermes's `plugins.max_section_chars` is raised; topics and path notes have no limit.
