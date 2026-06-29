# Contributing to Cyborg7

Thanks for your interest in contributing! This is the public home of Cyborg7
(`Cyborg7-com/cyborg`). It contains the daemon, UI, relay, CLI, and Cybo runner.
Infrastructure (IaC, deploy, internal ops) lives in a separate private repo and
is not needed to build or contribute to the code here.

## How development works

Cyborg7 is developed across two repositories:

- **Public (`Cyborg7-com/cyborg`)** — this repo. Source of truth for all
  application packages (`packages/*`). **All contributions land here.**
- **Private** — infrastructure, deploy automation, and internal ops only.

Maintainers periodically integrate public changes into the private repo (which
also drives releases and relay deploys). **As a contributor you only ever touch
the public repo** — you never need access to the private one.

## Contribution flow

1. **Fork** `Cyborg7-com/cyborg` and clone your fork.
2. **Branch** from `main`: `git switch -c feat/your-change`.
3. **Make your change.** Keep PRs focused; match the surrounding code style.
4. **Verify locally:**
   ```bash
   pnpm install
   pnpm lint          # oxlint + oxfmt
   pnpm typecheck
   pnpm test
   ```
5. **Open a PR** against `main`. CI runs lint, typecheck, tests, and a
   **TruffleHog secret-scan gate** (a PR that introduces a verified secret is
   blocked).
6. A maintainer reviews and merges. Merged changes are later integrated into the
   private repo by maintainers (cherry-pick / sync) — there is nothing extra you
   need to do.

## Conventions

- **Conventional commits**: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`.
- **TypeScript strict**; named exports; PascalCase for component files.
- **No secrets, ever.** Use `.env` (gitignored) locally; never commit credentials
  or infrastructure identifiers (IPs, instance ids, internal hostnames). The
  secret-scan gate enforces this.
- **UI** (`packages/ui`): Svelte 5 runes, Tailwind v4 tokens (not hardcoded
  values), shadcn-svelte components.

## Reporting bugs / requesting features

Use the issue templates under **Issues**. For security issues, do **not** open a
public issue — follow [`SECURITY.md`](SECURITY.md).

## Code of Conduct

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree your contributions are licensed under the project's
[AGPL-3.0](LICENSE).
