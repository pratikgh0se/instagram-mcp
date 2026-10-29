# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x (including 1.0.0-rc.*) | Yes |
| 0.1.x and older | No |

Only the latest release of the supported line gets security fixes.

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue, pull request or discussion for a security problem.

Use GitHub's private vulnerability reporting:

1. Open the [Security tab](https://github.com/pratikgh0se/instagram-mcp/security) of the repository.
2. Choose **Report a vulnerability** (a private security advisory).
3. Describe what you found, the version you tested, and the steps to reproduce it.

Never include real access tokens, app secrets, bearer tokens or personal data in a report. A description and a minimal reproduction are enough.

## What to expect

This project is maintained by one person on a best-effort basis. There is no promised response or fix time. Every report will be read, you will be told whether it reproduces, and you will be credited in the fix if you want.

## Scope

In scope:

- Handling of access tokens, app secrets, the HTTP bearer and the webhook verify token: storage backends, redaction in logs, errors and tool output.
- The preflight, approve, execute flow: anything that lets a write run without an approval bound to the exact previewed action, reuses or forges an approval, or bypasses policy.
- The Streamable HTTP transport (bearer, Host and Origin checks, loopback default), the webhook receiver (signature verification) and the media host (token guessing, traversal, serving unstaged files).
- Outbound fetches of user-supplied URLs (SSRF guard) and local file writes (downloads confined to the downloads directory).
- Local state under `INSTAGRAM_MCP_HOME`.

Out of scope:

- Vulnerabilities in Meta's APIs or in Instagram itself. Report those to Meta.
- Vulnerabilities in third-party dependencies with no effect on this project. Report those upstream.
- Problems that need an attacker who already has full access to your user account or machine.
- An AI client approving a change that you chose to approve.
- Exposing the HTTP port or media host to the internet without the protections described in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).

The threat model is in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
