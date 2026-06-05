---
"zoo-code": patch
---

Fix command auto-approval for a single command that wraps a multi-line script in a quoted argument (e.g. `sh -c '...'`). The parser previously split on every newline before handling quotes, so newlines inside a quoted argument were treated as separate commands, which defeated allowlist auto-approval and produced a noisy command-pattern breakdown. Single-quoted and ANSI-C (`$'...'`) strings are now masked correctly so embedded newlines and operators stay within their command. Genuine unquoted newlines still split into separate sub-commands, each of which must be allowlisted for auto-approval.
