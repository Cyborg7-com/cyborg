# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report privately using **GitHub Security Advisories**:
**Security → Report a vulnerability** on `Cyborg7-com/cyborg`
(`https://github.com/Cyborg7-com/cyborg/security/advisories/new`).

If you cannot use that, email **security@cyborg7.com** with:

- a description of the vulnerability and its impact,
- steps to reproduce (a minimal proof-of-concept if possible),
- affected version / commit, and any suggested remediation.

We aim to acknowledge reports within **3 business days** and to provide a
remediation timeline after triage. Please give us a reasonable window to ship a
fix before any public disclosure; we're happy to credit you in the advisory.

## Scope

In scope: the daemon, relay, UI, CLI, and Cybo runner in this repository.

Out of scope: third-party agent CLIs (Claude Code, Codex, Copilot, OpenCode,
Pi) — report those to their respective projects.

## Handling of secrets

This project never commits credentials. A **TruffleHog** secret-scan runs as a
pre-commit hook and as a CI gate on every push/PR; production secrets are
injected via the deploy environment, and the daemon refuses to boot with the
development JWT default outside development. If you believe a secret was
committed historically, please report it privately as above.
