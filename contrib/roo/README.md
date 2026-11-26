# Optional Roo configuration

This repository ships its shared Roo Code configuration as templates instead of tracked `.roo/` and `.roomodes` files. Contributors who use Roo Code (or a compatible agent) can install the templates locally. Contributors who use other tools can ignore this directory.

## Why

- Personal modes and rules stay local. Edits to `.roo/` and `.roomodes` never appear in `git status`.
- No merge conflicts on shared configuration files.
- The shared configuration still exists, as opt-in templates in this directory.

## What is here

| Path       | Purpose                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roomodes` | Template for `.roomodes`: the shared custom modes (translate, issue-fixer, pr-fixer, merge-resolver, docs-extractor, issue-investigator, issue-writer). |
| `roo/`     | Template for `.roo/`: commands, global and mode rules, skills, translator guidance, and `roomotes.yml`.                                                 |
| `setup.sh` | No-clobber installer for both templates.                                                                                                                |

`.rooignore` stays tracked at the repository root. It protects every contributor and agent the same way, like `.gitignore` and `.editorconfig`, so it does not need a personal copy. `.roo/mcp.json` stays personal; git ignores it through the `/.roo/` rule.

## Setup

From the repository root:

```
./contrib/roo/setup.sh
```

The script copies every template file to its root location, for example `.roomodes` and `.roo/commands/release.md`, only when that file does not exist. It never overwrites or deletes your local configuration, and it is safe to run again at any time. It prints `keep` for files you already have and `install` for files it adds.

## Adopting template updates

Template updates do not reach your machine automatically. To adopt a change, compare the template with your local file and copy what you want, for example:

```
diff contrib/roo/roomodes .roomodes
cp contrib/roo/roo/commands/release.md .roo/commands/release.md
```

Read the template change before you copy it, so you know what you adopt.

## Migration: back up before you pull

This change removes the tracked `.roo/` and `.roomodes` files from the repository. Git removes unchanged tracked copies when you pull. Local changes can stop the pull.

Before you pull this change, back up your local configuration:

```
backup_dir=$(mktemp -d)
cp -R .roo "$backup_dir/roo"
cp .roomodes "$backup_dir/roomodes"
printf 'Backup directory: %s\n' "$backup_dir"
```

Keep the backup path. After you pull, restore your files in the same shell. In a new shell, set `backup_dir` to that path first.

```
mkdir -p .roo
cp -R "$backup_dir/roo/." .roo/
cp "$backup_dir/roomodes" .roomodes
```

Then run `./contrib/roo/setup.sh`. It adds the template files you do not have and keeps the files you restored.

If you pulled without a backup, recover the last tracked version from the commit before removal. Back up any current local configuration first. This command replaces the checkout copies and leaves the index unchanged:

```
git restore --source=ca43e69f700173e7a238f4c19d21f18d485d0006 --worktree -- .roo .roomodes
```

## Uninstall

Delete `.roo/` and `.roomodes` from your checkout. Git does not track them, so the removal stays local.
