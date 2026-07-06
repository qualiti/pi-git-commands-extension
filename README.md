# pi-git-commands-extension

A standalone [Pi](https://github.com/badlogic/pi-mono) package that adds shareable git workflow commands:

- `/commit`
- `/push`
- `/commit-and-push`
- `/commit-pr`

The extension inspects the current repository, generates commit messages with the active Pi model, and now also looks at recent commits so generated messages stay closer to the repository's existing style.

## Install

### From npm

```bash
pi install npm:pi-git-commands-extension
```

### From git

```bash
pi install git:github.com/qualiti/pi-git-commands-extension
```

### From a local checkout

```bash
pi install /absolute/path/to/pi-git-commands-extension
```

## Usage

After installation, reload Pi or start a new session, then use:

```text
/commit
/push
/commit-and-push
/commit-pr
```

You can also pass a commit hint:

```text
/commit fix calendar overlap validation
/commit-and-push update onboarding copy
/commit-pr add recurring event form polish
```

## Commit message instructions

You can provide extra instructions for AI-generated commit messages. They are merged into the generation prompt alongside git changes, recent commit style, and session history.

Sources are combined in this order:

1. `PI_GIT_COMMANDS_COMMIT_INSTRUCTIONS` environment variable
2. Git config `pi.git-commands.commitInstructions`
3. A repository file at `.pi/git-commit-instructions`, `.pi/git-commit-instructions.txt`, or `.pi/git-commit-instructions.md`
4. Per-command flags: `--instructions "..."` or `-I "..."`

Examples:

```bash
export PI_GIT_COMMANDS_COMMIT_INSTRUCTIONS="Use Conventional Commits with a scope."
```

```bash
git config pi.git-commands.commitInstructions "Keep subjects under 50 characters."
```

```text
/commit --instructions "Mention the affected API route in the body."
/commit-and-push -I "Use the chore: prefix for dependency updates."
```

Passing plain text after the command still bypasses AI generation and uses your message directly. Instruction flags only apply when the command auto-generates a commit message.

## Requirements

- `git` must be available on `PATH`
- `gh` must be installed and authenticated for `/commit-pr`
- Pi must have an authenticated model available to generate commit metadata

## Package structure

This package follows Pi package guidelines:

- it declares a `pi` manifest in `package.json`
- it exposes the extension through `./extensions`
- it uses Pi core packages as `peerDependencies`
- it ships TypeScript directly so Pi can load it through jiti

## Local development

Run the unit tests:

```bash
npm test
```

Run a local package install into Pi:

```bash
pi install /absolute/path/to/pi-git-commands-extension
```

Or load the extension file directly for quick testing:

```bash
pi -e /absolute/path/to/pi-git-commands-extension/extensions/git-commands.ts
```

## Files

- `package.json` — Pi package manifest for npm and git installs
- `extensions/git-commands.ts` — the extension entry point
- `.github/workflows/ci.yml` — package validation on pushes and pull requests
- `.github/workflows/publish.yml` — npm publish workflow for releases

## Notes

This repository intentionally keeps the extension as plain TypeScript with no build step, matching Pi's extension packaging model.
