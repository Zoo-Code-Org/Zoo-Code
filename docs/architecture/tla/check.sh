#!/usr/bin/env bash
# Runs every TLC config here. Spec.cfg must pass. Each Spec.Variant.cfg must fail.
# Usage: TLA_JAR=/path/to/tla2tools.jar ./check.sh Spec [Spec ...]
#        TLA_JAR=/path/to/tla2tools.jar ./check.sh all   (every spec, for a release or a change to this script)
set -u
cd "$(dirname "$0")"
: "${TLA_JAR:?set TLA_JAR to the tla2tools.jar path}"
meta=$(mktemp -d)
trap 'rm -rf "$meta"' EXIT
[ $# -gt 0 ] || { echo "name a spec, or use: all"; exit 2; }
specs="$*"
[ "$specs" != all ] || specs=$(ls *.tla | sed 's/\.tla$//')
bad=0
for spec in $specs; do
	for cfg in "$spec".cfg "$spec".*.cfg; do
		[ -f "$cfg" ] || continue
		want=pass
		[ "$cfg" = "$spec.cfg" ] || want=fail
		java -XX:+UseParallelGC -cp "$TLA_JAR" tlc2.TLC -metadir "$(mktemp -d -p "$meta")/s" -config "$cfg" "$spec.tla" >"$meta/out" 2>&1
		got=unknown
		grep -q "No error has been found" "$meta/out" && got=pass
		grep -q "violated" "$meta/out" && got=fail
		states=$(grep -o '[0-9,]* distinct states found' "$meta/out" | head -1)
		if [ "$got" = "$want" ]; then echo "ok    $cfg ($want, $states)"; else echo "WRONG $cfg (want $want, got $got)"; bad=1; fi
	done
done
exit $bad
