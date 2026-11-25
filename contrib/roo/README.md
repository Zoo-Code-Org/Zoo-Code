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

`.rooignore` stays tracked at the repository root. It protects every contributor and agent the same way, like `.gitignore` and `.editorconfig`, so it does not need a personal copy. `.roo/mcp.json` stays personal; git ignores it through the `.roo/` rule.

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

This change removes the tracked `.roo/` and `.roomodes` files from the repository. Git deletes your checkout copies when it applies that removal, even if you changed them locally.

Before you pull this change, back up your local configuration:

```
cp -R .roo /tmp/roo-backup
cp .roomodes /tmp/roomodes-backup
```

After you pull, restore your files:

```
mv /tmp/roo-backup .roo
mv /tmp/roomodes-backup .roomodes
```

Then run `./contrib/roo/setup.sh`. It adds the template files you do not have and keeps the files you restored.

If you pulled without a backup, recover the last tracked version from Git history, where `HEAD~1` is the last commit that still tracked the files:

```
git show HEAD~1:.roomodes > .roomodes
git checkout HEAD~1 -- .roo
```

## Uninstall

Delete `.roo/` and `.roomodes` from your checkout. Git does not track them, so the removal stays local.
