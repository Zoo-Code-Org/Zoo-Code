---
"zoo-code": patch
---

Fix command auto-approval for a single command that wraps a multi-line script in a quoted argument (e.g. `sh -c '...'`). The parser previously split on every newline before handling quotes, so newlines inside a quoted argument were treated as separate commands, which defeated allowlist auto-approval and produced a noisy command-pattern breakdown. Single-quoted and ANSI-C (`$'...'`) strings are now masked correctly so embedded newlines and operators stay within their command. Genuine unquoted newlines still split into separate sub-commands, each of which must be allowlisted for auto-approval. Quote masking is comment-aware: a quote character inside a `#` comment is not paired with a quote on a later line, so a comment cannot hide a real newline separator and merge two distinct commands. Commands with an unterminated quote (a shell syntax error, common in LLM-generated commands with nested quotes) are detected with a quote-aware scanner and returned as a single opaque token, so a line intended to live inside the unclosed quote cannot surface as an independently auto-approvable command.

Note: this change only prevents *auto-approval* of fragments from a malformed command; it does not reject malformed commands before execution, which will be addressed in a separate PR to keep the scope focused here.
