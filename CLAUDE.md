# CLAUDE.md

## Commit Guidelines

This project follows the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification (v1.0.0).

### Commit Message Structure

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

- **feat** — A new feature. Correlates with a MINOR version bump in Semantic Versioning.
- **fix** — A bug fix. Correlates with a PATCH version bump in Semantic Versioning.
- **docs** — Documentation only changes.
- **style** — Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc).
- **refactor** — A code change that neither fixes a bug nor adds a feature.
- **perf** — A code change that improves performance.
- **test** — Adding missing tests or correcting existing tests.
- **build** — Changes that affect the build system or external dependencies.
- **ci** — Changes to CI configuration files and scripts.
- **chore** — Other changes that don't modify src or test files.

### Scope

An optional scope may be provided in parentheses after the type to give additional context:

```
feat(parser): add ability to parse arrays
fix(api): handle null response from endpoint
```

### Breaking Changes

Breaking changes MUST be indicated in one of two ways:

1. Append `!` after the type/scope: `feat!: remove deprecated endpoints`
2. Include a `BREAKING CHANGE:` footer in the commit body:

```
feat: allow provided config object to extend other configs

BREAKING CHANGE: `extends` key in config file is now used for extending other config files
```

Breaking changes correlate with a MAJOR version bump in Semantic Versioning.

### Body and Footers

- The body is free-form and may consist of any number of newline-separated paragraphs.
- Footers follow the format `token: value` or `token #value` (e.g., `Reviewed-by: Alice`).
- Footer tokens use `-` in place of spaces (exception: `BREAKING CHANGE`).

### Examples

```
feat: add email notifications for new users
```

```
fix(auth): resolve token refresh race condition
```

```
feat(api)!: change response format for /users endpoint

BREAKING CHANGE: the /users endpoint now returns an array instead of an object
```

```
docs: correct spelling in README
```

```
refactor: rename internal helper functions for clarity
```
