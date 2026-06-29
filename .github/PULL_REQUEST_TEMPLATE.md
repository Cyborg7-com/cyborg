<!--
Thanks for contributing to Cyborg7! Keep PRs focused and match the surrounding
code style. See CONTRIBUTING.md for the full guide.
-->

## Summary

<!-- What does this change do, and why? Link any related issue (e.g. Closes #123). -->

## Type of change

<!-- Check all that apply. The PR title should use the matching Conventional Commit prefix. -->

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `refactor` — code change that neither fixes a bug nor adds a feature
- [ ] `chore` — tooling, deps, or maintenance

## How tested

<!-- Commands you ran and any manual verification steps. -->

```bash
pnpm lint        # oxlint + oxfmt
pnpm typecheck
pnpm test
```

<!-- Describe manual testing (e.g. ran the daemon with `pnpm dev`, exercised the
     affected flow in the UI / CLI / Cybo runner). -->

## Screenshots / recordings

<!-- For UI changes (packages/ui), attach before/after screenshots or a short clip. Remove this section if not applicable. -->

## Checklist

- [ ] Branched from `main`
- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`)
- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass locally
- [ ] No secrets, credentials, or infrastructure identifiers (IPs, instance ids, internal hostnames) committed
- [ ] Documentation updated if behavior changed
- [ ] I agree my contribution is licensed under the project's [AGPL-3.0](../LICENSE) license
