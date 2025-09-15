# .github

[![Donate](https://img.shields.io/badge/💖_Donate-adamant.im/donate-green)](https://adamant.im/donate/)

Default community health files for the `Adamant-im` organization.
---
# Funding


Located in `.github/FUNDING.yml`:

This file defines all supported ways to financially support the organization and its projects. It serves as a source of funding links across all repositories in the organization.---
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
```

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


---
# Issue Templates

Located in `.github/ISSUE_TEMPLATE/`:

- **`bug_report.yml`** – Template for reporting bugs, includes steps to reproduce, expected behavior, and environment details.
- **`feature_request.yml`** – Template for suggesting new features or enhancements.
- **`task_general.yml`** – Generic task template for issues that don’t fit into other categories.
- **`task_apprelease.yml`** – Template for tracking app release preparation tasks.
- **`task_publication.yml`** – Template for tasks related to publishing (e.g., releases, announcements).
- **`config.yml`** – GitHub configuration file that controls the issue template chooser (defines which templates appear when creating a new issue).

These templates ensure that contributors provide the necessary information when creating issues, which helps maintain clarity and consistency across all repositories.

---
# Pull Request Template

- **`PULL_REQUEST_TEMPLATE.md`** – A default template shown when opening pull requests.  
  It guides contributors to describe the purpose of the PR, summarize changes, and link related issues.
---
