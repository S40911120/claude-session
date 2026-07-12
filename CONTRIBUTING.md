# Contributing to recensa-session

Thanks for your interest in improving recensa-session. This guide covers how to get set up,
the quality bar for changes, and how to open a good pull request.

## Development setup

recensa-session is a plain Node package with **no runtime dependencies** — Node core modules
only. You need **Node.js 22 or newer**; there is nothing to build or compile.

```bash
git clone <your fork>
cd claude-session
npm link            # optional: put the `recensa-session` CLI on your PATH
recensa-session --help
```

You can also run the CLI straight from the checkout without linking:

```bash
node bin/recensa-session.js --help
```

## Tests

Tests use the built-in Node test runner — no test framework to install:

```bash
npm test            # runs `node --test` across intel/test/
```

The suite includes `parity.test.js`, which mechanically proves that each library export
returns the same object shape as the CLI's `<command> --json` output. If you change an
analysis command or its `--json` output, update both sides so parity stays green.

## Before you open a PR

- **`npm test` must pass** — every test green.
- **Keep the dependency count at zero.** recensa-session ships with no runtime dependencies.
  Reach for a Node core module first; if you believe a dependency is genuinely needed,
  open an issue to discuss it before adding one.
- **Add or update tests** when you change parsing, a surgery command, or any output
  shape an existing test locks.

## Pull request guidelines

- **Keep PRs focused** — one topic per PR makes review fast and history clean.
- **Link the issue** it addresses (`Closes #123`) when there is one.
- **Follow [Conventional Commits](https://www.conventionalcommits.org/)** for commit
  subjects: `feat(scope): …`, `fix(scope): …`, `docs: …`, `refactor: …`, `test: …`,
  `chore: …`. Keep unit tests in their own `test(scope): …` commit, separate from the
  implementation.
- **Sign off your commits** with the [Developer Certificate of Origin](https://developercertificate.org/):
  `git commit -s` adds a `Signed-off-by` trailer certifying you have the right to
  submit the contribution.

## Reporting bugs & requesting features

- **Bugs and feature requests** → open an issue. For a bug, include your OS, Node
  version (`node -v`), the exact command you ran, and — when you can — a small transcript
  that reproduces it (mask it first with `recensa-session redact`).
- **Security vulnerabilities** → do **not** open a public issue; see
  [SECURITY.md](./SECURITY.md).

## Project layout

```
bin/recensa-session.js     CLI entry point (argument parsing + subcommand dispatch)
index.js             library entry (require('@recensa/claude-session')) — named, typed functions
intel/               analysis commands (overview, tasks, goal, search, guard, token-budget, …)
  test/              the Node --test suite, including parity.test.js
surgery/             structural surgery (verify, repair, surgeon, forker, merger, constructor)
lib/                 shared helpers (argv, resolver, atomic-write, uuid-engine, util, …)
```

Analysis code reads transcripts without mutating them; only the surgery commands write,
and they go through the atomic temp-file-plus-rename helper in `lib/atomic-write.js`.
Keep that boundary intact.

## Code of Conduct

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating you
are expected to uphold it.
