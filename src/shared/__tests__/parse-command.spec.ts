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

		it("parses CRLF heredocs for every delimiter form and extracts unquoted-body substitutions", () => {
			// A CR ends the delimiter word in every delimiter form, so the
			// terminator line (which ends at the CR like every other line) stays
			// matchable and a well-formed CRLF heredoc never over-fires.
			const { commands, parseError } = parseCommand("cat <<EOF\r\n$(whoami)\r\nEOF\r\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\r\n$(whoami)\r\nEOF", "whoami"])
			expect(findUnterminatedQuote("cat <<-EOF\r\n\techo C\r\n\tEOF\r\n")).toBeNull()
			expect(findUnterminatedQuote("cat <<'EOF'\r\nbody\r\nEOF\r\n")).toBeNull()
			expect(findUnterminatedQuote('cat <<"EOF"\r\nbody\r\nEOF\r\n')).toBeNull()
			expect(findUnterminatedQuote("cat <<\\EOF\r\nbody\r\nEOF\r\n")).toBeNull()
			// A delimiter quote left open does not end at the CR: bash spans the
			// newline with the quote, reads a delimiter that can never match a
			// body line, and keeps executing the opener line's tail -- so an
			// unclosed delimiter quote fails closed instead of masking the body.
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
			// <<- alone enables tab stripping; stripping unconditionally would make
			// << and <<- indistinguishable at the terminator.
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

		it("extracts both sides of a process substitution pair", () => {
			expect(parseCommand("diff <(sort a) <(sort b)").commands).toEqual(["diff", "sort a", "sort b"])
		})

		it("extracts a nested process substitution", () => {
			expect(parseCommand("cat <(a <(b))").commands).toEqual(["cat", "a", "b"])
		})

		it("closes a backtick region at the next backtick (backticks do not nest)", () => {
			// The second ` closes the first region; the third ` opens a second
			// region. Middle text between regions stays in its host word.
			expect(parseCommand("echo `a`b`c`").commands).toEqual(["echo", "a", "b", "c"])
		})

		it("masks arithmetic without emitting segments from inside it", () => {
			// $((...)) and $[...] are not command substitutions: the whole
			// arithmetic stays inside the host word and never balances as an
			// extraction delimiter.
			expect(parseCommand("echo $((1+2))").commands).toEqual(["echo $((1+2))"])
			expect(parseCommand("echo $[1+2]").commands).toEqual(["echo $[1+2]"])
		})

		it("extracts substitutions from an unquoted-delimiter heredoc body while the heredoc stays one segment", () => {
			// The shell expands $(...) inside such bodies, so the payload must
			// match the lists on its own; the heredoc itself remains opaque.
			const input = "cat <<EOF\n$(whoami)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "whoami"])
		})

		it("extracts a substitution inside a closed $((…)) as its own segment", () => {
			// bash performs command substitutions inside $((…)) before evaluating
			// the arithmetic, so the payload must match the lists on its own
			// instead of riding the allowlisted host word.
			const input = "echo $(( $(rm -rf /) ))"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "rm -rf /"])
		})

		it("extracts a substitution inside a closed $[…] as its own segment", () => {
			// `$[ … ]` is the deprecated arithmetic form and expands command
			// substitutions before evaluating, exactly like $((…)), so the
			// payload must match the lists on its own instead of riding the
			// allowlisted host word.
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
			// bash tracks bracket nesting through its arithmetic grammar while
			// the scanner ends `$[…]` at the first `]`; the truncated payload
			// leaves its `$(` unclosed, which fails closed like the shell's own
			// arithmetic syntax error for the same input — at top level and
			// inside a heredoc body.
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

		it("extracts a substitution from a heredoc body opened inside a parameter expansion", () => {
			// With x unset, bash expands the alternate word: the heredoc runs inside
			// the expansion and executes $(evil), so the body payload must surface as
			// its own segment even though the expansion host stays verbatim.
			const input = "cat ${x:-y <<EOF\n$(evil)\nEOF\n}"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "evil"])
		})

		it("keeps a quoted-delimiter heredoc body opaque inside a parameter expansion", () => {
			// A quoted delimiter suppresses body expansion, so $(evil) is literal
			// text the shell never runs; no payload segment may appear.
			const input = "cat ${x:-y <<'EOF'\n$(evil)\nEOF\n}"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})

		it("extracts a substitution after the delimiter on a heredoc opener line", () => {
			// The opener line's remainder is expanded regardless of delimiter quoting:
			// bash runs the substitution sitting between the delimiter and the newline.
			const input = "cat <<EOF $(whoami)\nbody\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "whoami"])
		})

		it("extracts opener-line substitutions for quoted and <<- delimiters too", () => {
			// Quoting suppresses expansion in the body only, never on the opener
			// line, so <<'EOF' and <<- carry the same remainder obligation as <<.
			const quoted = "cat <<'EOF' $(whoami)\nbody\nEOF"
			expect(parseCommand(quoted).commands).toEqual([quoted, "whoami"])
			const dash = "cat <<-EOF\t$(whoami)\nbody\nEOF"
			expect(parseCommand(dash).commands).toEqual([dash, "whoami"])
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

		it("reports a stray closing paren at depth zero", () => {
			const input = "echo )"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("stray-closer")
		})

		it("reports a stray closing brace at depth zero", () => {
			const input = "echo }"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("stray-closer")
		})

		it("treats a non-matching closer inside an open region as literal and still fails at end of input", () => {
			// '}' cannot close $( ...; shell-faithful: it is literal content.
			// The substitution never closes, so the command fails at EOF.
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
			// NUL is the scan's placeholder sentinel: a raw NUL glued to a
			// substitution would degrade the masked placeholder to inert text and
			// hide the payload, so the whole command is rejected before tokenizing.
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
			// Unbounded payload re-scanning burns quadratic time on generated
			// nesting and finally overflows the call stack; the cap converts deep
			// nesting to a parse error at exactly MAX_PAYLOAD_SCAN_DEPTH + 1 layers
			// while leaving anything a hand-written command could contain parseable.
			const nest = (layers: number) => "echo " + "$(a ".repeat(layers) + "x" + ")".repeat(layers)
			expect(parseCommand(nest(64)).parseError).toBeNull()
			expect(parseCommand(nest(65)).parseError?.quoteType).toBe("nesting-too-deep")
			expect(parseCommand(nest(8000)).parseError?.quoteType).toBe("nesting-too-deep")
		})

		it("fails on an unclosed substitution inside an unquoted-delimiter heredoc body", () => {
			// The terminator line is found, but the shell would never finish
			// expanding the body, so whatever follows the $( is unaccountable.
			const input = "cat <<EOF\n$(x\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		// bash itself refuses an unclosed `$((`/`$[` or a CR-only heredoc line
		// ending; each must fail closed rather than mask away text that could
		// hide a never-closed substitution behind an allowlisted first word.
		it("fails closed on an unclosed $(( hiding an embedded substitution", () => {
			const input = "echo $(( $(evil)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("arithmetic")
		})

		it("fails closed on an unclosed $(( that would swallow a later statement", () => {
			// Routing the masked remainder to the host instead would split the
			// input into two segments that can each match the allowlist; bash
			// rejects the input outright, so failing closed only costs a prompt.
			const swallowed = "echo $((1 )\nevilcmd arg"
			const { commands, parseError } = parseCommand(swallowed)
			expect(commands).toEqual([swallowed])
			expect(parseError?.quoteType).toBe("arithmetic")
			// The matched control keeps its extraction behavior unchanged.
			const control = "echo $(( $(evil) ))"
			expect(parseCommand(control).commands).toEqual([control, "evil"])
		})

		it("reports an unclosed $(( nested in a parameter expansion by its own kind", () => {
			// The error must name the arithmetic opener: letting the outer
			// region fail at end of input would report the wrong construct and
			// silently drop the arithmetic's interior payloads.
			const input = "echo ${x:-$(( $(evil) }"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("arithmetic")
		})

		it("fails closed on an unclosed $(( inside a heredoc body", () => {
			const input = "cat <<EOF\n$((1 )\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("arithmetic")
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
			// With an LF opener but CR-only line endings in the body, "EOF\r" is
			// body text to bash; accepting it as the terminator would validate a
			// heredoc the shell reports unterminated.
			const input = "cat <<EOF\nbody\rEOF\r"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("still parses a CRLF heredoc with an unquoted-body substitution", () => {
			// Requiring LF terminators keeps every CRLF case working: the CR is
			// consumed as part of the pair, so the delimiter word and terminator
			// line still match and the body payload is still extracted.
			const { commands, parseError } = parseCommand("cat <<EOF\r\n$(evil)\r\nEOF\r\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\r\n$(evil)\r\nEOF", "evil"])
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
			expect(commands[0]).toBe("echo hi")
			expect(commands[commands.length - 1]).toContain("$(x")
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
			// The opener through the blank line masks as one word; what follows
			// is a separate command bash really does execute.
			expect(commands).toEqual(["cat <<''\nbody\n", "rm -rf /"])
		})

		it('splits after the blank-line terminator of a <<"" heredoc too', () => {
			const { commands, parseError } = parseCommand('cat <<""\nbody\n\nrm -rf /')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<""\nbody\n', "rm -rf /"])
		})

		it("terminates a CRLF <<'' heredoc at its CRLF blank line", () => {
			// The empty terminator matches the blank line's CR-bounded empty text
			// through the same end-of-line bound every other delimiter uses.
			const { commands, parseError } = parseCommand("cat <<''\r\nbody\r\n\r\nrm -rf /\r\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<''\r\nbody\r", "rm -rf /"])
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
			expect(commands).toContain("whoami")
		})

		it("fails closed on a group left unclosed inside a substitution", () => {
			// bash refuses this input with "unexpected EOF"; the open frames are
			// still reported, so the cost is a prompt, never a free pass.
			const input = "echo $( (echo x"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("extracts a grouped substitution whole from an unquoted heredoc body", () => {
			// The body walk balances groups inside an expansion frame the way the
			// main scan does, and treats quotes inside the frame as shell syntax;
			// a group's closer slicing the frame here would truncate the payload.
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
		// Inside a substitution frame the shell tokenizes, so a quote there is
		// shell syntax: its region masks the frame's closer and any group test.
		// A frame-walk that reads a quoted `)` as the frame's closer slices the
		// payload and strands the bash-executed tail unaccounted for -- the
		// exact fail-open shape the main scan already gates on quote state.

		it("does not slice the frame at a quoted closer: the tail is its own segment", () => {
			// bash runs both `echo ")"` and `curl evil` from this body line, so
			// both must surface as independent segments -- never an unaccounted
			// remainder riding the frame's host word.
			const { commands, parseError } = parseCommand('cat <<EOF\n$( (echo ")") ; curl evil)\nEOF')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<EOF\n$( (echo ")") ; curl evil)\nEOF', '( echo ")" )', "curl evil"])
		})

		it("masks a single-quoted closer in the frame and extracts the tail separately", () => {
			const { commands, parseError } = parseCommand("cat <<EOF\n$( (echo ')') ; curl evil)\nEOF")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\n$( (echo ')') ; curl evil)\nEOF", "( echo ')' )", "curl evil"])
		})

		it("masks a quoted closer in the frame under CRLF line endings", () => {
			const { commands, parseError } = parseCommand('cat <<EOF\r\n$( (echo ")") ; curl evil)\r\nEOF\r\n')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<EOF\r\n$( (echo ")") ; curl evil)\r\nEOF', '( echo ")" )', "curl evil"])
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
			expect(commands).toEqual(['cat <<EOF $( (echo ")") ; curl evil)\nbody\nEOF', '( echo ")" )', "curl evil"])
		})
	})

	describe("comments inside an expansion frame in a heredoc body", () => {
		// A word-initial `#` inside a `$(…)` frame opens a comment the shell skips
		// to end of line. A frame walk that reads the `#` as ordinary text pops
		// the frame at a `)` riding inside the comment and slices the payload,
		// stranding the bash-executed continuation lines inside the opaque
		// heredoc host word — the fail-open shape the quote gating already closes.

		it("keeps a frame open across its comment and extracts the continuation tail", () => {
			// bash runs BOTH `echo ok` and `curl evil` from this body: the
			// comment's `)` never closes the frame, the real closer is the later
			// `)`, and each executed command becomes its own segment.
			const input = "cat <<EOF\n$( echo ok # )\ncurl evil)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "echo ok", "curl evil"])
		})

		it("keeps the frame open across a comment under CRLF line endings", () => {
			const { commands, parseError } = parseCommand("cat <<EOF\r\n$( echo ok # )\r\ncurl evil)\r\nEOF\r\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\r\n$( echo ok # )\r\ncurl evil)\r\nEOF", "echo ok", "curl evil"])
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
			// `#` right after `(` is at a word boundary: bash comments the line's
			// `)` and the frame closes at the later one, running `curl evil`.
			const { commands, parseError } = parseCommand("cat <<EOF\n$(# ok )\ncurl evil)\nEOF")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\n$(# ok )\ncurl evil)\nEOF", "curl evil"])
		})

		it("keeps a group's comment-blind closer from slicing the frame", () => {
			// The group's `)` rides inside the comment, so the group never closes
			// inside the frame; whatever the re-scan makes of the remainder, the
			// bash-executed `curl evil` must surface as its own segment.
			const input = "cat <<EOF\n$( (echo x # )\n) ; curl evil)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "( echo x", ")", "curl evil"])
		})

		it("fails closed when a comment swallows the frame's only closer", () => {
			// bash refuses this input (unexpected EOF looking for `)`), so the
			// open frame must fail the whole command closed, never approve it.
			const input = "cat <<EOF\n$( echo # )\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("fails closed on the same comment shape in the opener-line remainder", () => {
			// The remainder walk is clamped at the line end, so the comment
			// leaves the frame open at the boundary and the heredoc fails closed
			// while bash still refuses the input outright.
			const input = "cat <<EOF $( echo a # )\ncurl evil)\nbody\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
		})

		it("keeps a # literal inside a parameter expansion (length and trim operators)", () => {
			// `${#var}` and `${x#pat}` are operator syntax, never comments, so the
			// expansion host stays verbatim and nothing fails closed.
			expect(parseCommand("cat <<EOF\n${#var}\nEOF").commands).toEqual(["cat <<EOF\n${#var}\nEOF"])
			expect(parseCommand("cat <<EOF\n${x#pat}\nEOF").commands).toEqual(["cat <<EOF\n${x#pat}\nEOF"])
		})

		it("fails closed on the non-heredoc equivalent at top level (main-scan parity)", () => {
			// The same payload outside a body reaches a `)` at depth 0 once the
			// comment hides the closer's partner context: the scan cannot account
			// for it, so the input costs a prompt via the stray closer instead of
			// a partial decomposition.
			const input = "$( echo ok # )\ncurl evil)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("stray-closer")
		})
	})

	describe("# riding at an expansion closer continues the word", () => {
		// bash starts a comment only at a word start, and an expansion's closer
		// ends the expansion but not the surrounding word: a `#` glued directly
		// after `)`, `}`, a backtick, or `]]`-style closers is word content, so
		// a later `;` still separates a command bash executes. The tokenizer
		// comments at any unquoted `#`, so the character must travel through
		// tokenization masked; a space before the `#` leaves it at a word start,
		// where the comment behavior is the shell's.

		it("extracts the tail after a # riding at a command-substitution closer", () => {
			// bash runs `curl evil` as its own command from this line; the
			// tail's segment makes the decision a prompt, never an approval.
			const { commands, parseError } = parseCommand("echo x=$(echo ok)#;curl evil")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo x=", "echo ok", "#", "curl evil"])
		})

		it("extracts the tail after a # riding at an arithmetic closer", () => {
			// `$((…))` and the deprecated `$[…]` both end at the closer while
			// the word continues, so the tail after `;` splits on both shapes.
			expect(parseCommand("echo $((1))#;curl evil").commands).toEqual(["echo $((1))#", "curl evil"])
			expect(parseCommand("echo $[1]#;curl evil").commands).toEqual(["echo $[1]#", "curl evil"])
		})

		it("extracts the tail after a # riding at a backtick closer", () => {
			const { commands, parseError } = parseCommand("echo x=`echo ok`#;curl evil")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo x=", "echo ok", "#", "curl evil"])
		})

		it("extracts the tail after a # riding at a process-substitution closer", () => {
			// bash expands `<(…)` to a path with the word continuing past the
			// closer, so the tail after `;` really executes.
			const { commands, parseError } = parseCommand("cat <(echo ok)#;curl evil")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat", "echo ok", "#", "curl evil"])
		})

		it("extracts the tail after a # riding at a parameter-expansion closer", () => {
			expect(parseCommand("echo ${x:-a}#;curl evil").commands).toEqual(["echo ${x:-a}#", "curl evil"])
		})

		it("extracts the tail after a # riding at a closing quote", () => {
			// Quote removal still leaves the word unbroken: `echo "a"#` runs
			// `echo a#`, and the tail after `;` is a separate command.
			expect(parseCommand('echo "a"#;curl evil').commands).toEqual(['echo "a"#', "curl evil"])
		})

		it("keeps a space-preceded # after a closer a comment (tail absent)", () => {
			// With whitespace between the closer and the `#`, the `#` begins a
			// word and the shell comments the rest of the line — the tail never
			// runs and must not surface as a segment.
			const { commands, parseError } = parseCommand("echo x=$(echo ok) # comment")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo x=", "echo ok"])
		})

		it("leaves # operators inside a parameter expansion untouched", () => {
			// `${x#pat}` and `${#var}` are expansion-internal operator syntax:
			// the expansion host stays verbatim as one segment either side of
			// the closer rule, with no extra masking or splitting inside it.
			expect(parseCommand("echo ${x#pat}").commands).toEqual(["echo ${x#pat}"])
			expect(parseCommand("echo ${#var}").commands).toEqual(["echo ${#var}"])
			expect(parseCommand("echo ${x#pat};curl evil").commands).toEqual(["echo ${x#pat}", "curl evil"])
		})
	})

	describe("# riding at the end of a backslash escape pair continues the word", () => {
		// To bash an escaped character is ordinary word content, so the word
		// continues past a `\c` pair no matter what `c` is: whitespace or a
		// metacharacter in the raw text does not put a following `#` at a word
		// start. The tokenizer comments at any unquoted `#`, so this position
		// must travel through tokenization masked like the expansion-closer
		// case; a real space (not an escaped one) before the `#` leaves it at a
		// word start, where the comment behavior is the shell's.

		it("extracts the tail after a # riding at any escaped-character end", () => {
			// bash runs `curl evil` as its own command from each of these
			// lines: the escaped character keeps the word open, the `#` is
			// word content, and the `;` after it separates a second command.
			expect(parseCommand("echo a\\)#;curl evil").commands).toEqual(["echo a)#", "curl evil"])
			expect(parseCommand("echo a\\;#;curl evil").commands).toEqual(["echo a;#", "curl evil"])
			expect(parseCommand("echo a\\ #;curl evil").commands).toEqual(["echo a #", "curl evil"])
			expect(parseCommand("echo a\\|#;curl evil").commands).toEqual(["echo a|#", "curl evil"])
			expect(parseCommand("echo a\\&#;curl evil").commands).toEqual(["echo a&#", "curl evil"])
			expect(parseCommand("echo a\\<#;curl evil").commands).toEqual(["echo a<#", "curl evil"])
			expect(parseCommand("echo a\\}#;curl evil").commands).toEqual(["echo a}#", "curl evil"])
		})

		it("keeps a # after an escaped ordinary character literal (mid-word control)", () => {
			// `a\bc#c` is one word to bash — the `#` was already mid-word here
			// without the escape-end rule; the pair is pinned so a future
			// narrowing of either word-content rule shows up here.
			expect(parseCommand("echo a\\bc#c;curl evil").commands).toEqual(["echo abc#c", "curl evil"])
		})

		it("keeps an escaped # literal and never a comment", () => {
			// `\#` is an escaped character like any other: bash prints the
			// hash, and a `;` right after the pair still separates a command.
			expect(parseCommand("echo a\\#b").commands).toEqual(["echo a#b"])
			expect(parseCommand("echo a\\#;curl evil").commands).toEqual(["echo a#", "curl evil"])
		})

		it("keeps a real-space-preceded # after an escape pair a comment (tail absent)", () => {
			// `echo a\) #c` ends the word at the unescaped space, so bash
			// comments the rest of the line; the tail never runs and must not
			// surface as a segment.
			expect(parseCommand("echo a\\) #c;curl evil").commands).toEqual(["echo a)"])
		})

		it("extracts the tail after a # joined by a line continuation", () => {
			// The continuation joins `a` and `#c` into one word before the
			// shell tokenizes, so bash runs `curl evil`; the split segments
			// keep that tail accountable either way.
			expect(parseCommand("echo a\\\n#c;curl evil").commands).toEqual(["echo a", "#c", "curl evil"])
		})
	})

	describe("unclosed quote in a heredoc delimiter fails closed", () => {
		// A quote character inside the delimiter word opens a quote region that
		// bash carries across newlines until its closing quote. A word that
		// still has a region open at end of input is a delimiter no body line
		// can ever match while the opener line's tail keeps executing as
		// ordinary syntax -- exactly where a mask-to-EOF would hand bash's
		// separate commands to the allowlists unaccounted for.

		it("fails closed on the CR-delimited unclosed-quote delimiter (the approval-bypass shape)", () => {
			// bash closes the delimiter's quote on the second line and runs
			// `; rm -rf /` as its own command; masking would auto-approve it.
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
			// bash starts a quote anywhere in a word, so `<<EOF'` swallows the
			// rest of the input just like `<<'EOF` -- fixing only the leading-
			// quote forms would leave this sibling open.
			const input = "cat <<EOF'\n'; rm -rf /\nX\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("parses a closed mid-word quote as the literal concatenated terminator", () => {
			// `<<EOF'x'` is well-formed bash: after quote removal the terminator
			// is the literal word EOFx, and rejecting it would over-fire.
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
		// `>(…)` shares the frames with `<(…)` but writes where the command
		// reads: the inner command runs unconditionally while its output goes
		// to a device file, so its payload must match the lists on its own.

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
			// Quoted text is never shell syntax: bash prints it literally.
			const input = 'cat ">(evil)"'
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input])
		})
	})

	describe("body-walk and masking edge coverage", () => {
		// Regions of the scan the structural tests above reach only partially:
		// each input pins one masking or extraction branch of the body walk,
		// the opener-line remainder, and the redirection/variable scanners.

		it("extracts a backtick payload from an unquoted heredoc body", () => {
			const input = "cat <<EOF\n`echo x`\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			// Backticks do not nest, but a pair still delimits an expansion the
			// shell runs inside an unquoted body.
			expect(commands).toEqual([input, "echo x"])
		})

		it("extracts a substitution inside $[…] within a heredoc body", () => {
			// bash expands command substitutions inside `$[ … ]` (the deprecated
			// arithmetic form) before evaluating it, exactly like inside
			// `$(( … ))`, so the payload must match the lists on its own.
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

		it("terminates an empty-quoted delimiter inside a parameter expansion and leaks no placeholder", () => {
			const input = "echo ${x:-y <<''\nbody\n\n}"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			// The blank line closes the heredoc inside the expansion; the
			// expansion host keeps its verbatim text with no sentinel leakage.
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
		// The masking scanners each own an accept/reject boundary the structural
		// tests above reach only indirectly; each input pins one branch.

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
			expect(parseError).not.toBeNull()
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
			// Inside double quotes bash drops a backslash only before `$ ` " \
			// and newline; before `q` it stays part of the word, so the
			// terminator line is `a\q` and everything after it is live syntax
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

		it("strips <<- leading tabs per physical line before joining continuations", () => {
			// Tab stripping applies to each physical line, then the join builds
			// the terminator candidate, so the tab-indented `EO\` + `F` pair
			// still matches `EOF`.
			const input = "cat <<-EOF\n\tEO\\\nF\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<-EOF\n\tEO\\\nF", "rm -rf /"])
		})

		it("does not join a line ending in an even number of backslashes", () => {
			// Two trailing backslashes escape each other, so the line ends
			// literally and the body runs to the real terminator.
			const input = "cat <<EOF\nX\\\\\nrm -rf /\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\nX\\\\\nrm -rf /\nEOF"])
		})

		it("joins a continuation backslash across a CRLF line ending", () => {
			// The CR of a CRLF pair belongs to the line ending, so a lone
			// backslash before it ends the physical line just like before a
			// bare LF, and the terminator candidate joins across it.
			const input = "cat <<EOF\r\nEO\\\r\nF\r\ntouch x\r\nEOF\r\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\r\nEO\\\r\nF", "touch x", "EOF"])
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
			// Recursing through 65 nested arithmetic interiors would expand
			// generated input without bound; the walk stops and fails closed.
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
