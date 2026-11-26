#!/bin/sh
#
# No-clobber installer for the optional Roo configuration templates.
#
# Installs every template file at its root location (.roomodes, .roo/...)
# only when the target file does not exist. Existing personal configuration
# is never overwritten or deleted, so the script is safe to run again.
#
# Usage: ./contrib/roo/setup.sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)

if [ ! -d "$script_dir/roo" ]; then
	printf 'Missing Roo templates: %s\n' "$script_dir/roo" >&2
	exit 1
fi

# Install the shared modes file without clobbering an existing one.
if [ -e "$repo_root/.roomodes" ] || [ -L "$repo_root/.roomodes" ]; then
	printf 'keep    .roomodes\n'
else
	cp -- "$script_dir/roomodes" "$repo_root/.roomodes"
	printf 'install .roomodes\n'
fi

# Install the .roo/ tree file by file. A missing .roo/ directory is fine:
# mkdir -p creates it on the first install.
(cd -- "$script_dir/roo" && find . -type f) | sed 's|^\./||' | while IFS= read -r relative; do
	target="$repo_root/.roo/$relative"
	if [ -e "$target" ] || [ -L "$target" ]; then
		printf 'keep    %s\n' ".roo/$relative"
	else
		mkdir -p "$(dirname -- "$target")"
		cp -- "$script_dir/roo/$relative" "$target"
		printf 'install %s\n' ".roo/$relative"
	fi
done

printf 'Done. Existing files were kept. See contrib/roo/README.md.\n'
