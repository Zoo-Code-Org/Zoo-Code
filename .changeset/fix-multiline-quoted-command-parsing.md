---
"zoo-code": patch
---

Fix command auto-approval for multi-line shell constructs that must be treated as a single command.

**Quoted multi-line arguments** (`sh -c '...'`, `sh -c $'...'`, `sh -c "..."`): the parser previously split on every newline before handling quotes, so newlines inside a quoted argument were treated as separate commands, defeating allowlist auto-approval. Single-quoted, ANSI-C (`$'...'`), and double-quoted strings are now masked before the newline split so embedded newlines and operators stay within their command.

**Heredocs** (`<< EOF`, `<< 'EOF'`, `<< "EOF"`, `<<- EOF`): the entire heredoc -- opener line, body, and terminator -- is now treated as a single quoted region. Body lines are not split into independent sub-commands. All heredoc delimiter quoting styles (unquoted, single-quoted, double-quoted, backslash-escaped) are supported. An unterminated heredoc (missing terminator) is treated as malformed and returned as a single opaque token.

**Locale quoting** (`$"..."`): treated as a distinct token analogous to ANSI-C quoting, preserving the `$` prefix and preventing the double-quote handler from stripping it.

Quote masking is comment-aware: a quote character inside a `#` comment is not paired with a quote on a later line, so a comment cannot hide a real newline separator and merge two distinct commands. Commands with an unterminated quote are detected with a quote-aware scanner and returned as a single opaque token, preventing a line inside the unclosed quote from surfacing as an independently auto-approvable command. Genuine unquoted newlines still split into separate sub-commands, each of which must be allowlisted for auto-approval.

**Pattern selector (UI)**: the command pattern breakdown shown after execution now uses the same heredoc- and quote-aware parser (`parseCommand`) before extracting patterns, so an unterminated or terminated heredoc no longer produces spurious tokens like `EOF`, body-line words, or `<<` fragments in the allow/deny selector.

Note: this change only prevents *auto-approval* of fragments from a malformed command; it does not reject malformed commands before execution, which will be addressed in a separate PR to keep the scope focused here.
