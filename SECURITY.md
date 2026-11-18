# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's security advisory feature for this repository. Do not open a public issue until a fix is available.

Include the affected version, operating system, reproduction steps, and expected impact when possible.

## Security model

Gitna is a local application for repositories trusted by the current user. It:

- binds only to a random loopback address;
- protects HTTP and event-stream requests with a per-process capability token;
- validates repository-relative paths before Git and filesystem operations;
- serializes repository mutations;
- serves local coding agents on a separate conversations-only API that refuses browser requests and requires a per-process bearer token, published in a file only the current user can read and never containing the browser capability token;
- disables interactive Git credential prompts; and
- applies request, output, and body-size limits.

Gitna executes the system `git` binary and normal Git hooks with the current user's permissions. Opening an untrusted repository or running untrusted hooks is outside Gitna's trust boundary.

## Native agents

Adding an agent lets the holder of the browser capability token execute a program as the current user. That token already permits repository writes and Git operations with hooks. Agent commands make program execution more direct.

Gitna resolves the executable to an absolute path and passes an argument array without a shell. The Add agent result shows the executable and arguments. Verification starts the program before saving it. Gitna lists known agents it finds on `PATH` by reading directory entries only, with the command each would run; it starts one only when you confirm it. A connected agent stays connected in every folder until you forget it, and starts only when a person's message names it. It never installs agents. It downloads an ACP adapter only after the person confirms the source, version, size and folder. Archives are checked against a SHA-256 pinned in Gitna before they are unpacked, and entries that would leave the adapter folder are refused. npm adapters are installed at a pinned version with `npm install --prefix`, which checks package integrity. Adapters are stored under `<state>/adapters` and never update automatically. Definitions contain only a name, executable path, and arguments. They use a file with mode 0600 on systems that support Unix permissions. Do not put secrets in command arguments. Gitna does not store authentication credentials or provide an environment field. Agents inherit Gitna's environment and use their own authentication storage.

The browser API alone can add agents, remove definitions, control runs, and answer permission requests. The separate CLI agent API cannot reach those routes. Agent definitions and repository membership live in the user's state directory, never in the opened folder. Opening a folder cannot supply an agent command.

A person's addressed browser message or Retry starts each run. Agents cannot address native agents or use `all`. Native replies have no recipients. Runs are sequential per folder, with a fresh process and session for each message. Gitna requests that agents never commit or push. This is an instruction, not an enforced restriction.

An agent runs with your user's permissions. It can read and change anything you can, act without asking, and send repository content to its provider. Gitna does not sandbox agents. Gitna advertises no filesystem or terminal capability through ACP. This does not limit a program's direct access to the system. Permission requests are shown with the agent's option names and relayed only after a person chooses. No answer for ten minutes cancels the run. A permission prompt is not a security boundary.

Gitna renders reply text, activity titles, option names, and errors as text. It does not execute agent output. Agent edits use normal disk access and appear through the file watcher. Unsaved browser buffers remain separate. Saving over a changed disk file reports a conflict and keeps the buffer.

Cancel and normal shutdown stop the agent process and its descendants through a process group on Unix or a Job Object on Windows. A hard kill on Unix can leave an agent alive until it notices closed input. After restart, Gitna marks unfinished runs interrupted and never replays them automatically.

## Supported versions

Security fixes are provided for the latest published release.
