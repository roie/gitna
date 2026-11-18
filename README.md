<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/gitna-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="web/public/gitna-logo-light.png">
    <img src="web/public/gitna-logo-light.png" alt="Gitna" width="112" height="112">
  </picture>
</p>

<h1 align="center">Gitna</h1>

<p align="center">A local Git workbench that runs in your browser.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gitna"><img src="https://img.shields.io/npm/v/gitna?style=flat-square&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/roie/gitna/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/roie/gitna/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/roie/gitna?style=flat-square" alt="Apache-2.0 license"></a>
</p>

Gitna brings fast local-folder browsing, source control, visual diffs, repository history, and everyday Git operations into one focused interface. It runs on your machine, uses your installed Git when a folder is a repository, and keeps folder data local.

![Gitna reviewing, staging, editing, and browsing repository history](assets/gitna-demo.gif)

> [!WARNING]
> Gitna is in early development. Expect bugs, rough edges, and breaking changes.

## Quick start

Install with npm:

```sh
npm install -g gitna
```

Open any local folder:

```sh
cd your-folder
gitna
```

Gitna starts a local server and opens an authenticated session in your default browser. You can also pass a folder explicitly:

```sh
gitna /path/to/folder
```

Folders backed by Git automatically gain source control, history, branches, stashes, tags, and Git operations. Ordinary folders retain Gitna’s Explorer, tabs, editing, search, and file tools.

## What you can do

- Start from Home, reopen recent folders, and switch folders without restarting Gitna
- Explore huge ordinary folders through lazy directory loading and bounded watching
- Edit files in tabs, including new untitled documents; unsaved drafts are backed up and recoverable after a restart
- Search from the `Cmd/Ctrl+K` palette: files, `>` commands, `#` commits by message, author, or hash, and `:` line numbers; press `Cmd/Ctrl+Shift+F` for **Find in Files** with case, whole-word, regex, and include/exclude filters
- Preview Markdown and SVG live as you edit, and PNG, JPEG, WebP, and GIF changes alongside text diffs
- Preview PDFs and play supported audio and video with browser-native controls and a download fallback
- Review staged and unstaged changes with Pierre-powered split or unified diffs
- Select two Explorer files with `Cmd/Ctrl`-click, then right-click and choose **Compare Selected**
- Turn on **Inline blame** to see the commit behind the current line
- Stage and unstage files, folders, or individual hunks
- Commit and amend while preserving normal Git hook behavior
- Scroll continuously through a virtualized commit Graph with an exact HEAD-reachable count
- Browse branches, tags, stashes, and commit history
- Fetch, pull, push, compare, merge, rebase, cherry-pick, and revert
- Resolve conflicts with explicit ours, theirs, or combined content
- Comment on lines in files, diffs, commits, and comparisons, and discuss them with your coding agent

PDF previews retain the browser's normal document scripts and forms. Preview support depends on your browser; downloading remains available.

## Conversations

Conversations are off by default. Turn on **Conversations** in Display settings. Gitna remembers the switch across launches.

Hover a line number in any code view and click **+**, or drag to select several lines, to start a conversation on that code. Reply beside the code, click the thread's first message to collapse it, ✓ to resolve it, or ✕ to delete it. When a conversation has several comments, the **···** menu beside an author deletes just that comment. Both can be undone. Resolved conversations leave the code view. The speech-bubble count next to the repository name in the sidebar lists every conversation, with a filter for open and resolved ones, and takes you to it. To hide conversations, turn off **Conversations** in Display settings; nothing is deleted.

Conversations are stored on your machine outside the repository, so they survive refreshes and restarts and are never committed. Gitna keeps the original code with each one. When that code moves, the conversation follows it; when it changes, the conversation is marked outdated and still shows the original lines. When the file is deleted, the conversation stays reviewable on the deletion as long as Git has the code; code that Git never had, such as an untracked file that is gone, is hidden until the same file returns. Nothing is resolved or erased because a file disappeared.

