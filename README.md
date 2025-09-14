# Labels Configuration

This repository contains the `labels.json` file, which serves as the **single source of truth for GitHub issue labels** across all repositories in the `Adamant-im` organization.

## Purpose

- Standardize labels across multiple repositories.
- Ensure consistency in naming, colors, and descriptions.
- Enable automated synchronization via GitHub Actions.

## File Format

`labels.json` is an array of objects, each representing a label:

```json
[
  {
    "name": "bug",
    "color": "d73a4a",
    "description": "Something isn't working"
  },
  {
    "name": "enhancement",
    "color": "a2eeef",
    "description": "New feature or request"
  }
]
````

### Fields

* `name` (string) – The label name (required).
* `color` (string) – A 6-character hex color code (required).
* `description` (string) – A short description of the label (optional).

> Note: If exported directly from GitHub API, extra fields may exist. Only `name`, `color`, and `description` are used for synchronization.

## How to Update

1. Edit or add new labels in `labels.json`.
2. Commit and push your changes to the repository.
3. GitHub Actions workflow will automatically synchronize labels across all linked repositories.

## Manual Synchronization

If needed, you can manually sync labels using [`github-label-sync`](https://github.com/Financial-Times/github-label-sync):

```bash
npx github-label-sync --labels labels.json --access-token <YOUR_TOKEN> owner/repo
```

Replace `<YOUR_TOKEN>` with a GitHub personal access token with **read/write access** to the target repository.

## Notes

* Keep `labels.json` up-to-date to maintain consistency across repositories.
* Only labels defined here will be synchronized; any manual changes in individual repos may be overwritten.
