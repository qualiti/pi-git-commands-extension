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

Run a local package install into Pi:

```bash
pi install /absolute/path/to/pi-git-commands-extension
```

Or load the extension file directly for quick testing:

```bash
pi -e /absolute/path/to/pi-git-commands-extension/extensions/git-commands.ts
```

## Publish to npm

This repository includes a GitHub Actions publish workflow at `.github/workflows/publish.yml`.

For local publishing:

1. Log in to npm:

```bash
npm login
```

2. Preview the tarball:

```bash
npm run pack:check
```

3. Publish:

```bash
npm publish
```

If you later move to a scoped public package, publish with:

```bash
npm publish --access public
```

For GitHub Actions publishing with npm trusted publishers:

1. Add this GitHub repository as a trusted publisher in npm.
2. Do not add an `NPM_TOKEN` secret for publishing.
3. Create a GitHub release.
4. The workflow will publish with GitHub OIDC using:

```bash
npm publish --access public --provenance
```

This workflow requires GitHub-hosted runners plus Node 22.14.0 or newer.

## Files

- `package.json` — Pi package manifest for npm and git installs
- `extensions/git-commands.ts` — the extension entry point
- `.github/workflows/ci.yml` — package validation on pushes and pull requests
- `.github/workflows/publish.yml` — npm publish workflow for releases

## Notes

This repository intentionally keeps the extension as plain TypeScript with no build step, matching Pi's extension packaging model.
