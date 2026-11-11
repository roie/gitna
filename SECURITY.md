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

## Supported versions

Security fixes are provided for the latest published release.
