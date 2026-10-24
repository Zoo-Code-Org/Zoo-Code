import { findUnterminatedQuote, parseCommand } from "../parse-command"

// Toggle that lets a single test force shell-quote's parse() to throw so the
// parser's fallback branch can be exercised deterministically.
let forceShellQuoteFailure = false

vi.mock("shell-quote", async (importOriginal) => {
	const actual = await importOriginal<typeof import("shell-quote")>()
	return {
		...actual,
		parse: (...args: Parameters<typeof actual.parse>) => {
			if (forceShellQuoteFailure) {
				throw new Error("forced parse failure")
			}
			return actual.parse(...args)
		},
	}
})

describe("parseCommand", () => {
	describe("basic chaining", () => {
		it("returns empty array for empty input", () => {
			expect(parseCommand("").commands).toEqual([])
			expect(parseCommand("   ").commands).toEqual([])
		})

		it("returns a single command unchanged", () => {
			expect(parseCommand("git status").commands).toEqual(["git status"])
		})

		it("splits on &&", () => {
			expect(parseCommand("git add . && git commit").commands).toEqual(["git add .", "git commit"])
		})

		it("splits on ||, ;, and |", () => {
			expect(parseCommand("a || b").commands).toEqual(["a", "b"])
			expect(parseCommand("a ; b").commands).toEqual(["a", "b"])
			expect(parseCommand("a | b").commands).toEqual(["a", "b"])
		})
	})

	describe("genuine multi-statement scripts (unquoted newlines)", () => {
		it("splits unquoted newlines into separate sub-commands", () => {
			const input = "echo a\necho b\necho c"
			expect(parseCommand(input).commands).toEqual(["echo a", "echo b", "echo c"])
		})

		it("handles Windows and old-Mac line endings", () => {
			expect(parseCommand("echo a\r\necho b").commands).toEqual(["echo a", "echo b"])
			expect(parseCommand("echo a\recho b").commands).toEqual(["echo a", "echo b"])
		})

		it("ignores blank lines", () => {
			expect(parseCommand("echo a\n\n\necho b").commands).toEqual(["echo a", "echo b"])
		})
	})

	describe("newlines inside single-quoted strings", () => {
		it("treats a multi-line single-quoted argument as one command", () => {
			const input = "sh -c 'echo a\necho b'"
			expect(parseCommand(input).commands).toEqual(["sh -c 'echo a\necho b'"])
		})

		it("does not split operators that appear inside single quotes", () => {
			const input = "sh -c 'echo a && echo b | grep x'"
			expect(parseCommand(input).commands).toEqual(["sh -c 'echo a && echo b | grep x'"])
		})

		it("preserves the embedded newline in the restored command", () => {
			const input = "sh -c 'echo 1\necho 2'"
			const { commands: result } = parseCommand(input)
			expect(result).toEqual(["sh -c 'echo 1\necho 2'"])
			expect(result[0]).toContain("\n")
		})
	})

	describe("ANSI-C quoting ($'...')", () => {
		it("does not leak a placeholder for a $'...' multi-line argument", () => {
			const input = "sh -c $'echo 1\necho 2'"
			const { commands: result } = parseCommand(input)
			// The placeholder used internally must never appear in the output.
			expect(result.join(" ")).not.toContain("SQUOTE")
			expect(result.join(" ")).not.toContain("__")
		})

		// An escaped apostrophe inside an ANSI-C string must not terminate the
		// quoted region early; otherwise a following newline would leak out and
		// split the single command into bogus sub-commands.
		it("treats a $'...' argument with an escaped apostrophe and newline as one command", () => {
			const input = "sh -c $'echo \\'1\\'\necho 2'"
			const { commands: result } = parseCommand(input)
			expect(result).toEqual([input])
			expect(result.join(" ")).not.toContain("SQUOTE")
			expect(result.join(" ")).not.toContain("__")
		})
	})

	describe("newlines inside double-quoted strings", () => {
		it("treats a multi-line double-quoted argument as one command", () => {
			const input = 'sh -c "echo a\necho b"'
			expect(parseCommand(input).commands).toEqual(['sh -c "echo a\necho b"'])
		})

		it("does not split operators that appear inside double quotes", () => {
			const input = 'sh -c "echo a && echo b | grep x"'
			expect(parseCommand(input).commands).toEqual(['sh -c "echo a && echo b | grep x"'])
		})

		it("handles escaped quotes inside a double-quoted string", () => {
			const input = 'sh -c "echo \\"hello world\\""'
			expect(parseCommand(input).commands).toEqual(['sh -c "echo \\"hello world\\""'])
		})
	})

	describe("mixed quote styles", () => {
		it("does not let an apostrophe inside double quotes start a single-quoted region", () => {
			const input = `echo "don't" && echo ok`
			expect(parseCommand(input).commands).toEqual([`echo "don't"`, "echo ok"])
		})

		it("does not let a double quote inside single quotes start a double-quoted region", () => {
			const input = `echo 'a " b' && echo ok`
			expect(parseCommand(input).commands).toEqual([`echo 'a " b'`, "echo ok"])
		})
	})

	describe("comment lines containing quote characters", () => {
		// A quote character inside a # comment is not shell quoting, so it must
		// not be paired with a quote on a later line. The newline that ends the
		// comment line stays a command separator and the following command is
		// parsed independently.
		it("does not let a quote inside a # comment hide the newline before the next command", () => {
			// The unmatched single quote in the comment must not absorb the
			// newline; line 2 must surface as its own sub-command.
			const input = "echo hello # it's a comment\necho world"
			const { commands: result } = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[result.length - 1]).toBe("echo world")
		})

		it("does not let a double-quote inside a # comment hide the newline before the next command", () => {
			// The unmatched double quote in the comment must not absorb the newline.
			const input = `echo hello # say "hi\necho world`
			const { commands: result } = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[result.length - 1]).toBe("echo world")
		})

		// A comment quote that could otherwise pair with a quote several lines
		// down must not swallow the intervening newlines. Every command stays
		// separate so each is evaluated on its own, and the comment tail itself
		// is discarded (it is not part of any executable command).
		it("keeps every command separate when an earlier comment contains a quote", () => {
			const input = "echo first # what's here\necho middle\necho 'done'"
			const { commands: result } = parseCommand(input)
			expect(result).toEqual(["echo first", "echo middle", "echo 'done'"])
		})
	})

	describe("real-world wrapped multi-line script (regression)", () => {
		it("treats a wrapper command with an embedded multi-line script as a single command", () => {
			const input = [
				`sh -c 'kubectl exec pod -- python3 -c "`,
				`import urllib.request`,
				`url = \\"http://127.0.0.1:49527/\\"`,
				`try:`,
				`    with urllib.request.urlopen(url, timeout=10) as r:`,
				`        for k, v in r.headers.items():`,
				`            print(f\\"{k}: {v}\\")`,
				`except Exception as e:`,
				`    print(\\"fetch failed:\\", type(e).__name__, e)`,
				`"'`,
			].join("\n")

			const { commands: result } = parseCommand(input)
			expect(result).toHaveLength(1)
			expect(result[0]).toBe(input)
		})
	})

	describe("subshells still split", () => {
		it("extracts subshell content as separate commands", () => {
			const { commands: result } = parseCommand("echo $(whoami)")
			expect(result).toContain("whoami")
		})
	})

	describe("shell-quote parse-failure fallback", () => {
		afterEach(() => {
			forceShellQuoteFailure = false
		})

		// When shell-quote throws, the parser falls back to a crude operator
		// split and must still restore every masked placeholder -- including the
		// ANSI-C single-quote bucket -- so callers never see internal markers.
		it("restores ANSI-C quoted placeholders in the fallback path", () => {
			forceShellQuoteFailure = true

			const { commands: result } = parseCommand("sh -c $'echo hi' && echo done")
			expect(result).toEqual(["sh -c $'echo hi'", "echo done"])
			expect(result.join(" ")).not.toContain("SQUOTE")
			expect(result.join(" ")).not.toContain("__")
		})
	})

	describe("malformed input with unterminated quotes", () => {
		// A command with an unterminated quote is a shell syntax error. The
		// parseError field is non-null and commands contains the raw input as a
		// single opaque token so no embedded line can be auto-approved alone.
		it("returns an unclosed single-quoted command as one opaque token with a parseError", () => {
			const input = "sh -c 'echo test"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError).not.toBeNull()
			expect(parseError?.quoteType).toBe("posix-single")
		})

		it("does not split an unclosed single quote on an embedded newline", () => {
			const input = "sh -c 'echo a\necho b"
			// Without the guard, the second line would surface as a standalone
			// `echo b` even though it was meant to live inside the unclosed quote.
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError).not.toBeNull()
		})

		it("returns an unclosed double-quoted command as one opaque token with a parseError", () => {
			const input = 'sh -c "echo a\necho b'
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("double")
		})

		it("returns an unclosed ANSI-C quoted command as one opaque token with a parseError", () => {
			const input = "sh -c $'echo a\necho b"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("ansi-c")
		})

		it("treats odd-quote improper quoting as a single opaque token with a parseError", () => {
			const input = "sh -c 'cmd ''\\\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError).not.toBeNull()
		})
	})

	describe("heredoc quoting", () => {
		// The entire heredoc -- opener line, body, and terminator -- must be
		// treated as a single opaque token so body lines are never split into
		// independent sub-commands for auto-approval evaluation.

		it("treats an unquoted-delimiter heredoc as one command", () => {
			const input = "sh -c bash << EOF\necho hello\nEOF"
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("treats a single-quoted-delimiter heredoc as one command", () => {
			const input = "sh -c bash << 'EOF'\necho hello\nEOF"
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("treats a double-quoted-delimiter heredoc as one command", () => {
			const input = 'sh -c bash << "EOF"\necho hello\nEOF'
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("treats a backslash-escaped-delimiter heredoc as one command", () => {
			const input = "sh -c bash << \\EOF\necho hello\nEOF"
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("treats a <<- heredoc (strip leading tabs) as one command", () => {
			// <<- allows the terminator to be indented with tabs.
			const input = "sh -c bash <<-EOF\n\techo hello\n\tEOF"
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("does not split body lines of a multi-line heredoc", () => {
			const input = ["sh -c bash << 'EOF'", "echo line1", "echo line2", "echo line3", "EOF"].join("\n")
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("splits a command that follows the heredoc terminator", () => {
			const input = "sh -c bash << EOF\necho hello\nEOF\necho done"
			const { commands: result } = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[0]).toBe("sh -c bash << EOF\necho hello\nEOF")
			expect(result[1]).toBe("echo done")
		})

		it("treats a heredoc with a missing terminator as one opaque token", () => {
			// An unterminated heredoc is a syntax error; the whole input must be
			// returned as a single token so no body line can be auto-approved alone.
			const input = "sh -c bash << EOF\necho hello"
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("treats the real-world sh heredoc pattern as one command", () => {
			const input = [
				"sh -c bash << 'EOF'",
				"echo line1 > /tmp/test.txt",
				"echo line2 \\",
				"  --flag value \\",
				"  --other value",
				"EOF",
			].join("\n")
			expect(parseCommand(input).commands).toEqual([input])
		})
		it("does not treat a # comment inside a heredoc body as a command separator", () => {
			// A '#' inside a heredoc body is literal text, not a shell comment.
			// The body must not be split and the comment line must be preserved.
			const input = "sh -c bash << 'EOF'\n# this is a comment\necho hello\nEOF"
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("does not mistake << inside a # comment as a heredoc opener", () => {
			// A heredoc opener that appears inside a # comment must be ignored;
			// the following lines must still be treated as separate commands.
			const input = "echo hi # << EOF\necho world"
			const { commands: result } = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[result.length - 1]).toBe("echo world")
		})

		it("fails closed on CRLF heredocs of every delimiter form", () => {
			// The msys read layer strips every CR in the construct. The strip
			// reaches the delimiter word and the terminator line too. POSIX bash
			// keeps every CR. A CR anywhere from the opener line through the
			// closing terminator line therefore leaves the two layers reading
			// different bytes. The close cannot then be verified in a
			// model-independent way, so every such heredoc fails closed. This
			// includes uniformly-CRLF heredocs whose two models agree. That is
			// the accepted cost of never picking a model.
			const input = "cat <<EOF\r\n$(whoami)\r\nEOF\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
			expect(findUnterminatedQuote("cat <<-EOF\r\n\techo C\r\n\tEOF\r\n")?.quoteType).toBe("heredoc")
			expect(findUnterminatedQuote("cat <<'EOF'\r\nbody\r\nEOF\r\n")?.quoteType).toBe("heredoc")
			expect(findUnterminatedQuote('cat <<"EOF"\r\nbody\r\nEOF\r\n')?.quoteType).toBe("heredoc")
			expect(findUnterminatedQuote("cat <<\\EOF\r\nbody\r\nEOF\r\n")?.quoteType).toBe("heredoc")
			// A delimiter quote left open does not end at the CR. bash spans
			// the newline with the quote. It reads a delimiter that can never
			// match a body line, and it keeps executing the opener line's tail.
			// An unclosed delimiter quote therefore fails closed instead of
			// masking the body.
			expect(findUnterminatedQuote("cat <<'EOF\r\nbody\r\nEOF\r\n")?.quoteType).toBe("heredoc")
			expect(findUnterminatedQuote('cat <<"EOF\r\nbody\r\nEOF\r\n')?.quoteType).toBe("heredoc")
		})
	})

	describe("herestring (<<<)", () => {
		// A herestring (<<<) feeds a single word as stdin -- it has no body region
		// or terminator. The word to the right is a normal shell word (possibly
		// quoted) and must NOT be treated as a heredoc body.

		it("treats a simple herestring as one command", () => {
			const input = `sh <<< "echo hello"`
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("does not scan for a heredoc terminator after <<<", () => {
			// Without the <<< guard the parser would treat <<< as << followed by
			// delimiter "<", then scan for a line exactly equal to "<" -- consuming
			// the rest of input and returning it as an unterminated heredoc.
			const input = "sh <<< 'echo hello'\necho done"
			const { commands: result } = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[0]).toBe("sh <<< 'echo hello'")
			expect(result[1]).toBe("echo done")
		})

		it("treats a herestring with a single-quoted multiline word as one command", () => {
			// The quoted word after <<< may contain embedded newlines via quoting;
			// those newlines are handled by the single-quote masker, not the heredoc
			// scanner. The whole construct is one command.
			const input = "sh <<< 'echo line1\necho line2'"
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("treats a herestring with an ANSI-C quoted multiline word as one command", () => {
			const input = "sh <<< $'echo line1\\necho line2'"
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("does not report an unterminated quote for a balanced herestring", () => {
			expect(findUnterminatedQuote(`sh <<< "echo hello"`)).toBeNull()
			expect(findUnterminatedQuote("sh <<< 'echo hello'")).toBeNull()
		})
	})

	describe('locale quoting ($"...")', () => {
		// Locale quoting $"..." behaves like double quotes for delimiter purposes
		// but the $ prefix is part of the token and must be preserved verbatim.

		it("treats a locale-quoted argument as one command", () => {
			const input = `echo $"hello world"`
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("does not split on operators inside a locale-quoted string", () => {
			const input = `echo $"hello && world"`
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("does not split on a newline inside a locale-quoted string", () => {
			const input = `echo $"hello\nworld"`
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("preserves the $ prefix in the output without leaking placeholders", () => {
			const input = `echo $"greeting" && echo done`
			const { commands: result } = parseCommand(input)
			expect(result[0]).toContain('$"greeting"')
			expect(result.join(" ")).not.toContain("__")
		})

		it("returns an unterminated locale-quoted string as one opaque token with a parseError", () => {
			const input = `echo $"hello`
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("locale")
		})
	})

	describe("placeholder collision guard", () => {
		// If the raw command literally contains the internal placeholder tokens
		// (e.g. __QUOTE_0__) the pre-escape/post-unescape round-trip must preserve
		// them verbatim instead of corrupting them during the masking phase.
		it("round-trips a command that contains every internal placeholder token", () => {
			const input =
				"echo __QUOTE_0__ __SQUOTE_0__ __REDIR_0__ __ARITH_0__ __PARAM_0__ __VAR_0__ __SUBSH_0__ __TOPLEVEL_QUOTE_0__"
			expect(parseCommand(input).commands).toEqual([input])
		})
	})

	describe("findUnterminatedQuote", () => {
		it("returns null for balanced and quote-free input", () => {
			expect(findUnterminatedQuote("git status")).toBeNull()
			expect(findUnterminatedQuote("echo 'hello'")).toBeNull()
			expect(findUnterminatedQuote('echo "hello"')).toBeNull()
			expect(findUnterminatedQuote("sh -c 'echo a\necho b'")).toBeNull()
			expect(findUnterminatedQuote("sh -c $'echo a\necho b'")).toBeNull()
		})

		it("detects an unterminated single quote and reports its opening index", () => {
			expect(findUnterminatedQuote("echo 'hello")).toEqual(
				expect.objectContaining({ quoteType: "posix-single", openIndex: 5 }),
			)
		})

		it("detects an unterminated double quote and reports its opening index", () => {
			expect(findUnterminatedQuote('echo "hello')).toEqual(
				expect.objectContaining({ quoteType: "double", openIndex: 5 }),
			)
		})

		it("reports ansi-c style and the $ position for an unterminated ANSI-C quote", () => {
			expect(findUnterminatedQuote("echo $'hello")).toEqual(
				expect.objectContaining({ quoteType: "ansi-c", openIndex: 5 }),
			)
		})

		it("treats a backslash-escaped quote outside a string as literal", () => {
			// `echo \'` is a literal quote, not an unterminated region.
			expect(findUnterminatedQuote("echo \\'")).toBeNull()
			expect(findUnterminatedQuote('echo \\"')).toBeNull()
		})

		it("ignores a quote that appears inside a comment", () => {
			expect(findUnterminatedQuote("echo hi # it's fine")).toBeNull()
		})

		it("ignores an apostrophe inside a # comment that follows a closed quoted argument", () => {
			// A well-formed quoted argument followed by a comment whose content
			// contains a quote character. The comment apostrophe must not open a
			// new region.
			expect(findUnterminatedQuote("echo 'hello' # it's a comment")).toBeNull()
			expect(findUnterminatedQuote('echo "hello" # it\'s a comment')).toBeNull()
		})

		it("treats # attached to a word as an ordinary character", () => {
			expect(findUnterminatedQuote("echo foo#'bar'")).toBeNull()
			expect(findUnterminatedQuote("echo foo#'bar")).toEqual(
				expect.objectContaining({ quoteType: "posix-single", openIndex: 9 }),
			)
		})

		it("does not let an apostrophe inside double quotes open a region", () => {
			expect(findUnterminatedQuote(`echo "don't"`)).toBeNull()
		})

		it("does not let a double quote inside single quotes open a region", () => {
			expect(findUnterminatedQuote(`echo 'a " b'`)).toBeNull()
		})

		it("honors backslash escapes inside double quotes", () => {
			// The escaped quote does not close the region; the final quote does.
			expect(findUnterminatedQuote('echo "a \\" b"')).toBeNull()
			expect(findUnterminatedQuote('echo "a \\"')?.quoteType).toBe("double")
		})

		it("honors backslash escapes inside ANSI-C quotes", () => {
			expect(findUnterminatedQuote("echo $'it\\'s ok'")).toBeNull()
			expect(findUnterminatedQuote("echo $'it\\'s ok")?.quoteType).toBe("ansi-c")
		})

		it("treats POSIX single quotes as opaque to backslashes", () => {
			// Inside a POSIX single quote a backslash is literal, so the quote
			// closes at the next apostrophe regardless of any preceding backslash.
			expect(findUnterminatedQuote("echo 'a\\'")).toBeNull()
		})

		it("reports locale style and the $ position for an unterminated locale quote", () => {
			expect(findUnterminatedQuote('echo $"hello')).toEqual(
				expect.objectContaining({ quoteType: "locale", openIndex: 5 }),
			)
		})

		it("returns null for a balanced locale-quoted string", () => {
			expect(findUnterminatedQuote('echo $"hello world"')).toBeNull()
		})

		it("returns null for a balanced <<- heredoc with an indented terminator", () => {
			// The <<- form alone enables tab stripping. Unconditional stripping
			// would make << and <<- indistinguishable at the terminator.
			expect(findUnterminatedQuote("sh <<-EOF\n\techo hello\n\tEOF")).toBeNull()
		})
	})

	describe("command substitution extraction", () => {
		// Every command substitution must be extracted with balanced-paren
		// awareness wherever it sits, so each inner command matches the
		// allow/deny lists on its own.

		it("extracts the inner payload of a nested substitution as its own segment", () => {
			// A non-balanced parser truncates the payload at the first ')' and hides
			// the inner command from the lists.
			expect(parseCommand("echo $(foo $(bar))").commands).toEqual(["echo", "foo", "bar"])
		})

		it("extracts a substitution embedded inside a parameter expansion", () => {
			// ${x:-$(cmd)} falls back to running the substitution when x is
			// unset, so the payload must be matched independently even though
			// the expansion itself stays verbatim in its host segment.
			const input = "echo ${x:-$(rm -rf ~/work)}"
			expect(parseCommand(input).commands).toEqual([input, "rm -rf ~/work"])
		})

		it("extracts a substitution inside a parameter expansion inside a substitution", () => {
			// Recursion: the outer $() payload is re-scanned, which finds the
			// ${b:-$(c)} expansion and extracts c from inside it.
			expect(parseCommand("$(a ${b:-$(c)} d)").commands).toEqual(["a ${b:-$(c)} d", "c"])
		})

		it("extracts a process substitution written inside a parameter expansion", () => {
			// bash parses `<(` inside `${…}` as a process substitution. bash
			// replaces it with a device path, so the inner command may run. It
			// must match the allowlists on its own. It must not share the
			// allowlist match of the expansion word.
			const input = "echo ${x:-<(rm a)}"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "rm a"])
		})

		it("extracts a process substitution nested inside a command substitution", () => {
			// bash expands `<(` inside `$(…)`. The inner command runs with the
			// payload. It must match the allowlists on its own.
			const { commands, parseError } = parseCommand("echo $(cat <(rm a))")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat", "rm a"])
		})

		it("extracts both sides of a process substitution pair", () => {
			expect(parseCommand("diff <(sort a) <(sort b)").commands).toEqual(["diff", "sort a", "sort b"])
		})

		it("extracts a nested process substitution", () => {
			expect(parseCommand("cat <(a <(b))").commands).toEqual(["cat", "a", "b"])
		})

		it("closes a backtick region at the next backtick (backticks do not nest)", () => {
			// The second ` closes the first region. The third ` opens a second
			// region. The text between the two regions stays in its host word.
			expect(parseCommand("echo `a`b`c`").commands).toEqual(["echo", "a", "b", "c"])
		})

		it("masks arithmetic without emitting segments from inside it", () => {
			// $((...)) and $[...] are not command substitutions. The whole
			// arithmetic stays inside the host word. It never balances as an
			// extraction delimiter.
			expect(parseCommand("echo $((1+2))").commands).toEqual(["echo $((1+2))"])
			expect(parseCommand("echo $[1+2]").commands).toEqual(["echo $[1+2]"])
		})

		it("extracts substitutions from an unquoted-delimiter heredoc body while the heredoc stays one segment", () => {
			// The shell expands $(...) inside such bodies, so the payload must
			// match the lists on its own. The heredoc itself stays opaque.
			const input = "cat <<EOF\n$(whoami)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "whoami"])
		})

		it("extracts a substitution inside a closed $((…)) as its own segment", () => {
			// bash performs command substitutions inside $((…)) before it
			// evaluates the arithmetic. The payload must therefore match the
			// lists on its own. It must not share the allowlist match of the
			// host word.
			const input = "echo $(( $(rm -rf /) ))"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "rm -rf /"])
		})

		it("extracts a substitution inside a closed $[…] as its own segment", () => {
			// `$[ … ]` is the deprecated arithmetic form. Like $((…)), it expands
			// command substitutions before it evaluates. The payload must
			// therefore match the lists on its own. It must not share the
			// allowlist match of the host word.
			const input = "echo $[1+$(whoami)]"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "whoami"])
		})

		it("fails closed on an unclosed $[ whose interior holds a substitution", () => {
			// bash reports a syntax error when the `]` never arrives, so the
			// input must not look well-formed to the allowlists.
			const input = "echo $[1+$(whoami)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("arithmetic")
		})

		it("fails closed when a nested ] slices a $[…] payload open", () => {
			// bash tracks bracket nesting through its arithmetic grammar. The
			// scanner ends `$[…]` at the first `]`. The truncated payload then
			// leaves its `$(` unclosed. That fails closed, like the shell's own
			// arithmetic syntax error for the same input. This holds at top
			// level and inside a heredoc body.
			const input = "echo $[1+$(echo ])]"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
			const body = "cat <<EOF\n$[1+$(echo ])]\nEOF"
			const bodyResult = parseCommand(body)
			expect(bodyResult.commands).toEqual([body])
			expect(bodyResult.parseError?.quoteType).toBe("command-substitution")
		})

		it("does not extract from a quoted-delimiter heredoc body (the shell suppresses expansion there)", () => {
			const input = "cat <<'EOF'\n$(whoami)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("extracts a substitution from the alternate word of a parameter expansion", () => {
			// With x unset, bash expands the alternate word and runs $(evil).
			// `<<EOF` inside `${…}` is literal word text, not a heredoc opener.
			// The substitution therefore stays live. It must surface as its own
			// segment even though the expansion host stays verbatim.
			const input = "cat ${x:-y <<EOF\n$(evil)\nEOF\n}"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "evil"])
		})

		it("extracts a substitution from a quoted-delimiter shape inside a parameter expansion", () => {
			// bash runs the `$(evil)` here: `<<'EOF'` inside `${…}` is not a
			// heredoc operator, so the alternate word expands the substitution
			// like any other word text. Masking it as heredoc body would skip
			// allowlisting a command bash actually executes.
			const input = "cat ${x:-y <<'EOF'\n$(evil)\nEOF\n}"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "evil"])
		})

		it("extracts a substitution after the delimiter on a heredoc opener line", () => {
			// The opener line's remainder is expanded regardless of delimiter quoting:
			// bash runs the substitution sitting between the delimiter and the newline.
			const { commands, parseError } = parseCommand("cat <<EOF $(whoami)\nbody\nEOF")
			expect(parseError).toBeNull()
			// The remainder is live host text: the masked region keeps the
			// delimiter word, body, and terminator, and the substitution is
			// reassembled by the tokenizer and routed to its own segment.
			expect(commands).toEqual(["cat <<EOF\nbody\nEOF $ ( whoami )", "whoami"])
		})

		it("extracts opener-line substitutions for quoted and <<- delimiters too", () => {
			// Quoting suppresses expansion in the body only, never on the opener
			// line, so <<'EOF' and <<- carry the same remainder obligation as <<.
			expect(parseCommand("cat <<'EOF' $(whoami)\nbody\nEOF").commands).toEqual([
				"cat <<'EOF'\nbody\nEOF $ ( whoami )",
				"whoami",
			])
			expect(parseCommand("cat <<-EOF\t$(whoami)\nbody\nEOF").commands).toEqual([
				"cat <<-EOF\nbody\nEOF $ ( whoami )",
				"whoami",
			])
		})

		it("splits a chain operator after the delimiter out of the heredoc segment", () => {
			// The text after the delimiter word is live syntax: bash pipes the
			// heredoc into `rm x`, so the operator's right-hand command must
			// match the lists on its own instead of riding the heredoc head.
			const { commands, parseError } = parseCommand("echo $(cat <<E | rm x\nhi\nE\n)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat <<E\nhi\nE", "rm x"])
			// The split respects quoting: a `|` inside the argument stays word text.
			const quoted = parseCommand('echo $(cat <<E | grep "a|b"\nhi\nE\n)')
			expect(quoted.parseError).toBeNull()
			expect(quoted.commands).toEqual(["echo", "cat <<E\nhi\nE", "grep a|b"])
		})

		it("keeps an operator-free opener remainder in one segment (no over-split)", () => {
			// Without an operator the remainder is just more words of the
			// opener's command; the heredoc stays a single segment.
			expect(parseCommand("cat <<E arg\nhi\nE").commands).toEqual(["cat <<E\nhi\nE arg"])
			// The same split applies at the top level: a second pipeline stage
			// after the delimiter must not share the heredoc head's word.
			expect(parseCommand("cat <<E | rm x\nhi\nE").commands).toEqual(["cat <<E\nhi\nE", "rm x"])
		})

		it("keeps a mid-word # in the opener remainder from swallowing the tail", () => {
			// bash treats a mid-word `#` as an ordinary character. The tokenizer
			// would drop everything after it as comment text. The remainder
			// emission masks that `#` like the live-text scan does, so the
			// `rm x` after the pipe reaches a segment of its own.
			const input = "echo $(cat <<E f#g | rm x\nhi\nE\n)"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat <<E\nhi\nE f#g", "rm x"])
		})

		it("keeps a word-initial # remainder as the comment bash sees", () => {
			// At a word start the tokenizer and bash agree: the `#` opens a
			// comment that runs to end of line, and nothing after it executes.
			const { commands, parseError } = parseCommand("cat <<E # note\nhi\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nhi\nE"])
		})

		it("fails closed on an odd backslash run at the end of the opener remainder", () => {
			// bash joins the `\`+LF pair, so `| rm x` executes from the opener
			// line. The remainder cut stops at that LF, so it cannot account
			// for the joined bytes. The heredoc fails closed instead of
			// approving a command the decomposition never surfaced.
			const input = "echo $(cat <<E \\\n| rm x\nhi\nE\n)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("ends the delimiter word at an unquoted operator so the tail splits", () => {
			// bash tokenizes `cat <<EOF|grep y` as the word `EOF` plus a live
			// pipe, exactly like the spaced idiom. The terminator comparison
			// must use `EOF`, not `EOF|grep`, so the well-terminated body
			// closes and the tail splits into its own segment.
			const input = "cat <<EOF|grep y\nhi\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\nhi\nEOF", "grep y"])
		})

		it("fails closed when a glued-operator delimiter hides the real terminator", () => {
			// bash takes `E` as the delimiter word for `cat <<E|rm x`, so the
			// body runs to end of input: the line `E|rm` never terminates it
			// and `rm x` executes live. The parser must not match that line as
			// a terminator, so the construct fails closed.
			const input = "echo $(cat <<E|rm x\nhi\nE|rm\n)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("keeps a # glued to a command-substitution closer from swallowing the tail", () => {
			// bash ends `$(ls)` but not the word: the `#` is mid-word content
			// and `; rm y` stays live. A word-initial reading would drop the
			// tail as comment text, so the closer takes the placeholder channel.
			const { commands, parseError } = parseCommand("echo $(cat <<E $(ls)#x ; rm y\nhi\nE\n)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat <<E\nhi\nE $ ( ls ) #x", "ls", "rm y"])
		})

		it("keeps a # glued to a command-substitution closer at the top level too", () => {
			// The same closer rule without the surrounding expansion: the deny
			// head after the operator must reach its own segment.
			const { commands, parseError } = parseCommand("cat <<E $(ls)#x ; rm y\nhi\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nhi\nE $ ( ls ) #x", "ls", "rm y"])
		})

		it("keeps a # glued to a process-substitution closer from swallowing the tail", () => {
			// `<(...)` closes a word-continuing region exactly like `$(...)`.
			const { commands, parseError } = parseCommand("echo $(cat <<E <(ls)#x ; rm y\nhi\nE\n)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat <<E\nhi\nE <( ls ) #x", "ls", "rm y"])
		})

		it("keeps a # glued to a substitution closer working against a glued pipe", () => {
			// The operator needs no surrounding blanks: bash still runs the
			// right-hand command, so it must split into its own segment.
			const { commands, parseError } = parseCommand("echo $(cat <<E $(ls)#x|rm y\nhi\nE\n)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat <<E\nhi\nE $ ( ls ) #x", "ls", "rm y"])
		})

		it("keeps a # glued to a backtick closer from swallowing the tail", () => {
			// The backtick region closes the expansion but not the word, like
			// every other closer, in the split and the glued-operator shape.
			const split = parseCommand("echo $(cat <<E `ls`#x ; rm y\nhi\nE\n)")
			expect(split.parseError).toBeNull()
			expect(split.commands).toEqual(["echo", "cat <<E\nhi\nE `ls`#x", "ls", "rm y"])
			const glued = parseCommand("echo $(cat <<E `ls`#x|rm y\nhi\nE\n)")
			expect(glued.parseError).toBeNull()
			expect(glued.commands).toEqual(["echo", "cat <<E\nhi\nE `ls`#x", "ls", "rm y"])
		})

		it("keeps a # glued to a parameter or arithmetic closer from swallowing the tail", () => {
			// `${x}` and `$((1))` end an expansion, not the word: bash treats
			// the `#` as ordinary content and runs the tail. The arithmetic
			// frame must close at its second `)`, never the first.
			const param = parseCommand("cat <<E ${x}#y ; rm z\nhi\nE")
			expect(param.parseError).toBeNull()
			expect(param.commands).toEqual(["cat <<E\nhi\nE #y", "rm z"])
			const arith = parseCommand("cat <<E $((1))#y ; rm z\nhi\nE")
			expect(arith.parseError).toBeNull()
			expect(arith.commands).toEqual(["cat <<E\nhi\nE $ ( ( 1 ) ) #y", "rm z"])
		})

		it("keeps a # glued to a closed quote in the remainder on the placeholder path", () => {
			// Quotes pass through the walk unmasked, so the quote-then-`#`
			// word keeps the behavior the escaped-hash control established:
			// the tail survives tokenization.
			const dq = parseCommand('echo $(cat <<E "a"#x ; rm y\nhi\nE\n)')
			expect(dq.parseError).toBeNull()
			expect(dq.commands).toEqual(["echo", "cat <<E\nhi\nE a#x", "rm y"])
			const sq = parseCommand("echo $(cat <<E 'a'#x ; rm y\nhi\nE\n)")
			expect(sq.parseError).toBeNull()
			expect(sq.commands).toEqual(["echo", "cat <<E\nhi\nE a#x", "rm y"])
		})

		it("keeps a spaced # after a closer in the remainder as the comment bash sees", () => {
			// A blank before the `#` puts it at a real word start: bash starts
			// a comment there and never runs the tail. The closer rule must not
			// widen past a `#` directly after the closer.
			const { commands, parseError } = parseCommand("echo $(cat <<E $(ls) #x ; rm y\nhi\nE\n)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat <<E\nhi\nE $ ( ls )", "ls"])
		})

		it("fails closed on a delimiter glued to a subshell paren", () => {
			// bash refuses `cat <<E(rm x)`: a `(` after a completed word token
			// is a syntax error, never a delimiter break. The word keeps the
			// parens, no body line matches it, and the construct fails closed
			// exactly like the base parser instead of approving unexecutable
			// input whose remainder hides the parenthesized text unsplit.
			const input = "cat <<E(rm x)\nhi\nE"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a delimiter glued to a subshell paren inside a substitution", () => {
			// The embedding expansion changes nothing: the opener line is
			// still bash-illegal at the glued `(`.
			const input = "echo $(cat <<E(rm x)\nhi\nE\n)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a delimiter glued to a subshell paren through a tab", () => {
			// A tab after the glued parens is still inside the illegal token.
			const input = "cat <<E(rm x)\t\nhi\nE"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("splits a spaced parenthesized remainder as before (no over-reject)", () => {
			// A blank before the `(` ends the delimiter word the way bash's
			// token boundary does: the heredoc closes and the group reaches
			// the host text unsplit, approved at base and now alike.
			const { commands, parseError } = parseCommand("cat <<E (rm x)\nhi\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nhi\nE ( rm x )"])
		})

		it("keeps braces and mid-word parens as delimiter word characters", () => {
			// `{` is no metacharacter: `E{rm x;}` is one word whose body never
			// terminates. A `(` after a nonempty word is illegal in bash, so
			// `x=1(y)` keeps the paren inside the word and the heredoc closes
			// at `E` with the remainder as live host text.
			const glued = parseCommand("cat <<E{rm x;}\nhi\nE")
			expect(glued.commands).toEqual(["cat <<E{rm x;}\nhi\nE"])
			expect(glued.parseError?.quoteType).toBe("heredoc")
			const midword = parseCommand("cat <<E x=1(y)\nhi\nE")
			expect(midword.parseError).toBeNull()
			expect(midword.commands).toEqual(["cat <<E\nhi\nE x=1 ( y )"])
		})

		it("fails closed on a delimiter glued to a closing paren", () => {
			// `)` is a metacharacter only at token start; glued after the word
			// `E` it is a syntax error in bash, so the word keeps it, the body
			// never terminates, and the base rejection is restored.
			const input = "cat <<E)rm x\nhi\nE"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when a metacharacter starts the delimiter word", () => {
			// A `(` or `)` can only start a metacharacter, never a word: with
			// the word absent, the opener breaks on the metacharacter and the
			// no-word metacharacter guard fails the construct closed. bash needs a
			// word token after the redirection operator and rejects this input
			// outright, so no rejection here can cost an executable command. A body
			// line that matches the metacharacter word (the terminator-matching
			// variant of each shape) fails closed too: the guard cannot tell the
			// body apart, and bash never executes this input either way.
			const cases: string[] = ["cat <<(x)\nhi\n(x)", "cat <<(x)\nhi\nE", "cat <<)x\nhi\nE"]
			for (const input of cases) {
				const { commands, parseError } = parseCommand(input)
				expect(commands).toEqual([input])
				expect(parseError?.quoteType).toBe("heredoc")
			}
		})

		it("fails closed on every word-start operator shape", () => {
			// One assert per word-start metacharacter in the delimiter break
			// set, including the `<<-` and spaced-`<` variants. bash ends the
			// absent word at the operator token and rejects the whole command
			// before executing anything, so each shape fails closed with the
			// raw input.
			const cases: string[] = [
				"cat <<|rm x\nhi\nE",
				"cat <<&rm x\nhi\nE",
				"cat <<;rm x\nhi\nE",
				"cat <<(x)\nhi\nE",
				"cat <<)x\nhi\nE",
				"cat <<>f\nhi\nE",
				"cat << <f\nhi\nE",
				"cat <<-|rm x\nhi\nE",
			]
			for (const input of cases) {
				const { commands, parseError } = parseCommand(input)
				expect(commands).toEqual([input])
				expect(parseError?.quoteType).toBe("heredoc")
			}
		})

		it("fails closed on a word-start operator inside a substitution frame", () => {
			// The expansion-frame call site shares the guard: a heredoc opened
			// inside `$(…)` with an operator instead of a delimiter word fails
			// closed the same way. The guard fires at the opener, so a body
			// line matching the metacharacter word never reaches the
			// terminator search.
			for (const input of ["echo $(cat <<(x)\nhi\nE\n)", "echo $(cat <<(x)\nhi\n(x)\n)"]) {
				const { commands, parseError } = parseCommand(input)
				expect(commands).toEqual([input])
				expect(parseError?.quoteType).toBe("heredoc")
			}
		})

		it("keeps # a delimiter word character and controls the no-word paths", () => {
			// `#` never enters the delimiter break sets: the word keeps it, so
			// a non-matching body fails like any unmatched delimiter and a
			// matching body closes -- unchanged by the metacharacter guard.
			const unmatched = parseCommand("cat <<#x\nhi\nE")
			expect(unmatched.commands).toEqual(["cat <<#x\nhi\nE"])
			expect(unmatched.parseError?.quoteType).toBe("heredoc")
			const matched = parseCommand("cat <<#x\nhi\n#x")
			expect(matched.parseError).toBeNull()
			expect(matched.commands).toEqual(["cat <<#x\nhi\n#x"])
			// End-of-input control for the guard's boundary clause: with no
			// line ending at all the opener still fails closed, whether the
			// guard or the opener-line check reports it.
			const atEof = parseCommand("cat <<")
			expect(atEof.commands).toEqual(["cat <<"])
			expect(atEof.parseError?.quoteType).toBe("heredoc")
		})

		it("splits a chain after a group closer glued to # in the opener remainder", () => {
			// bash balances the inner `(ls)` group before the `$( … )` closer,
			// so the closer ends the region, the glued `#` takes the
			// placeholder, and `rm y` stays live. Dropping the group tracking
			// pops the frame at the inner `)`, lands the closer early, and lets
			// the `#` read as a word-initial comment that swallows the tail.
			const { commands, parseError } = parseCommand("cat <<E $( (ls) )#x ; rm y\nhi\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nhi\nE $ ( ( ls ) ) #x", "( ls )", "rm y"])
		})
	})

	describe("heredoc opener-remainder walk and backslash-run guard", () => {
		// The text after the delimiter word on the opener line is live syntax
		// the outer scan never revisits: a dedicated walk applies the comment,
		// region, and escape policy to it, and a trailing backslash-run guard
		// decides whether an odd unquoted run joins the body onto the opener
		// line. Each pin below walks a branch of one of the two mechanisms and
		// pins bytes only that branch produces.

		it("emits an escaped # in the opener remainder verbatim", () => {
			// The escape-pair branch forwards `\<char>` whole, so the `#` is
			// word content and no comment starts. Shortening or reversing the
			// emitted pair shifts every later index, which the exact host
			// bytes here catch.
			const { commands, parseError } = parseCommand("cat <<E \\#x\nbody\nE\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE #x"])
		})

		it("keeps a # directly after an escaped blank on the placeholder path", () => {
			// The escape pair ends one index past the blank, so the `#`
			// continues the word and takes the opaque placeholder instead of
			// opening a comment. Moving the tracked escape end two bytes
			// earlier makes the `#` word-initial and drops the `#b` tail.
			const { commands, parseError } = parseCommand("cat <<E a\\ #b\nbody\nE\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE a #b"])
		})

		it("treats a backtick region in the opener remainder as opaque until its closer", () => {
			// Backticks do not nest: the walk treats the region as opaque until
			// the closer, and the closer ends the frame. The extracted payload
			// plus the split host bytes pin the frame's open, opacity, and
			// close together.
			const { commands, parseError } = parseCommand("cat <<E `a#b`\nbody\nE\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE `a", "a#b"])
		})

		it("starts the opener-remainder comment at a # after a bare (", () => {
			// A bare `(` with no region open is host grouping, so the `#` sits
			// at a word start and opens the comment bash sees: the host stops
			// right after the paren. Inspecting the character after the `#`
			// instead of before it reads the `#` as mid-word and keeps the
			// tail.
			const { commands, parseError } = parseCommand("cat <<E x(#y\nbody\nE\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE x ("])
		})

		const guardRows: Array<{ name: string; input: string; commands: string[]; error: "heredoc" | null }> = [
			{
				name: "fails closed on an odd unquoted backslash run",
				input: "cat <<E x\\\nbody\nE\n",
				commands: ["cat <<E x\\\nbody\nE\n"],
				error: "heredoc",
			},
			{
				name: "joins nothing after an even unquoted run and closes at the terminator",
				input: "cat <<E x\\\\\nbody\nE\nbody2\nE\n",
				commands: ["cat <<E\nbody\nE x\\", "body2", "E"],
				error: null,
			},
			{
				name: "keeps a single-quoted backslash literal at the run",
				input: "cat <<E 'x\\\nbody\nE\n",
				commands: ["cat <<E\nbody\nE x"],
				error: null,
			},
			{
				name: "fails closed on an odd run inside double quotes",
				input: 'cat <<E "x\\\nbody\nE\n',
				commands: ['cat <<E "x\\\nbody\nE\n'],
				error: "heredoc",
			},
			{
				name: "fails closed on an odd run after a closed double quote",
				input: 'cat <<E "a"\\\nbody\nE\n',
				commands: ['cat <<E "a"\\\nbody\nE\n'],
				error: "heredoc",
			},
			{
				name: "fails closed on an odd run after an escaped backslash inside double quotes",
				input: 'cat <<E "\\\\"\\\nbody\nE\n',
				commands: ['cat <<E "\\\\"\\\nbody\nE\n'],
				error: "heredoc",
			},
			{
				name: "fails closed on an odd run after a closed single quote",
				input: "cat <<E 'a'\\\nbody\nE\n",
				commands: ["cat <<E 'a'\\\nbody\nE\n"],
				error: "heredoc",
			},
			{
				name: "keeps a run covered by an open single quote silent",
				input: "cat <<E 'a\\\\\\\nbody\nE\nbody2\nE\n",
				commands: ["cat <<E\nbody\nE a\\", "body2", "E"],
				error: null,
			},
			{
				name: "fails closed on an odd run after an escaped double quote",
				input: 'cat <<E \\"\\\nbody\nE\n',
				commands: ['cat <<E \\"\\\nbody\nE\n'],
				error: "heredoc",
			},
			{
				// `\'` keeps the following `'` escaped, so the run is unquoted
				// and joins the body's `; rm -rf /` line onto the opener. The
				// guard's unquoted escape-advance branch decides this; losing
				// it reads the run as single-quoted and accepts the join.
				name: "fails closed on an odd run after an escaped single quote",
				input: "cat <<E a\\'\\\n; rm -rf /\nE\n",
				commands: ["cat <<E a\\'\\\n; rm -rf /\nE\n"],
				error: "heredoc",
			},
			{
				// The `\"` pairs inside the double quote, the following `'`
				// starts a single-quote region that the double-quote branch's
				// advance never skips, and the run joins the deny line. Walking
				// the `'` as double-quote content accepts the construct.
				name: "fails closed on an odd run started after a double-quoted region ends in an open single quote",
				input: 'cat <<E "a\\"b\'\\\n; rm -rf /\nE\n',
				commands: ['cat <<E "a\\"b\'\\\n; rm -rf /\nE\n'],
				error: "heredoc",
			},
			{
				// `"a"` closes, then `b'` opens a single quote that stays open
				// into the run: the guard must see the single-quote state at
				// the run and stay silent. A walk that skips the post-quote
				// bare text enters the wrong branch and rejects this opener.
				name: "keeps an open single quote silent over the run after a closed double quote",
				input: 'cat <<E "a"b\'\\\n; rm -rf /\nE\n',
				commands: ["cat <<E\n; rm -rf /\nE ab "],
				error: null,
			},
			{
				// Host parens with no region open are ordinary text; only a
				// real `$` opener pushes a frame. Reading every character as a
				// potential opener (or any `$` as one) rebalances the frames
				// here and shifts the masked comment bytes.
				name: "keeps bare host parens in the remainder as ordinary text",
				input: "cat <<E x()#y\nbody\nE\n",
				commands: ["cat <<E\nbody\nE x ( )"],
				error: null,
			},
			{
				// A `$` followed by a plain letter is not an opener: it stays
				// ordinary text and only the real `$(a)` region masks. An
				// opener test that ignores the next character pushes a phantom
				// frame for `$x` and rewrites the word-continuation `#`.
				name: "keeps a $ before a plain letter ordinary in the remainder",
				input: "cat <<E $x$(a)#y\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $ ( a ) #y", "a"],
				error: null,
			},
			{
				// The `#` sits directly at the region closer, so it continues
				// the word as a placeholder and the `; rm y` tail stays live
				// syntax the decomposition surfaces. Losing the closer index
				// reads the `#` as a comment start and swallows the tail.
				name: "continues the word at a # directly after a region closer",
				input: "cat <<E $a$(b)#; rm y\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $ ( b ) #", "b", "rm y"],
				error: null,
			},
			{
				// Inside the `(`-closing frame, the `[` frame's own `]` closer
				// is the only one that pops it: the `)` in between is a group
				// paren. Swapping the `[` detection for the wrong closer (or
				// dropping it) ends the outer region at the inner `)` and
				// changes every byte after it.
				name: "keeps a [ frame inside a ( frame closed only by its ]",
				input: "cat <<E $(a$[b)c]d)#x\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $ ( a$[b ) c]d ) #x", "a$[b)c]d"],
				error: null,
			},
			{
				// A `{` frame closes at its `}`, so the following `$(b)` opens
				// and closes as its own region and the `#` after its closer
				// continues the word. A closer picked as `)` or `]` for the
				// `{` frame never pops it, changing the masked bytes and the
				// split.
				name: "closes a { frame at its } closer in the remainder",
				input: "cat <<E ${a}$(b)#c\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $ ( b ) #c", "b"],
				error: null,
			},
			{
				// Symmetric to the `{` frame row: the `[` frame's closer is
				// `]`, and mis-picking `}` or `)` rebalances the following
				// `$(b)` region. The masked host bytes plus the split payload
				// pin the exact closer character.
				name: "closes a [ frame at its ] closer in the remainder",
				input: "cat <<E $[a]$(b)#c\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $[a]$ ( b ) #c", "b"],
				error: null,
			},
			{
				// Unmatched host parens before a region stay ordinary text;
				// the walk's frame bookkeeping starts at the `$(`. Reading the
				// double-paren detection from the wrong index here (or the
				// wrong distance) treats the leading `((` differently and
				// shifts every following host byte.
				name: "keeps unmatched host parens around a region live in the remainder",
				input: "cat <<E ((x$(b))#y\nbody\nE\n",
				commands: ["cat <<E\nbody\nE ( ( x$ ( b ) )", "b"],
				error: null,
			},
			{
				// Two nested `(`-closing frames pop one at a time on the two
				// `)`, so the `#` after the outer closer continues the word.
				// A frame that consumes both closers (or a group depth started
				// for a non-`$((` opener) leaves the frames unbalanced and
				// rewrites the tail.
				name: "closes nested ( frames one at a time in the remainder",
				input: "cat <<E $(a$(b))#y\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $ ( a$ ( b ) ) #y", "a", "b"],
				error: null,
			},
			{
				// Only the opener's own character closes a quote region, so
				// the inner apostrophes stay double-quote content and the
				// region never closes. The `#` inside the open region is
				// ordinary content and the tail rides the quotes into the
				// dropped bytes. Any walk whose quote state diverges here
				// leaves `#c` in the emitted host instead of dropping it.
				name: "keeps an inner apostrophe from closing a double-quoted remainder region",
				input: "cat <<E \"a'b'#c\nbody\nE\n",
				commands: ["cat <<E\nbody\nE ab"],
				error: null,
			},
			{
				// Symmetric to the double-quote row: a `"` inside a
				// single-quote region is literal, the region stays open, and
				// the `#` inside it is never a mask or comment decision the
				// walk takes. Closing on the wrong character keeps `#c`.
				name: "keeps an inner double quote from closing a single-quoted remainder region",
				input: 'cat <<E \'a"b"#c\nbody\nE\n',
				commands: ["cat <<E\nbody\nE ab"],
				error: null,
			},
			{
				// The closer test compares against the opener's character:
				// the closing `"` ends the region and the `#` riding at the
				// close continues the word as a placeholder, so the tail
				// survives. A walk that ends the region at the inner
				// apostrophe re-opens it at the closer and swallows `#c`.
				name: "continues the word at a # after a closed double quote",
				input: 'cat <<E "a\'b"#c\nbody\nE\n',
				commands: ["cat <<E\nbody\nE a'b#c"],
				error: null,
			},
			{
				// Symmetric closer-boundary row on a single-quote region:
				// only `'` closes `'`. Mis-testing the character leaves the
				// walk in the wrong quote state at the `#` and drops `#c`.
				name: "continues the word at a # after a closed single quote",
				input: "cat <<E 'a\"b'#c\nbody\nE\n",
				commands: ['cat <<E\nbody\nE a"b#c'],
				error: null,
			},
			{
				// `>(…)` pushes a `)`-closing frame exactly like `<(…)`, so
				// the chain's final `)` is a region closer and the `#`
				// directly at it continues the word. A walk that never opens
				// the frame reads the `#` after a bare `)` as word-initial
				// and drops `#c` as a comment.
				name: "keeps a # after a chained >(…) closer as word content",
				input: "cat <<E >(a)>(b)#c\nbody\nE\n",
				commands: ["cat <<E\nbody\nE >( a ) >( b ) #c", "a", "b"],
				error: null,
			},
			{
				// `>` only opens a process-substitution frame when `(`
				// follows immediately; here it is an ordinary redirect that
				// the walk forwards as host text. A walk that opens the
				// frame regardless of the next character swallows the
				// target's first character into the frame bytes.
				name: "keeps a plain > redirect out of the process-substitution frame",
				input: "cat <<E >out\nbody\nE\n",
				commands: ["cat <<E\nbody\nE > out"],
				error: null,
			},
			{
				// The `<` counterpart: without an immediately following `(`
				// the redirect stays ordinary text. The frame-misfire bytes
				// differ from these pins in the character right after `<`.
				name: "keeps a plain < redirect out of the process-substitution frame",
				input: "cat <<E <in\nbody\nE\n",
				commands: ["cat <<E\nbody\nE < in"],
				error: null,
			},
			{
				// The `#` rides the inner `$(b)` pop while the outer `$[ ]`
				// frame stays open, so it is ordinary frame content and bash
				// drops the `; rm -rf /]d` tail as a comment. Marking the
				// closer at an inner pop instead keeps " #c" in the host and
				// exposes the tail as a fabricated word segment.
				name: "keeps a # riding an inner closer inside an open outer frame as frame content",
				input: "cat <<E $[a$(b)#c; rm -rf /]d\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $[a$ ( b )", "b"],
				error: null,
			},
			{
				// Same class without the deny tail: the `#c` stays inside the
				// still-open `$[ ]` frame and the `]d` bytes ride the frame's
				// masked host. Closer bookkeeping fired on the inner pop
				// emits " #c" into the emitted bytes instead.
				name: "keeps a # riding an inner closer out of the host bytes of an open outer frame",
				input: "cat <<E $[a$(b)#c]d\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $[a$ ( b )", "b"],
				error: null,
			},
			{
				// The `#` rides the pop that empties the frames: the word
				// continues, the glued `#c` takes the placeholder, and
				// `; rm -rf /` stays live syntax the decomposition surfaces.
				// Only the pop leaving no frames marks the closer; inner
				// pops must not, or this tail reads as a comment.
				name: "marks the closer only on the pop that empties the frames",
				input: "cat <<E $[a$(b)]#c; rm -rf /\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $[a$ ( b ) ]#c", "b", "rm -rf /"],
				error: null,
			},
		]

		it.each(guardRows)("$name", ({ input, commands, error }) => {
			// The quote-tracking walk decides whether the trailing odd run
			// opens a join: only a single-quote region keeps the backslash
			// literal. Each row pins one state or advance branch of the walk;
			// the double-quote and escape rows additionally pin the walk's
			// advance steps, which a stalled step would hang on.
			const result = parseCommand(input)
			expect(result.commands).toEqual(commands)
			expect(result.parseError?.quoteType ?? null).toBe(error)
		})

		it("fails closed on the crafted closed-quote backslash join", () => {
			// `'a'` closes before the run, so the trailing backslash joins the
			// body's `; rm -rf /` line onto the opener line as live syntax.
			// The remainder cut stops at its own newline and cannot account
			// for the joined bytes, so the heredoc fails closed. A walk that
			// loses the single-quote state accepts the construct instead and
			// masks the joined line out of the decomposition.
			const input = "cat <<E 'a'\\\n; rm -rf /\nE\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})
	})

	describe("fail-closed on unaccountable structure", () => {
		// A command whose structure the scan cannot fully account for must cost
		// a prompt (parseError -> malformed_command), never an approval built on
		// a partial decomposition.

		it("reports an unclosed command substitution", () => {
			const input = "echo $(foo"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("reports an unclosed parameter expansion", () => {
			const input = "echo ${x"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("parameter-expansion")
		})

		it("reports an unclosed backtick region", () => {
			const input = "echo `foo"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("backtick")
		})

		it("reports an unclosed process substitution", () => {
			const input = "diff <(sort"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("process-substitution")
		})

		it("treats a closing paren at depth zero as host text", () => {
			// bash closes `case` patterns with `)`, so a bare `)` is not reliably
			// a syntax error. With the frame stack empty it cannot mask a
			// substitution, so it stays an ordinary word character.
			const input = "echo )"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo )"])
		})

		it("reports a stray closing brace at depth zero", () => {
			const input = "echo }"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("stray-closer")
		})

		it("parses words whose braces balance at depth zero", () => {
			// bash accepts all three: `find -exec {} \;` (placeholder),
			// `src/{a,b}` (brace expansion), and `HEAD@{1}` (revspec). A `}`
			// matching an open `{` is not a stray closer.
			expect(parseCommand("find . -exec rm {} \\;").parseError).toBeNull()
			expect(parseCommand("mkdir -p src/{a,b}").parseError).toBeNull()
			expect(parseCommand("git show HEAD@{1}").parseError).toBeNull()
		})

		it("parses a PowerShell script-block argument under bash brace rules", () => {
			// The splitter parses bash-style shell syntax only. It does not
			// parse PowerShell script blocks as such. bash reads this line the
			// same way: the braces balance as host words and the pipe splits
			// the command.
			const { commands, parseError } = parseCommand("Get-Process | Where-Object { $_.CPU -gt 10 }")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["Get-Process", "Where-Object { $_.CPU -gt 10 }"])
		})

		it("reads a bare trailing backtick as an unclosed substitution", () => {
			// In bash a backtick opens a command substitution, so an unmatched
			// one fails closed. PowerShell uses the backtick as an escape
			// character. The splitter keeps the bash reading.
			const input = "Write-Host a`"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("backtick")
		})

		it("parses a case-pattern closer at depth zero", () => {
			// bash closes a `case` pattern with `)` and there is no matching
			// opener, so the closer must stay host text.
			const { commands, parseError } = parseCommand("case x in a) foo ;; esac")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["case x in a ) foo ;; esac"])
		})

		it("still extracts a substitution behind a depth-0 closer and fails on an unmatched brace", () => {
			// The relaxation cannot hide a substitution: the payload after the
			// `)` is still extracted and allowlist-checked on its own.
			expect(parseCommand("echo ) ; $(rm -rf /)").commands).toEqual(["echo )", "rm -rf /"])
			// A `}` with no opener stays fail-closed even after a balanced pair.
			const unmatched = "echo {a} ; }"
			expect(parseCommand(unmatched).parseError?.quoteType).toBe("stray-closer")
		})

		it("keeps a literal << inside a parameter expansion out of the heredoc scan", () => {
			// bash reads `<<` inside `${…}` as an arithmetic shift, never as a
			// heredoc opener. `${x:1<<0 }` shifts by zero and expands normally,
			// so the expansion stays one host word and no body is masked.
			const input = "echo ${x:1<<0 }"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("extracts a substitution written after a literal << inside a parameter expansion", () => {
			// `<<EOF` inside `${…}` opens no heredoc. The `$(evil)` on the next
			// line therefore stays live syntax. A heredoc mask here would hide
			// the payload inside an opaque host word. Allowlisting would then
			// skip it.
			const input = "echo ${x:-<<EOF\n$(evil)\nEOF\n}"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "evil"])
		})

		it("fails closed when a shift-shaped expansion leaves an unpaired closing brace", () => {
			// bash runs `evil` and `E` as their own command lines. bash then
			// refuses the trailing `}`. The shift inside `${…}` never pairs it.
			// Reading `<<` as a heredoc opener would mask all three lines as
			// body text and auto-approve the command. The closed frame reports
			// the stray closer instead.
			const input = "echo ${x:1<<E }\nevil\nE\n}"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("stray-closer")
		})

		it("still parses heredocs opened inside command- and process-substitution frames", () => {
			// The shell tokenizes a command context inside `$(…)` and `<(`, so a
			// heredoc opened there is real and keeps masking its body.
			const cmd = parseCommand("echo $(cat <<EOF\nfoo\nEOF\n)")
			expect(cmd.parseError).toBeNull()
			expect(cmd.commands).toEqual(["echo", "cat <<EOF\nfoo\nEOF"])
			const proc = parseCommand("diff <(cat <<EOF\nfoo\nEOF\n) <(sort b)")
			expect(proc.parseError).toBeNull()
			expect(proc.commands).toEqual(["diff", "cat <<EOF\nfoo\nEOF", "sort b"])
			// An unterminated body inside such a frame stays fail-closed. bash
			// refuses the input outright.
			expect(parseCommand("echo $(cat <<EOF\nfoo\n)").parseError?.quoteType).toBe("heredoc")
		})

		it("treats a non-matching closer inside an open region as literal and still fails at end of input", () => {
			// '}' cannot close $( ... . That matches the shell: the character
			// is literal content. The substitution never closes, so the command
			// fails at end of input.
			const input = "echo $(a}"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("reports the widened expansion kinds with the opening index", () => {
			expect(findUnterminatedQuote("echo $(x")).toEqual(
				expect.objectContaining({ quoteType: "command-substitution", openIndex: 5 }),
			)
			expect(findUnterminatedQuote("echo `x")).toEqual(
				expect.objectContaining({ quoteType: "backtick", openIndex: 5 }),
			)
		})

		it("fails closed on a raw NUL byte anywhere in the input", () => {
			// NUL is the scan's placeholder sentinel. A raw NUL next to a
			// substitution would degrade the masked placeholder to inert text.
			// That would hide the payload. The parser therefore rejects the
			// whole command before tokenizing.
			const glued = "git status\x00$(whoami)"
			const { commands, parseError } = parseCommand(glued)
			expect(commands).toEqual([glued])
			expect(parseError?.quoteType).toBe("nul-byte")

			const backtickGlue = parseCommand("echo ok\x00`whoami`")
			expect(backtickGlue.parseError?.quoteType).toBe("nul-byte")

			const loneNul = parseCommand("\x00")
			expect(loneNul.parseError?.quoteType).toBe("nul-byte")
		})

		it("caps substitution re-scan depth at the documented boundary, failing closed past it", () => {
			// Unbounded payload re-scanning spends quadratic time on generated
			// nesting. It finally overflows the call stack. The cap turns deep
			// nesting into a parse error at exactly MAX_PAYLOAD_SCAN_DEPTH + 1
			// layers. Anything a hand-written command could contain stays
			// parseable.
			const nest = (layers: number) => "echo " + "$(a ".repeat(layers) + "x" + ")".repeat(layers)
			expect(parseCommand(nest(64)).parseError).toBeNull()
			expect(parseCommand(nest(65)).parseError?.quoteType).toBe("nesting-too-deep")
			expect(parseCommand(nest(8000)).parseError?.quoteType).toBe("nesting-too-deep")
		})

		it("fails on an unclosed substitution inside an unquoted-delimiter heredoc body", () => {
			// The scan finds the terminator line. The shell would never finish
			// expanding the body, so whatever follows the $( is unaccountable.
			const input = "cat <<EOF\n$(x\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		// bash itself refuses an unclosed `$((`/`$[` and a CR-only heredoc line
		// ending. Each must fail closed. Masking such text away could hide a
		// never-closed substitution behind an allowlisted first word.
		it("fails closed on an unclosed $(( hiding an embedded substitution", () => {
			const input = "echo $(( $(evil)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("arithmetic")
		})

		it("fails closed on an unclosed $(( that would swallow a later statement", () => {
			// Routing the masked remainder to the host instead would split the
			// input into two segments. Each segment could then match the
			// allowlist. bash rejects the input outright, so failing closed costs
			// a tool error, never an approval. The lone depth-1 closer makes bash
			// read the opener as a command substitution, so the unclosed frame
			// that swallows the later line is reported as one.
			const swallowed = "echo $((1 )\nevilcmd arg"
			const { commands, parseError } = parseCommand(swallowed)
			expect(commands).toEqual([swallowed])
			expect(parseError?.quoteType).toBe("command-substitution")
			// The matching control input keeps its extraction behavior.
			const control = "echo $(( $(evil) ))"
			expect(parseCommand(control).commands).toEqual([control, "evil"])
		})

		it("reports an unclosed $(( nested in a parameter expansion by its own kind", () => {
			// The error must name the arithmetic opener. Letting the outer
			// region fail at end of input would report the wrong construct. It
			// would also silently drop the arithmetic's interior payloads.
			const input = "echo ${x:-$(( $(evil) }"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("arithmetic")
		})

		it("fails closed on an unclosed $(( inside a heredoc body", () => {
			// A lone depth-1 closer converts the opener to a command
			// substitution; unclosed at the body end, the frame fails closed
			// under its own kind.
			const input = "cat <<EOF\n$((1 )\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("fails closed on an unclosed $[ at top level and inside a heredoc body", () => {
			// `$[` is the deprecated sibling of `$((`: bash errors on a missing
			// `]`, so an unclosed opener must fail closed exactly like `$((`.
			const top = "echo $[ $(evil)"
			expect(parseCommand(top).commands).toEqual([top])
			expect(parseCommand(top).parseError?.quoteType).toBe("arithmetic")
			expect(parseCommand("cat <<EOF\n$[ $(evil)\nEOF").parseError?.quoteType).toBe("arithmetic")
		})

		it("rejects a CR-only heredoc opener line as unterminated", () => {
			// A lone CR is not a bash line terminator, so the opener line never
			// ends: the shell reports an unterminated heredoc.
			const input = "cat <<EOF\r$(evil)\rEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("rejects a CR-only heredoc opener even when the body ends with LF", () => {
			const input = "cat <<EOF\r$(evil)\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("rejects a CR-only-bounded heredoc terminator line", () => {
			// With an LF opener and CR-only line endings in the body, "EOF\r" is
			// body text to bash. Accepting it as the terminator would validate a
			// heredoc that the shell reports as unterminated.
			const input = "cat <<EOF\nbody\rEOF\r"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a CRLF heredoc with an unquoted-body substitution", () => {
			// The opener line's CRLF already puts a CR inside the region where
			// the two layers read different bytes. The close cannot then be
			// verified in a model-independent way. The heredoc fails closed
			// before any body payload is extracted. This over-rejects even this
			// uniformly-CRLF input, whose two models happen to agree.
			const input = "cat <<EOF\r\n$(evil)\r\nEOF\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})
	})

	describe("stays parseable inside opaque regions", () => {
		// Unbalanced delimiter characters a shell never looks at inside quoted
		// regions stay parseable rather than failing closed.

		it("does not fail on an unbalanced substitution inside single quotes", () => {
			const input = "echo '$(x'"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("does not fail on unbalanced delimiters inside double quotes", () => {
			const input = 'echo "$(}"'
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("ignores a stray closer inside a comment and a substitution text inside a quoted-delimiter heredoc body", () => {
			const input = "echo hi # )\ncat <<'EOF'\n$(x\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			// The comment's stray `)` is dropped with the comment; the quoted
			// delimiter makes the body opaque, so `$(x` stays inside the
			// heredoc host word and is never extracted.
			expect(commands).toEqual(["echo hi", "cat <<'EOF'\n$(x\nEOF"])
		})
	})

	describe("empty-quoted heredoc delimiter terminates at the blank line", () => {
		// Quote removal makes `<<''`/`<<""` an empty delimiter word, which bash
		// terminates at the first blank body line. Masking those openers to end
		// of input would hide every later command behind one allowlisted word
		// while bash runs it as a separate command.

		it("splits the command after the blank-line terminator of a <<'' heredoc", () => {
			const { commands, parseError } = parseCommand("cat <<''\nbody\n\nrm -rf /")
			expect(parseError).toBeNull()
			// The scan masks the opener through the blank line as one word. What
			// follows is a separate command, and bash really does execute it.
			expect(commands).toEqual(["cat <<''\nbody\n", "rm -rf /"])
		})

		it('splits after the blank-line terminator of a <<"" heredoc too', () => {
			const { commands, parseError } = parseCommand('cat <<""\nbody\n\nrm -rf /')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<""\nbody\n', "rm -rf /"])
		})

		it("fails closed on a CRLF <<'' heredoc at its CRLF blank line", () => {
			// The blank-line terminator carries a CR inside the region from the
			// opener through the terminator line, so even the empty-delimiter
			// form fails closed rather than trusting a model-dependent close.
			const input = "cat <<''\r\nbody\r\n\r\nrm -rf /\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when a <<'' heredoc body never reaches a blank line", () => {
			// Without the blank line nothing terminates the body, so nothing
			// after the opener can be accounted for.
			const input = "cat <<''\nbody\nrm -rf /"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("keeps masking a bare-<< opener (no delimiter word) through end of input", () => {
			// A bare `<<` before end of line has no delimiter token at all. bash
			// rejects this input with a syntax error and never executes it, so
			// masking the opener through end of input over-approximates a
			// never-runnable construct and cannot hide a live command.
			const input = "cat <<\n$(whoami)\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("fails closed on a bare-<< heredoc whose opener line ends CRLF", () => {
			// The delimiter word stops at the unquoted CR. No delimiter token is
			// present, so the opener masks through end of input. The masked span
			// carries that CR. The msys read layer strips it, and POSIX bash
			// keeps it as ordinary content. The two layers would mask different
			// bytes, so the mask fails closed instead of picking one.
			const input = "cat << \r\nEOF\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a bare-<< heredoc with a lone-CR body line", () => {
			// The lone CR terminates a line for one read layer and is stripped
			// content for the other, so the masked span again spans bytes the two
			// layers do not read identically, and the mask fails closed.
			const input = "cat << \r\nEOF\n\r\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a bare-<< heredoc whose CR rides directly against the opener", () => {
			// Same shape with no blank between `<<` and the CR: the word break
			// lands on the CR itself, and the CR is still inside the masked span.
			const input = "cat <<\r\nEOF\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when a CR sits in a bare-<< mask away from the opener", () => {
			// The check spans the whole masked region, not just the bytes next
			// to `<<`. The opener line here is pure LF, and the CR opens the
			// first masked line. Both read layers make this construct
			// never-runnable. Failing it closed over-rejects. That is the
			// accepted cost of keeping one region rule for every masked heredoc
			// span.
			const input = "cat <<\nEOF\r\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a <<- heredoc with no delimiter word and a CRLF opener line", () => {
			// The dashed form strips tabs before reaching the same no-delimiter
			// masking, so the emission check covers it identically.
			const input = "cat <<- \r\nEOF\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("keeps masking a CR-free bare-<< opener through end of input", () => {
			// Accept-path control: a CR-free masked span is byte-identical under
			// both read layers, so the bare-<< masking policy is unchanged and a
			// CR-free opener still masks through end of input.
			const input = "cat <<\nEOF\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("accepts a CR on the line before a heredoc's opener line", () => {
			// The masking check spans only the opener-through-terminator region,
			// not the whole command: a CR before the opener is ordinary content
			// of an earlier line and both read layers agree on the CR-free
			// region, so the heredoc masks and the surrounding commands split.
			const input = "printf x\r\ncat <<EOF\nbody\nEOF\ncat ok\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["printf x", "cat <<EOF\nbody\nEOF", "cat ok"])
		})

		it("accepts a CR after a heredoc's terminator line", () => {
			// This is the opposite case of the pin above. A CR past the closing
			// terminator sits outside the masked region. The region stays
			// byte-identical under both read layers. The heredoc masks, and the
			// trailing CRLF line still splits as its own command.
			const input = "cat <<EOF\nbody\nEOF\nprintf y\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\nbody\nEOF", "printf y"])
		})
	})

	describe("grouping parentheses inside substitution frames", () => {
		// A subshell group `$( ( … ) )` is ordinary syntax: the shell balances
		// the group's parens independently of the substitution frame, so a bare
		// `(` inside a frame must be tracked and the group's `)` must not pop
		// the frame (which would strand the frame's own closer as a stray).

		it("parses a subshell group inside a command substitution and extracts the group payload", () => {
			const { commands, parseError } = parseCommand("echo $( (echo safe) )")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "( echo safe )"])
		})

		it("parses subshell groups inside both sides of a process-substitution pair", () => {
			const { commands, parseError } = parseCommand("diff >( (echo a) ) <( (echo b) )")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["diff", "( echo a )", "( echo b )"])
		})

		it("extracts a nested substitution through an enclosing group", () => {
			const { commands, parseError } = parseCommand("echo $( (echo $(whoami)) )")
			expect(parseError).toBeNull()
			// The group's text is sliced at the nested substitution's closer,
			// so the group's shell-word remnants flank the payload segment.
			expect(commands).toEqual(["echo", "( echo", "whoami", ")"])
		})

		it("fails closed on a group left unclosed inside a substitution", () => {
			// bash refuses this input with "unexpected EOF". The parser still
			// reports the open frames. The cost is a prompt, never a free pass.
			const input = "echo $( (echo x"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("extracts the group of a mis-nested $(( … ) … ) as its own segment", () => {
			// bash reads a `$((` whose depth-1 closer is not doubled as a
			// command substitution containing a subshell group, and runs the
			// group's command. The payload must surface as its own segment
			// instead of hiding inside the host word the way arithmetic does.
			const { commands, parseError } = parseCommand("echo $((rm -rf /) )")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "( rm -rf / )"])
		})

		it("keeps closed $(( … )) and $[ … ] arithmetic masked", () => {
			// Non-regression controls: the closer-adjacency guard must not
			// touch well-formed arithmetic, where the depth-1 closer is the
			// first character of the `))` token by construction.
			expect(parseCommand("echo $((1+2))").commands).toEqual(["echo $((1+2))"])
			expect(parseCommand("echo $(( (1) ))").commands).toEqual(["echo $(( (1) ))"])
			expect(parseCommand("echo $[1+2]").commands).toEqual(["echo $[1+2]"])
			expect(findUnterminatedQuote("echo $(( x")?.quoteType).toBe("arithmetic")
		})

		it("extracts a mis-nested $(( … ) … ) group from an unquoted heredoc body", () => {
			// The body walk re-routes the opener the same way the main scan
			// does, so a group hidden behind an allowlisted `cat` still gets
			// its own segment.
			const input = "cat <<EOF\n$((rm -rf /) )\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "( rm -rf / )"])
		})

		it("routes a nested mis-nested $(( through the frame and fails unclosed forms closed", () => {
			const { commands, parseError } = parseCommand("echo $( $((rm -rf /) ) )")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "( rm -rf / )"])
			// Without any depth-1 closer the opener stays arithmetic, as before.
			const unclosed = parseCommand("echo $((rm -rf /")
			expect(unclosed.commands).toEqual(["echo $((rm -rf /"])
			expect(unclosed.parseError?.quoteType).toBe("arithmetic")
			// With a closer that never doubles, the converted frame is the
			// outermost construct that cannot close.
			const halfClosed = parseCommand("echo $((rm -rf /) ")
			expect(halfClosed.commands).toEqual(["echo $((rm -rf /) "])
			expect(halfClosed.parseError?.quoteType).toBe("command-substitution")
		})

		it("extracts a grouped substitution whole from an unquoted heredoc body", () => {
			// The body walk balances groups inside an expansion frame the way
			// the main scan does. It treats quotes inside the frame as shell
			// syntax. If a group's closer sliced the frame here, it would
			// truncate the payload.
			const input = "cat <<EOF\n$( (echo safe) )\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "( echo safe )"])
		})

		it("parses multiple groups in one frame and keeps parens literal inside a parameter expansion", () => {
			// `(…)` inside `${…}` is literal word content, not a group, so the
			// expansion host stays verbatim and no frame tracking applies.
			const { commands, parseError } = parseCommand("echo $( (echo a) && (echo b) ) ${x:-(lit)}")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "( echo a )", "( echo b )", "${x:-(lit)}"])
		})
	})

	describe("quotes inside an expansion frame in a heredoc body", () => {
		// The shell tokenizes inside a substitution frame. A quote there is
		// therefore shell syntax. Its region masks the frame's closer and any
		// group test. A frame walk that reads a quoted `)` as the frame's
		// closer slices the payload. That leaves the bash-executed tail
		// unaccounted for. The main scan already blocks this shape through
		// quote-state gating.

		it("does not slice the frame at a quoted closer: the tail is its own segment", () => {
			// bash runs both `echo ")"` and `curl evil` from this body line.
			// Both must therefore surface as independent segments. Neither may
			// hide inside the frame's host word without its own check.
			const { commands, parseError } = parseCommand('cat <<EOF\n$( (echo ")") ; curl evil)\nEOF')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<EOF\n$( (echo ")") ; curl evil)\nEOF', '( echo ")" )', "curl evil"])
		})

		it("masks a single-quoted closer in the frame and extracts the tail separately", () => {
			const { commands, parseError } = parseCommand("cat <<EOF\n$( (echo ')') ; curl evil)\nEOF")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\n$( (echo ')') ; curl evil)\nEOF", "( echo ')' )", "curl evil"])
		})

		it("fails closed on a quoted closer in the frame under CRLF line endings", () => {
			// Every CR from the opener line through the closing terminator line
			// sits in a region the two read layers treat differently. msys
			// strips each CR, and POSIX keeps it as content. The body boundary
			// cannot then be proven in a model-independent way. The heredoc
			// fails closed before the frame walk ever runs. This over-rejects
			// even a uniformly-CRLF heredoc whose two models would agree.
			const input = 'cat <<EOF\r\n$( (echo ")") ; curl evil)\r\nEOF\r\n'
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("treats a quoted ( in the frame as text, not a group opener", () => {
			// If `(` inside the quotes opened a group, the frame's own `)` would
			// be swallowed balancing it and the payload slice would shift.
			const { commands, parseError } = parseCommand('cat <<EOF\n$( echo "a(b" ; curl evil)\nEOF')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<EOF\n$( echo "a(b" ; curl evil)\nEOF', 'echo "a(b"', "curl evil"])
		})

		it("fails closed when a quote opened inside a frame never closes before the terminator", () => {
			// The open region swallows the rest of the body (and the terminator is
			// still body text to bash), so nothing after it can be accounted for.
			const input = 'cat <<EOF\n$( echo "unclosed\nEOF\n'
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("masks a quoted closer in an opener-remainder frame too", () => {
			// The opener line's remainder shares the body walk, so it must carry
			// the same quote gating.
			const { commands, parseError } = parseCommand('cat <<EOF $( (echo ")") ; curl evil)\nbody\nEOF')
			expect(parseError).toBeNull()
			// The remainder stays live host text, so the frame's tail also
			// splits as host segments on top of the routed payload segments.
			expect(commands).toEqual([
				"cat <<EOF\nbody\nEOF $ ( ( echo ) )",
				'( echo ")" )',
				"curl evil",
				"curl evil )",
			])
		})
	})

	describe("comments inside an expansion frame in a heredoc body", () => {
		// A word-initial `#` inside a `$(…)` frame opens a comment. The shell
		// skips the comment to end of line. A frame walk that reads the `#` as
		// ordinary text pops the frame at a `)` inside that comment. It then
		// slices the payload. That leaves the bash-executed continuation lines
		// hidden inside the opaque heredoc host word. The quote gating above
		// already blocks this shape.

		it("keeps a frame open across its comment and extracts the continuation tail", () => {
			// bash runs BOTH `echo ok` and `curl evil` from this body: the
			// comment's `)` never closes the frame, the real closer is the later
			// `)`, and each executed command becomes its own segment.
			const input = "cat <<EOF\n$( echo ok # )\ncurl evil)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "echo ok", "curl evil"])
		})

		it("fails closed on a comment frame under CRLF line endings", () => {
			// A CR between the opener line and the closing terminator line
			// leaves the two layers reading different bytes. The close cannot
			// then be verified in a model-independent way. The heredoc fails
			// closed before the frame walk ever runs. This over-rejects even
			// this uniformly-CRLF input, whose two models happen to agree.
			const input = "cat <<EOF\r\n$( echo ok # )\r\ncurl evil)\r\nEOF\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("treats a # inside a quoted frame region as literal text", () => {
			// A comment starts only outside a quote, so the quoted `#)` masks the
			// closer exactly as an unquoted `)` would and the tail stays in the
			// payload.
			const { commands, parseError } = parseCommand('cat <<EOF\n$( echo "#)" ; curl evil)\nEOF')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<EOF\n$( echo "#)" ; curl evil)\nEOF', 'echo "#)"', "curl evil"])
		})

		it("treats a space-preceded # inside a quoted frame region as literal text", () => {
			// The `#` sits at a word boundary yet inside double quotes, where the
			// shell keeps it literal: only the quote frame's opacity separates it
			// from the comment rule, and the tail must still surface.
			const { commands, parseError } = parseCommand('cat <<EOF\n$( echo "a # b" ; curl evil)\nEOF')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<EOF\n$( echo "a # b" ; curl evil)\nEOF', 'echo "a # b"', "curl evil"])
		})

		it("treats a # attached to a word as part of the word, not a comment", () => {
			// bash starts a comment only at a word boundary, so `x=a#b` is one
			// argument and the `;` still separates a second executed command.
			const { commands, parseError } = parseCommand("cat <<EOF\n$( echo x=a#b ; curl evil )\nEOF")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\n$( echo x=a#b ; curl evil )\nEOF", "echo x=a#b", "curl evil"])
		})

		it("preserves a mid-word # in a top-level argument instead of commenting it out", () => {
			// The argument survives whole so a later separator can never hide
			// behind a tokenizer comment: bash runs `echo x=a#b`, and the tail
			// after `;` still splits into its own segment.
			expect(parseCommand("echo x=a#b").commands).toEqual(["echo x=a#b"])
			expect(parseCommand("echo x=a#b ; curl evil").commands).toEqual(["echo x=a#b", "curl evil"])
		})

		it("treats a # at the frame's content start as a comment", () => {
			// A `#` right after `(` sits at a word boundary. bash comments out the
			// `)` on that line. The frame closes at the later `)`, and that runs
			// `curl evil`.
			const { commands, parseError } = parseCommand("cat <<EOF\n$(# ok )\ncurl evil)\nEOF")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\n$(# ok )\ncurl evil)\nEOF", "curl evil"])
		})

		it("keeps a group's comment-blind closer from slicing the frame", () => {
			// The group's `)` sits inside the comment, so the group never closes
			// inside the frame. Whatever the re-scan makes of the rest, the
			// bash-executed `curl evil` must surface as its own segment.
			const input = "cat <<EOF\n$( (echo x # )\n) ; curl evil)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "( echo x", ")", "curl evil"])
		})

		it("fails closed when a comment swallows the frame's only closer", () => {
			// bash refuses this input with an unexpected-EOF error for the
			// missing `)`. The open frame must therefore fail the whole command
			// closed. It must never approve it.
			const input = "cat <<EOF\n$( echo # )\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("fails closed on the same comment shape in the opener-line remainder", () => {
			// The walk of the remainder stops at the line end. The comment
			// therefore leaves the frame open at that boundary, and the heredoc
			// fails closed. bash also refuses the input outright.
			const input = "cat <<EOF $( echo a # )\ncurl evil)\nbody\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("keeps a # literal inside a parameter expansion (length and trim operators)", () => {
			// `${#var}` and `${x#pat}` are operator syntax, never comments. The
			// expansion host therefore stays verbatim, and nothing fails closed.
			expect(parseCommand("cat <<EOF\n${#var}\nEOF").commands).toEqual(["cat <<EOF\n${#var}\nEOF"])
			expect(parseCommand("cat <<EOF\n${x#pat}\nEOF").commands).toEqual(["cat <<EOF\n${x#pat}\nEOF"])
		})

		it("parses the non-heredoc equivalent at top level (main-scan parity)", () => {
			// The same payload outside a body reaches a `)` at depth 0 once the
			// comment hides the context of its matching closer. A depth-0 `)`
			// cannot hide a substitution, so the closer stays host text and the
			// second line still segments on its own.
			const input = "$( echo ok # )\ncurl evil)"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo ok", "curl evil )"])
		})
	})

	describe("# riding at an expansion closer continues the word", () => {
		// bash starts a comment only at a word start. An expansion's closer ends
		// the expansion but not the surrounding word. A `#` directly after `)`,
		// `}`, a backtick, or a `]]`-style closer is therefore word content. A
		// later `;` still separates a command that bash executes. The tokenizer
		// starts a comment at any unquoted `#`, so the character must travel
		// through tokenization in masked form. A space before the `#` puts it at
		// a word start, and there the shell's comment behavior applies.

		it("extracts the tail after a # riding at a command-substitution closer", () => {
			// bash runs `curl evil` as its own command from this line. The
			// tail's segment makes the decision a prompt, never an approval.
			const { commands, parseError } = parseCommand("echo x=$(echo ok)#;curl evil")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo x=", "echo ok", "#", "curl evil"])
		})

		it("extracts the tail after a # riding at an arithmetic closer", () => {
			// `$((…))` and the deprecated `$[…]` both end at their closer. The
			// word continues past it, so the tail after `;` splits in both cases.
			expect(parseCommand("echo $((1))#;curl evil").commands).toEqual(["echo $((1))#", "curl evil"])
			expect(parseCommand("echo $[1]#;curl evil").commands).toEqual(["echo $[1]#", "curl evil"])
		})

		it("extracts the tail after a # riding at a backtick closer", () => {
			const { commands, parseError } = parseCommand("echo x=`echo ok`#;curl evil")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo x=", "echo ok", "#", "curl evil"])
		})

		it("extracts the tail after a # riding at a process-substitution closer", () => {
			// bash expands `<(…)` to a path. The word continues past the closer,
			// so the tail after `;` really executes.
			const { commands, parseError } = parseCommand("cat <(echo ok)#;curl evil")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat", "echo ok", "#", "curl evil"])
		})

		it("extracts the tail after a # riding at a parameter-expansion closer", () => {
			expect(parseCommand("echo ${x:-a}#;curl evil").commands).toEqual(["echo ${x:-a}#", "curl evil"])
		})

		it("extracts the tail after a # riding at a closing quote", () => {
			// Quote removal still leaves the word unbroken. `echo "a"#` runs
			// `echo a#`, and the tail after `;` is a separate command.
			expect(parseCommand('echo "a"#;curl evil').commands).toEqual(['echo "a"#', "curl evil"])
		})

		it("keeps a space-preceded # after a closer a comment (tail absent)", () => {
			// With whitespace between the closer and the `#`, the `#` begins a
			// word. The shell then comments out the rest of the line. The tail
			// never runs, so it must not surface as a segment.
			const { commands, parseError } = parseCommand("echo x=$(echo ok) # comment")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo x=", "echo ok"])
		})

		it("leaves # operators inside a parameter expansion untouched", () => {
			// `${x#pat}` and `${#var}` use operator syntax inside the expansion.
			// The expansion host stays verbatim as one segment. The closer rule
			// adds no extra masking or splitting inside it.
			expect(parseCommand("echo ${x#pat}").commands).toEqual(["echo ${x#pat}"])
			expect(parseCommand("echo ${#var}").commands).toEqual(["echo ${#var}"])
			expect(parseCommand("echo ${x#pat};curl evil").commands).toEqual(["echo ${x#pat}", "curl evil"])
		})
	})

	describe("# riding at the end of a backslash escape pair continues the word", () => {
		// To bash, an escaped character is ordinary word content. The word
		// therefore continues past a `\c` pair, whatever `c` is. Whitespace or a
		// metacharacter in the raw text does not put a following `#` at a word
		// start. The tokenizer starts a comment at any unquoted `#`, so this
		// position must travel through tokenization in masked form, as in the
		// expansion-closer case. A real space, not an escaped one, before the
		// `#` puts it at a word start, and there the shell's comment behavior
		// applies.

		it("extracts the tail after a # riding at any escaped-character end", () => {
			// bash runs `curl evil` as its own command from each of these lines.
			// The escaped character keeps the word open, the `#` is word
			// content, and the `;` after it separates a second command.
			expect(parseCommand("echo a\\)#;curl evil").commands).toEqual(["echo a)#", "curl evil"])
			expect(parseCommand("echo a\\;#;curl evil").commands).toEqual(["echo a;#", "curl evil"])
			expect(parseCommand("echo a\\ #;curl evil").commands).toEqual(["echo a #", "curl evil"])
			expect(parseCommand("echo a\\|#;curl evil").commands).toEqual(["echo a|#", "curl evil"])
			expect(parseCommand("echo a\\&#;curl evil").commands).toEqual(["echo a&#", "curl evil"])
			expect(parseCommand("echo a\\<#;curl evil").commands).toEqual(["echo a<#", "curl evil"])
			expect(parseCommand("echo a\\}#;curl evil").commands).toEqual(["echo a}#", "curl evil"])
		})

		it("keeps a # after an escaped ordinary character literal (mid-word control)", () => {
			// `a\bc#c` is one word to bash. The `#` was already mid-word here,
			// without the escape-end rule. This case is pinned so that a future
			// narrowing of either word-content rule shows up here.
			expect(parseCommand("echo a\\bc#c;curl evil").commands).toEqual(["echo abc#c", "curl evil"])
		})

		it("keeps an escaped # literal and never a comment", () => {
			// `\#` is an escaped character like any other. bash prints the hash
			// character, and a `;` directly after the pair still separates a
			// command.
			expect(parseCommand("echo a\\#b").commands).toEqual(["echo a#b"])
			expect(parseCommand("echo a\\#;curl evil").commands).toEqual(["echo a#", "curl evil"])
		})

		it("keeps a real-space-preceded # after an escape pair a comment (tail absent)", () => {
			// `echo a\) #c` ends the word at the unescaped space. bash therefore
			// comments out the rest of the line. The tail never runs, so it must
			// not surface as a segment.
			expect(parseCommand("echo a\\) #c;curl evil").commands).toEqual(["echo a)"])
		})

		it("extracts the tail after a # joined by a line continuation", () => {
			// The continuation joins `a` and `#c` into one word before the shell
			// tokenizes, so bash runs `curl evil`. The split segments keep that
			// tail accountable either way.
			expect(parseCommand("echo a\\\n#c;curl evil").commands).toEqual(["echo a", "#c", "curl evil"])
		})
	})

	describe("unclosed quote in a heredoc delimiter fails closed", () => {
		// A quote character inside the delimiter word opens a quote region. bash
		// carries that region across newlines until its closing quote. A word
		// that still has a region open at end of input is a delimiter that no
		// body line can ever match. The opener line's tail keeps executing as
		// ordinary syntax. This is exactly where a mask to end of input would
		// hand bash's separate commands to the allowlists unaccounted for.

		it("fails closed on the CR-delimited unclosed-quote delimiter (the approval-bypass shape)", () => {
			// bash closes the delimiter's quote on the second line. It then runs
			// `; rm -rf /` as its own command. Masking would auto-approve it.
			const input = "cat <<'X\r\n'; rm -rf /\nX\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on an LF-terminated unclosed single-quoted delimiter", () => {
			const input = "cat <<'X\n'; rm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on an unclosed double-quoted delimiter", () => {
			const input = 'cat <<"X\n"; rm -rf /\nX\n'
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a quote opened mid-word in an otherwise unquoted delimiter", () => {
			// bash starts a quote anywhere in a word. `<<EOF'` therefore swallows
			// the rest of the input just like `<<'EOF`. A fix for only the
			// leading-quote forms would leave this sibling case open.
			const input = "cat <<EOF'\n'; rm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("parses a closed mid-word quote as the literal concatenated terminator", () => {
			// `<<EOF'x'` is well-formed bash. After quote removal, the terminator
			// is the literal word EOFx. Rejecting it would over-fire.
			const { commands, parseError } = parseCommand("cat <<EOF'x'\nbody\nEOFx\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF'x'\nbody\nEOFx"])
		})

		it("propagates a malformed delimiter from a heredoc opened inside a substitution", () => {
			const input = "echo $(cat <<'X\ny\n)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})
	})

	describe("process substitution >(…) extraction", () => {
		// `>(…)` shares the frames with `<(…)`. It writes where `<(…)` reads. The
		// inner command runs unconditionally, and its output goes to a device
		// file. Its payload must therefore match the lists on its own.

		it("extracts the payload of a >() process substitution as its own segment", () => {
			const { commands, parseError } = parseCommand("cat >(evil)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat", "evil"])
		})

		it("reports an unclosed >() region", () => {
			const input = "cat >(evil"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("process-substitution")
		})

		it("extracts both payloads of a >() nested inside <()", () => {
			expect(parseCommand("cat >(a <(b))").commands).toEqual(["cat", "a", "b"])
		})

		it("keeps >(…) inside double quotes opaque (no extraction, no split)", () => {
			// Quoted text is never shell syntax. bash prints it literally.
			const input = 'cat ">(evil)"'
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})
	})

	describe("body-walk and masking edge coverage", () => {
		// The structural tests above reach some scan regions only partially. Each
		// input here pins one masking or extraction branch of the body walk, the
		// opener-line remainder, or the redirection/variable scanners.

		it("extracts a backtick payload from an unquoted heredoc body", () => {
			const input = "cat <<EOF\n`echo x`\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			// Backticks do not nest, but a pair still delimits an expansion the
			// shell runs inside an unquoted body.
			expect(commands).toEqual([input, "echo x"])
		})

		it("extracts a substitution inside $[…] within a heredoc body", () => {
			// bash expands command substitutions inside `$[ … ]`, the deprecated
			// arithmetic form, before it evaluates it. This works exactly like
			// `$(( … ))`. The payload must match the lists on its own.
			const input = "cat <<EOF\n$[1 + $(whoami)]\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "whoami"])
		})

		it("extracts both process substitutions from a heredoc body", () => {
			const input = "cat <<EOF\ndiff <(sort a) <(sort b)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "sort a", "sort b"])
		})

		it("keeps an empty-quoted delimiter inside a parameter expansion as literal text and leaks no placeholder", () => {
			const input = "echo ${x:-y <<''\nbody\n\n}"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			// `<<` inside `${…}` is literal word text, so no heredoc mask is
			// emitted. The expansion host keeps its verbatim text, and no
			// sentinel leaks into it.
			expect(commands).toEqual([input])
			expect(commands.join("")).not.toContain("\x00")
		})

		it("fails closed on an unclosed substitution in the heredoc opener-line remainder", () => {
			const input = "cat <<EOF $(unclosed\nbody\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("masks redirections without splitting them or their host command", () => {
			const { commands, parseError } = parseCommand("echo a 2>&1 && echo b 1>&2")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo a 2>&1", "echo b 1>&2"])
		})

		it("masks special-parameter variables into one host word", () => {
			const { commands, parseError } = parseCommand("echo $? $$ $! x")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo $? $$ $! x"])
		})

		it("restores arithmetic and heredoc placeholders in the shell-quote fallback path", () => {
			forceShellQuoteFailure = true
			try {
				const { commands } = parseCommand("echo $((1+1)) && cat <<EOF\nbody\nEOF")
				// Every masked placeholder must round-trip to its raw text so the
				// fallback never surfaces internal markers.
				expect(commands).toEqual(["echo $((1+1))", "cat <<EOF\nbody\nEOF"])
				expect(commands.join("")).not.toContain("\x00")
			} finally {
				forceShellQuoteFailure = false
			}
		})

		it("fails closed on an unclosed substitution riding a later line of the host", () => {
			const input = "echo a\ncat <<EOF\n$(unclosed\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("masks a closed $[…] at top level as one host word", () => {
			const { commands, parseError } = parseCommand("echo $[1+2]")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo $[1+2]"])
		})
	})

	describe("scanner primitives and frame internals", () => {
		// Each masking scanner owns an accept/reject boundary. The structural
		// tests above reach those boundaries only indirectly. Each input here
		// pins one branch.

		it("treats a lone $ and $ before a space as literal host text", () => {
			// A `$` with nothing name-like after it is not a variable reference:
			// bash passes it through, and so must the scanner.
			expect(parseCommand("echo $").commands).toEqual(["echo $"])
			expect(parseCommand("echo $ x").commands).toEqual(["echo $ x"])
		})

		it("masks a $name reference into its host word", () => {
			const { commands, parseError } = parseCommand("echo $HOME")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo $HOME"])
		})

		it("masks a bare >& redirection without splitting the host", () => {
			const { commands, parseError } = parseCommand("echo a >&2")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo a >&2"])
		})

		it("keeps nested quotes opaque inside a command substitution payload", () => {
			const { commands, parseError } = parseCommand('echo $(a "b c" d)')
			expect(parseError).toBeNull()
			// The payload is one inner command: the quoted space does not split it.
			expect(commands).toEqual(["echo", 'a "b c" d'])
		})

		it("extracts a backtick expansion nested inside a command substitution", () => {
			const { commands, parseError } = parseCommand("echo $(a `b` c)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "a", "b", "c"])
		})

		it("keeps a lone $ inside a substitution host as literal payload text", () => {
			const { commands, parseError } = parseCommand("echo $(a $ b)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "a $ b"])
		})

		it("extracts a substitution nested inside arithmetic within a substitution", () => {
			// The shell performs $(( … )) expansions inside $( … ), so `y` must
			// match the lists on its own.
			const { commands, parseError } = parseCommand("echo $(x $((1+$(y))))")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "x $((1+$(y)))", "y"])
		})

		it("names the backtick when it is opened inside arithmetic inside a substitution", () => {
			// The arithmetic interior walk owns the error so it names the
			// backtick, not the outer frame it would otherwise be blamed on.
			const input = "echo $(x $(( ` ))"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("backtick")
		})

		it("names the backtick when it is opened inside arithmetic at top level", () => {
			const input = "echo $(( `a ))"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("backtick")
		})

		it("keeps an empty substitution payload from becoming an empty segment", () => {
			const { commands, parseError } = parseCommand("echo $( )")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo"])
		})

		it("splits a multi-line substitution payload on its blank-separated lines", () => {
			const { commands, parseError } = parseCommand("echo $(a\n\nb)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "a", "b"])
		})

		it("fails closed on an unbalanced quote inside a substitution payload", () => {
			const input = 'echo $("x)'
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			// End of input reports the outermost frame: the substitution that
			// can never close because its quoted payload swallowed the closer.
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("honours a backslash-escaped character inside a double-quoted delimiter", () => {
			// `<<"a\$b"` undergoes quote removal to the literal word `a$b`, so
			// the body terminates at the line `a$b`.
			const input = 'cat <<"a\\$b"\na$b\n'
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<"a\\$b"\na$b'])
		})

		it("drops a backslash-newline line continuation inside a quoted delimiter", () => {
			// bash removes the backslash-newline pair inside double quotes, so
			// the delimiter word is the concatenation `ab`.
			const input = 'cat <<"a\\\nb"\nab\n'
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<"a\\\nb"\nab'])
		})

		it("keeps a backslash before a non-escapable character in a double-quoted delimiter", () => {
			// Inside double quotes, bash drops a backslash only before `$ ` " \
			// and newline. Before `q` it stays part of the word. The terminator
			// line is therefore `a\q`, and everything after it is live syntax
			// again rather than masked body text.
			const input = 'cat <<"a\\q"\na\\q\nrm -rf /\naq\n'
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<"a\\q"\na\\q', "rm -rf /", "aq"])
		})

		it("drops a backslash before $ inside a double-quoted delimiter", () => {
			// `$` is in the escapable set, so the delimiter is the three-char
			// word `a$q` and the matching body line terminates the heredoc.
			const input = 'cat <<"a\\$q"\na$q\nrm -rf /\n'
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<"a\\$q"\na$q', "rm -rf /"])
		})

		it("keeps backslashes verbatim in a single-quoted delimiter", () => {
			// Single quotes suppress all escaping, so the delimiter is the
			// literal `a\q` and the terminator line carries the backslash.
			const input = "cat <<'a\\q'\na\\q\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<'a\\q'\na\\q", "rm -rf /"])
		})

		it("terminates a double-quoted-delimiter heredoc after a continuation-joined word", () => {
			// Backslash-newline inside double quotes joins the word, so the
			// delimiter is `aq` and the following line is already live syntax.
			const input = 'cat <<"a\\\nq"\naq\nrm -rf /\n'
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<"a\\\nq"\naq', "rm -rf /"])
		})

		it("terminates an unquoted heredoc whose delimiter is split by line continuation", () => {
			// bash joins backslash-newline pairs before testing a body line
			// against the terminator, so `EO\` + `F` ends the heredoc there and
			// the following line executes rather than staying masked body text.
			const input = "cat <<EOF\nEO\\\nF\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\nEO\\\nF", "rm -rf /"])
		})

		it("does not join backslash-newline inside a quoted-delimiter body", () => {
			// A quoted delimiter makes every body backslash literal, so `EO\`
			// + `F` is ordinary body text and only the real `EOF` line ends the
			// heredoc.
			const input = "cat <<'EOF'\nEO\\\nF\nrm -rf /\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<'EOF'\nEO\\\nF\nrm -rf /\nEOF"])
		})

		it("strips the joined <<- terminator line's leading tabs after joining continuations", () => {
			// The join assembles the candidate from raw physical lines first;
			// tab stripping then applies once to that joined line, so the
			// tab-indented `EO\` + `F` pair still matches `EOF`.
			const input = "cat <<-EOF\n\tEO\\\nF\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<-EOF\n\tEO\\\nF", "rm -rf /"])
		})

		it("strips every leading tab of the <<- terminator line", () => {
			// Indentation depth is irrelevant: all leading tabs are stripped,
			// so a multiply tabbed terminator still matches the delimiter.
			const input = "cat <<-EOF\nbody\n\t\tEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("keeps a continuation line's tab inside the <<- terminator candidate", () => {
			// Stripping after joining leaves `EO\tF` for the pair with a tab on
			// both lines. The heredoc therefore runs to the real `EOF` line
			// instead of closing early. The commands after it stay visible for
			// approval checks, exactly as bash executes them.
			const input = "cat <<-EOF\n\tEO\\\n\tF\ncat <<X\nEOF\nrm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<-EOF\n\tEO\\\n\tF\ncat <<X\nEOF", "rm -rf /", "X"])
		})

		it("strips a tab that joins into the front of the <<- terminator", () => {
			// A continuation-only backslash leaves the candidate starting at
			// the next physical line, so the tab that opens it is the joined
			// line's leading tab and stripping removes it: the terminator
			// matches and the following command is live.
			const input = "cat <<-EOF\n\t\\\n\tEOF\ntouch x\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<-EOF\n\t\\\n\tEOF", "touch x"])
		})

		it("leaves a <<- heredoc unterminated when the joined candidate differs from the delimiter", () => {
			// `EO\` + `\tF` joins to `EO\tF`, which stays unequal to `EOF`
			// after stripping the joined line's leading tab: bash finds no
			// terminator and reads the body to end of input, so the scan
			// fails closed rather than validating the construct.
			const input = "cat <<-EOF\nEO\\\n\tF\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("does not join a line ending in an even number of backslashes", () => {
			// Two trailing backslashes escape each other, so the line ends
			// literally and the body runs to the real terminator.
			const input = "cat <<EOF\nX\\\\\nrm -rf /\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\nX\\\\\nrm -rf /\nEOF"])
		})

		it("closes the heredoc after an even backslash run and keeps the following command live", () => {
			// bash joins only odd backslash runs before matching the
			// terminator. The two backslashes escape each other, so the line
			// is ordinary body text and the next `EOF` closes the heredoc.
			// bash then runs `touch x`. A join over the even run would merge
			// the terminator into the body text, hide the live line as body,
			// and report the whole command unterminated.
			const input = "cat <<EOF\nX\\\\\nEOF\ntouch x"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\nX\\\\\nEOF", "touch x"])
		})

		it("fails closed on a heredoc whose continuation joins over a CRLF line ending", () => {
			// The msys/Cygwin read layer is the reference shell on the Windows
			// target. It strips the CR from every line it reads. The logical
			// line therefore ends with the lone backslash and continues into
			// the `F` line. That joins the candidate into the `EOF` terminator.
			// POSIX bash reads `\<CR>` as an escaped CR, with no join, so the
			// two models close on different lines. A continuation that consumes
			// a CRLF makes the mask boundary model-dependent. The heredoc
			// therefore fails closed for review instead of guessing which model
			// decides it.
			const input = "cat <<EOF\r\nEO\\\r\nF\r\ntouch x\r\nEOF\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a heredoc body line carrying a lone CR", () => {
			// The read-layer CR strip leaves `EO\F`: no continuation, and the
			// body runs to the real terminator. POSIX bash reads the backslash
			// as escaping the CR. Here the models happen to agree. The CR still
			// leaves the two layers reading different bytes, so the close cannot
			// be verified in a model-independent way. Such a heredoc fails
			// closed. That is the accepted cost of never picking a model.
			const input = "cat <<EOF\nEO\\\rF\ntouch x\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on an unquoted heredoc at a bare-CR-concatenated terminator candidate", () => {
			// The msys/Cygwin read layer strips the bare CR. The body line then
			// arrives as the terminator `EOF`, and the heredoc closes early.
			// That leaves `curl evil` live. POSIX bash keeps the CR and does
			// not close here. An early close feeds the remaining body back to
			// the scanner as live syntax. The divergence therefore fails closed
			// instead of choosing a model.
			const input = "cat <<EOF\nEO\rF\ncurl evil\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a <<- heredoc at a bare-CR-concatenated tabbed terminator candidate", () => {
			// Tab stripping applies to the CR-stripped logical line, so the
			// tab-indented `EO<CR>F` pair still matches `EOF` under the msys
			// read layer while POSIX bash keeps the CR. The model-dependent
			// close fails closed.
			const input = "cat <<-EOF\n\tEO\rF\ncurl evil\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a quoted-delimiter heredoc at a bare-CR-concatenated terminator candidate", () => {
			// The CR strip happens in the shell's read layer before quoting is
			// considered, so a quoted delimiter does not protect the body: the
			// msys model closes early at the `EO<CR>F` line while POSIX bash
			// keeps the body open. The divergence fails closed.
			const input = "cat <<'EOF'\nEO\rF\ncurl evil\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a heredoc body line whose stripped content only contains the delimiter", () => {
			// Stripping yields `EOFx`, which is not the terminator. The msys
			// read line therefore keeps the body open until the real `EOF`
			// line. POSIX bash keeps `EOF<CR>x` as ordinary body content. Both
			// models close at the same final `EOF` line. The CR inside the
			// opener-through-terminator region still leaves the two layers
			// reading different bytes. The close cannot then be verified in a
			// model-independent way, so the input fails closed for review. That
			// over-rejection is accepted, because confirming the agreement
			// would mean modeling both read layers.
			const input = "cat <<EOF\nEOF\rx\ncurl evil\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when an early CR close would re-expose a fake heredoc opener", () => {
			// The msys read layer strips the bare CR from `EO<CR>F`. That closes
			// the first heredoc early. The scanner would then read the body
			// line `cat <<X` as a live opener whose body masks `rm -rf /`.
			// POSIX bash keeps the CR and runs the line after the real `EOF`.
			// The region CR test fails this closed instead of choosing a model.
			const input = "cat <<EOF\nEO\rF\ncat <<X\nEOF\nrm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when a CRLF-joined close exposes a second masking heredoc", () => {
			// Under the msys read layer, `EO\` plus the CRLF joins into the
			// `EOF` terminator. The body text this exposes opens a second
			// heredoc that masks `printf`. POSIX bash executes that `printf`:
			// there `\<CR>` escapes the CR, and no join happens. The models
			// diverge, so the input fails closed.
			const input = "cat <<EOF\r\nEO\\\r\nF\r\ncat <<X\r\nEOF\r\nprintf 'MARKER\\n' #\r\nX\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when a CRLF-joined terminator candidate masks a following command", () => {
			// The msys read layer joins `x\` with the next line across the CRLF
			// into `xEOF`. The heredoc therefore matches only the final `EOF`
			// and masks the line in between. POSIX bash reads the delimiter
			// word as `EOF<CR>` and ends the body two lines earlier. It then
			// executes the masked line. The divergence fails closed.
			const input = "cat <<EOF\r\nx\\\r\nEOF\r\nrm -rf /\r\nEOF\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a CRLF opener line whose CR leaves the scanned body CR-free", () => {
			// The opener line's CRLF makes msys read the delimiter `EOF` while
			// POSIX bash reads `EOF<CR>`, so the CR-free `EOF` body line closes
			// the heredoc for msys only and the following `cat <<X` opener would
			// mask `rm -rf /` under one model. The CR sits on the consumed opener
			// line ending, yet it is inside the opener-through-terminator region,
			// so the heredoc fails closed.
			const input = "cat <<EOF\r\nbody\nEOF\ncat <<X\nrm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a CRLF opener line of a <<- heredoc", () => {
			// Tab stripping is orthogonal to the region test: the opener line's
			// CR already makes the delimiter word model-dependent.
			const input = "cat <<-EOF\r\nbody\nEOF\ncat <<X\nrm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a CRLF opener line of a quoted-delimiter heredoc", () => {
			// Quoting suppresses body expansion, not the read-layer CR strip, so
			// the delimiter word still diverges between the models.
			const input = "cat <<'EOF'\r\nbody\nEOF\ncat <<X\nrm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when the terminator line itself carries a CRLF the opener lacks", () => {
			// With an LF-terminated opener, both models read the delimiter as
			// `EOF`. The CR inside the terminator candidate is ordinary content
			// for POSIX bash, so there `EOF<CR>` never matches. The msys read
			// layer strips that CR and closes the body at that line. That
			// exposes the `cat <<X` opener, which masks `rm -rf /`. The CR sits
			// inside the region at the match, so the heredoc fails closed.
			const input = "cat <<EOF\nEOF\r\ncat <<X\nEOF\nrm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a quoted-delimiter heredoc whose terminator line carries a CRLF", () => {
			// The read-layer strip runs before quoting is considered, so the
			// quoted form diverges the same way at the terminator line.
			const input = "cat <<'EOF'\nEOF\r\ncat <<X\nEOF\nrm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed on a heredoc whose opener and terminator CR placement mirrors across models", () => {
			// The first heredoc's opener ends with CRLF, and its terminator line
			// ends with LF. The masking heredoc below shows the reversed pair.
			// Each CR sits inside its construct's opener-through-terminator
			// region, so no model-dependent close can be picked.
			const input = "cat <<EOF\r\nEOF\ncat <<X\nEOF\r\nrm -rf /\r\nX\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("treats a backslash at end of input as part of the delimiter word", () => {
			// Nothing follows the backslash to escape, so the word keeps it and
			// no body line can match: the heredoc is unterminated.
			const input = "cat <<EOF\\"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("honours a backslash-escaped closer inside a substitution in a heredoc body", () => {
			// In an unquoted body `\)` escapes the closer, so the region runs to
			// its real `)` and the payload keeps the literal `)`.
			const input = "cat <<EOF\n$(a \\) b)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "a ) b"])
		})

		it("keeps a backslash-escaped $ in a heredoc body literal", () => {
			const input = "cat <<EOF\n\\$(x)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			// The escaped $ is data, not an opener: nothing is extracted.
			expect(commands).toEqual([input])
		})

		it("keeps a bare $ prefixing a name in a heredoc body as host text", () => {
			const input = "cat <<EOF\n$HOME\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("routes a body-walk parameter expansion payload out of its frame", () => {
			const input = "cat <<EOF\n${y:-$(evil)}\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "evil"])
		})

		it("routes payloads through nested parameter expansions in a heredoc body", () => {
			const input = "cat <<EOF\n${y:-${x:-$(evil)}} $z\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			// Both expansions are expansion-active when y is unset, so `evil`
			// is evaluated independently of the allowlisted `cat`.
			expect(commands).toEqual([input, "evil"])
		})

		it("extracts a substitution inside arithmetic within a heredoc body", () => {
			const input = "cat <<EOF\n$((1+$(whoami)))\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "whoami"])
		})

		it("fails closed on unclosed arithmetic inside a heredoc body", () => {
			const input = "cat <<EOF\n$((1+2\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("arithmetic")
		})

		it("fails closed when body-walk arithmetic nesting exceeds the scan bound", () => {
			// Recursing through 65 nested arithmetic interiors would expand the
			// generated input without bound. The walk stops and fails closed.
			const body = "$((".repeat(65) + "x" + "))".repeat(65)
			const input = `cat <<EOF\n${body}\nEOF`
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("nesting-too-deep")
		})

		it("fails closed when substitution re-scan nesting exceeds the depth bound", () => {
			const input = `echo${" $(a".repeat(70)}${")".repeat(70)}`
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("nesting-too-deep")
		})

		it("restores a substitution placeholder on the crude-split fallback path", () => {
			forceShellQuoteFailure = true
			try {
				const { commands } = parseCommand("echo $(whoami) && cat <<EOF\nbody\nEOF")
				// The fallback has no payload re-scan, so the masked substitution
				// is restored inline into its host word instead of dropped, and
				// the heredoc placeholder round-trips to its raw text.
				expect(commands).toEqual(["echo whoami", "cat <<EOF\nbody\nEOF"])
				expect(commands.join("")).not.toContain("\x00")
			} finally {
				forceShellQuoteFailure = false
			}
		})
	})
})