Use **Agents** to connect an agent that supports ACP (Agent Client Protocol). The list shows connected agents, agents you connected before, and known agents installed on your `PATH`. The first time you connect an agent, Gitna shows the command it will run and asks you to confirm; later connections take one click. If the agent asks you to sign in, Gitna shows its sign-in options. A connected agent is available in every folder, but Gitna starts it only when a message names it. Select a connected agent to **Disconnect** it from this folder or **Forget** it everywhere. When an agent's CLI is installed but its ACP adapter is not, connecting offers to download the adapter. Gitna first shows the source, version, size and folder, and installs only after you confirm. Adapters live in Gitna's state directory, are pinned to a version, and never update by themselves. Select the connected agent and choose **Remove adapter** to delete it. The Codex adapter installs with `npm`, so it requires Node.js. **More agents…** explains how to install other known agents. For any other agent, use **Add custom agent…** and enter its command, with quoted arguments if needed; Gitna suggests a name. Sign in outside Gitna if the agent requires interactive authentication.

Write `@Name` to address an agent, or `@all` to address every connected agent. Autocomplete helps with names. A comment without a mention reaches nobody. Replies prefill the last human message's recipients, which you can change. Agents added later do not receive old messages. Repeated names get a numeric suffix.

Native agents run one at a time per folder. Each addressed message starts a fresh process and session. Activity and permission choices appear in the thread, followed by one complete reply. Cancel stops a run. After a failure or restart, **Retry** starts a new run. Gitna never retries automatically. Turning Conversations off lets an active run finish and interrupts queued runs. Turning it on does not replay them. Gitna tells agents never to commit or push, but does not enforce this through a sandbox.

Agents read files on disk, not unsaved editor changes. Their edits appear in the existing changes view. If an agent changes a file with an unsaved buffer, Gitna keeps your buffer and refuses a stale save.

An agent runs with your user's permissions. It can read and change anything you can, act without asking, and send repository content to its provider. Add only commands you trust. Permission choices are relayed to the agent, not enforced by Gitna.

Your existing coding agent can also take part from its own session through the `gitna conversations` command. Install the `gitna` skill so the agent knows how:

```sh
npx skills add roie/gitna
```

or print it with `gitna skill` (it installs nothing) and save it as `gitna/SKILL.md` in the folder where your agent loads skills:

```sh
gitna skill > <skills-folder>/gitna/SKILL.md
```

Each CLI agent joins once and gets its own participant id and inbox. It reads addressed messages and answers in the same thread. CLI agents must name recipients explicitly with `--to`. They cannot use `all` or address native agents. `ack <seq> [<seq> ...]` acknowledges only the listed messages. CLI agents remain joined until removed through **Agents**, or with `gitna conversations leave --participant <id>`. They can rejoin with `join --participant <id>`. The `gitna conversations` command names are experimental and can change.

## Install

### npm

```sh
npm install -g gitna
```

The single npm package downloads the matching native binary from GitHub Releases, verifies its SHA-256 checksum, and caches it locally. Node.js is required only for npm installations.

### mise

```sh
mise use -g github:roie/gitna
```

Mise installs the native GitHub Release asset directly; Node.js is not required at runtime.

### Direct download

Download the archive for your platform from [GitHub Releases](https://github.com/roie/gitna/releases), extract it, and place `gitna` (`gitna.exe` on Windows) on your `PATH`.

Supported release targets:

- macOS Apple silicon (arm64)
- macOS Intel (x64)
- Linux x64
- Linux arm64
- Windows x64
- WSL using the Linux binary and your normal Windows browser

Gitna requires an installed `git` executable and a modern browser.

## Local by design

Gitna binds only to a random loopback port. Every process creates a high-entropy capability URL, and mutating requests are protected by Host, Origin, content-type, and size checks.

Gitna keeps its local state (recent folders, drafts, conversations and agent endpoints) in one directory: `~/.config/gitna` on Linux, `~/Library/Application Support/gitna` on macOS and `%LocalAppData%\Gitna` on Windows. Set `GITNA_HOME` to an absolute path to use another directory.

Repository reads and mutations go through the system Git executable. Gitna does not upload repository data or replace Git's storage, configuration, credentials, or hooks.

See [SECURITY.md](SECURITY.md) for the complete security model and vulnerability reporting instructions.

## Development

Development setup, validation commands, packaging, and release instructions are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Gitna is licensed under [Apache-2.0](LICENSE). Bundled dependency notices are available in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
