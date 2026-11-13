---
name: gitna
description: >-
  Gitna is a lightweight local Git workbench that runs in the browser. Use
  this skill when the user mentions Gitna or its Conversations, asks you to
  read, answer or leave comments on code in Gitna, or when you already joined
  Gitna Conversations in this session. Covers opening a folder in Gitna and
  taking part in Conversations through the `gitna` command: joining, reading
  pending messages, replying, starting conversations on code, and
  acknowledging what you handled.
---

# Gitna

Gitna is a lightweight, local Git workbench. It runs a local server for one
folder and opens it in the browser, where people browse files, review diffs
and history, and run everyday Git operations. Gitna uses the installed `git`
and the files on disk, so changes you make with Git or to files show up in
Gitna. There is no separate Gitna command for Git work.

You use Gitna through the `gitna` command:

| Command | What it does |
| --- | --- |
| `gitna [folder]` | Opens a folder (default: the current directory) in Gitna and the browser. It keeps running until it is stopped. |
| `gitna skill` | Prints this skill as Markdown. It installs nothing. |
| `gitna conversations COMMAND` | Takes part in Conversations. The commands are experimental; `gitna conversations --help` lists the current ones. |

## Conversations

People comment on lines of code in the Gitna browser UI: in files, in
working-tree and staged diffs, in commits, and in comparisons. You take part
from your own session with `gitna conversations`. Gitna stores every message
on the local machine, outside the repository, so nothing is lost while you
are disconnected. Gitna does not push messages to you; you receive them when
you run `pending`.

### Requirements

- Gitna must be running with the repository open. Otherwise a command fails
  with "no running Gitna session".
- Run commands from inside the repository, or pass `--repo <dir>`.
- The data commands print JSON on stdout. `gitna skill` prints this skill
  as Markdown. Errors go to stderr as `{"error": "..."}`. The exit status
  is 0 on success, 1 when a command fails (Gitna not running, unknown
  participant, not found, an id already used, a missing argument such as
  `--id`), and exit status 2 when the command line is invalid (unknown
  command or flag, missing `--participant`).
- Message bodies are read from stdin, or from `--body` or `--body-file`.
  A quoted heredoc (`<<'EOF'`) passes text unchanged, without escaping.

### Join once, then reuse your participant id

```sh
gitna conversations join --as <name>
```

The output has `participant.id` (for example `agent:p_3f9c...`). The id owns
your inbox and your acknowledgments. The name is only what people see; it is
"Agent" when you leave out `--as`. Several participants may share a name;
the browser then shows a short id suffix next to it.

Pass the id to every other command with `--participant <your-id>`. Using the
same id after a reconnect, a new turn or a Gitna restart gives you the same
inbox. A new id receives only messages sent after it joined; earlier
conversations stay readable with `list` and `show`. Ids belong to one
repository. An id that Gitna did not issue fails with "unknown participant".
The id routes messages; it is not a password.

`gitna conversations leave --participant <your-id>` removes you from the
joined agents, so you are no longer a default recipient. Your id, history and
acknowledgments stay; `gitna conversations join --participant <your-id>`
rejoins as the same participant. Joined means taking part, not that an agent
is running.

### Who receives a message

A message is pending only for the participants in its `to` list:

- Name recipients with `--to <participant-id>` (repeat it for several). The
  `agents` list of `session` has the ids of the joined agents.
- A person's message without recipients goes to the agents last addressed
  in that conversation, otherwise to the agent that wrote there last,
  otherwise to the only joined agent. With several joined agents and nothing
  to go by, it is unassigned: readable, but pending for no one.
  `conversation.defaultTo` shows who that is.
- An agent's message without `--to` is pending for no other agent. People
  see every message in the browser.

### Read pending messages

```sh
gitna conversations pending --participant <your-id>
```

Each entry has:

- `message`: the new message, with `seq`, `author` (`kind` is `human` or
  `agent`) and `body`.
- `conversation`: the whole thread, with its `id` and earlier messages.

The code a conversation is about:

- `conversation.anchor` is the code it was started on. `path`, `startLine`,
  `endLine` and `code` (the original text) say which lines; `before` and
  `after` are the lines around them.
- `anchor.source` is the content those lines belong to: `worktree` (the file
  on disk), `index` (`git show :<path>`), or `commit` (`git show
  <revision>:<path>` for `anchor.revision`).
- `anchor.view` is where the person was looking: `file`, `worktree`
  (unstaged diff), `index` (staged diff), `commit` or `comparison`. In a
  diff, `anchor.side` is `deletions` for the old side, and `anchor.against`
  is the commit on the other side.
- `conversation.location` is where that code is now. Its `status` is
  `current`, `moved` (use the new line numbers), `outdated` (the code was
  changed; rely on `anchor.code`) or `missing` (Gitna cannot find the code;
  the browser hides the conversation but keeps it). When the file is gone
  but Git still has the code, `location.source` is `index` or `commit`, with
  the commit in `location.revision`.
- `conversation.status` is `open` or `resolved`. A person's reply reopens a
  resolved conversation.

### Reply

```sh
gitna conversations reply <conversation-id> --id <new-message-id> --participant <your-id> <<'EOF'
Renamed `x` to `count` in src/a.go:12. Tests pass.
EOF
```

### Message ids

Every `create` and `reply` takes an `--id` you choose: 1-64 letters, digits,
`_` and `-`, unique in the repository, for example `r-` plus the seq you
answer plus a short word, such as `r-42-rename`. Sending the same command
again with the same `--id` and body stores the message once, so a `create` or
`reply` that failed or timed out can be retried safely. An id that is
"already used" belongs to a different message; send yours with a new id.

### Acknowledge

```sh
gitna conversations ack <seq> --participant <your-id>
```

Messages up to that `seq` stop being pending for your id. Unacknowledged
messages stay pending across restarts of your session and of Gitna.
Messages in deleted conversations, and in conversations whose code is
`missing`, are not pending. An `ack` that passes over them keeps them, and
they become pending again if the conversation is restored or its code
returns. A `pending --wait` then wakes up for them.

### Wait for messages

```sh
gitna conversations pending --wait 600 --participant <your-id>
```

`--wait <seconds>` blocks until a message is pending, or returns an empty
list after the timeout (at most 600 seconds per call). It cannot interrupt
or wake you. Run in the background, it helps only if your runtime reports
when the process exits; otherwise run `pending` when you join or resume, at
checkpoints in longer work, and before you finish.

### Start a conversation

```sh
gitna conversations create --path src/a.go --lines 10-14 --id <new-conversation-id> --participant <your-id> <<'EOF'
This retries without a limit. Should it give up after 3 attempts?
EOF
```

Gitna records the code on those lines of the file on disk. For staged code
add `--source index`; for committed code add `--source commit --revision
<id>` with the full commit id from `git rev-parse <ref>`. Line numbers then
refer to that version of the file.

### Other commands

- `gitna conversations list --participant <your-id> [--path FILE]`: every
  conversation, with its current location.
- `gitna conversations show <conversation-id> --participant <your-id>`: one
  conversation.
- `gitna conversations resolve <conversation-id> --participant <your-id>` and
  `gitna conversations reopen <conversation-id> --participant <your-id>`:
  change `conversation.status`. Resolved conversations leave the code view.
- `gitna conversations session --participant <your-id>`: the Gitna instance,
  the repository root, your participant, your acknowledgment cursor, and the
  joined `agents`.
- `gitna conversations events --after <seq> --timeout <s> --participant <your-id>`:
  the raw event stream, for tools that follow every change.
