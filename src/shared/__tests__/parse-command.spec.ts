import { parseCommand, type UnterminatedQuote } from "../parse-command"

// Toggle that lets a test force shell-quote's parse() to throw so the
// parser's tokenizer-rejection path can be exercised deterministically.
let forceShellQuoteFailure = false

vi.mock("shell-quote", async (importOriginal) => {
	const actual = await importOriginal<typeof import("shell-quote")>()
	return {
		...actual,
		parse: (...args: Parameters<typeof actual.parse>) => {
			if (forceShellQuoteFailure) {
				// The real library's "Bad substitution" errors embed slices of
				// the offending input, so the throw echoes it too — letting
				// tests prove no payload content reaches the logs.
				throw new Error(`forced parse failure: ${String(args[0])}`)
			}
			return actual.parse(...args)
		},
	}
})

const structuralError = (command: string): UnterminatedQuote | null => parseCommand(command).parseError

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

		// When shell-quote throws, the parser cannot account for the line's
		// structure, so the whole command fails closed: no decomposition (and
		// therefore no approval) can rest on a split the tokenizer rejected.
		it("fails closed instead of crude-splitting when the tokenizer throws", () => {
			forceShellQuoteFailure = true

			const input = "sh -c $'echo hi' && echo done"
			const { commands: result, parseError } = parseCommand(input)
			expect(result).toEqual([input])
			expect(parseError?.quoteType).toBe("tokenize-failure")
		})

		it("never surfaces a substitution hidden behind a tokenizer throw as a segment", () => {
			forceShellQuoteFailure = true

			// Splitting on operators would not recurse into payloads — a
			// substitution's inner text would ride its host word: a hidden
			// command could match the host's allowlist prefix and auto-approve.
			const input = "echo $(evil)"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("tokenize-failure")
		})

		// The rejected line and the tokenizer error text can both carry
		// payload content (shell-quote embeds slices of the offending input),
		// so the warning must stay content-free: a planted secret has to be
		// absent from everything logged, while the fail-closed decision stands.
		it("logs no payload content when the tokenizer throws", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			forceShellQuoteFailure = true
			try {
				const secret = "SUPERSECRET_TOKEN_9f3k"
				const input = `aws s3 ls --token ${secret} && echo done`
				const { commands, parseError } = parseCommand(input)
				// Fail-closed decision unchanged: raw input as one opaque token.
				expect(commands).toEqual([input])
				expect(parseError?.quoteType).toBe("tokenize-failure")
				// The diagnostic warning still fires, exactly once, but carries
				// neither the command line nor the error text it derived from.
				// The positive shape pin (not just absence checks) keeps this
				// from passing vacuously if a refactor hands warn an object:
				// String() would then read "[object Object]" and hide content.
				expect(warnSpy).toHaveBeenCalledTimes(1)
				expect(warnSpy.mock.calls).toEqual([
					[
						expect.stringMatching(
							/^shell-quote parse error: tokenizer rejected a \d+-character command line$/,
						),
					],
				])
				const logged = warnSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n")
				expect(logged).not.toContain(secret)
				expect(logged).not.toContain(input)
				// The returned message reaches the model and the command-status
				// UI, so it stays content-free too.
				expect(parseError?.message).not.toContain(secret)
				expect(parseError?.message).not.toContain(input)
			} finally {
				warnSpy.mockRestore()
			}
		})

		// The tokenizer's thrown error embeds slices of the rejected line, and
		// the nested substitution keeps the secret-bearing host text on the
		// masked line the tokenizer sees, so the returned message must stay a
		// fixed classification: no echo of the error, no echo of the line.
		it("returns a content-free message when a nested substitution trips the tokenizer", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			forceShellQuoteFailure = true
			try {
				const secret = "NESTED_SECRET_7x2q"
				const input = `echo $(cat $(ls)) ${secret} --flag && echo done`
				const { commands, parseError } = parseCommand(input)
				expect(commands).toEqual([input])
				expect(parseError?.quoteType).toBe("tokenize-failure")
				expect(parseError?.message).toBe("Malformed command: shell tokenizer rejected the command.")
				const logged = warnSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n")
				expect(logged).not.toContain(secret)
				expect(parseError?.message).not.toContain(secret)
			} finally {
				warnSpy.mockRestore()
			}
		})

		it("does not warn when the tokenizer succeeds", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
			try {
				const { commands, parseError } = parseCommand("git status && echo done")
				expect(parseError).toBeNull()
				expect(commands).toEqual(["git status", "echo done"])
				expect(warnSpy).not.toHaveBeenCalled()
			} finally {
				warnSpy.mockRestore()
			}
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
			expect(structuralError("cat <<-EOF\r\n\techo C\r\n\tEOF\r\n")?.quoteType).toBe("heredoc")
			expect(structuralError("cat <<'EOF'\r\nbody\r\nEOF\r\n")?.quoteType).toBe("heredoc")
			expect(structuralError('cat <<"EOF"\r\nbody\r\nEOF\r\n')?.quoteType).toBe("heredoc")
			expect(structuralError("cat <<\\EOF\r\nbody\r\nEOF\r\n")?.quoteType).toBe("heredoc")
			// A delimiter quote left open does not end at the CR. bash spans
			// the newline with the quote. It reads a delimiter that can never
			// match a body line, and it keeps executing the opener line's tail.
			// An unclosed delimiter quote therefore fails closed instead of
			// masking the body.
			expect(structuralError("cat <<'EOF\r\nbody\r\nEOF\r\n")?.quoteType).toBe("heredoc")
			expect(structuralError('cat <<"EOF\r\nbody\r\nEOF\r\n')?.quoteType).toBe("heredoc")
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
			expect(structuralError(`sh <<< "echo hello"`)).toBeNull()
			expect(structuralError("sh <<< 'echo hello'")).toBeNull()
		})

		it("scans a herestring inside a command substitution as one operator", () => {
			// The frame scan must consume `<<<` whole. Stopping at the second
			// `<` would hit the frame's heredoc guard and open a heredoc on
			// `<<foo)`, so this valid input would fail closed as an unterminated
			// heredoc instead of decomposing.
			const { commands, parseError } = parseCommand("echo $(cat <<<foo)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat <<< foo"])
		})

		it("treats an input redirection glued before a herestring as two operators", () => {
			// A herestring takes three consecutive `<`. Here `<a` is an input
			// redirection, so the scan must not consume it as `<<<`; checking
			// fewer than three positions would misread the next `<` as a
			// heredoc opener and fail this valid line closed.
			const { commands, parseError } = parseCommand("echo $(cat <a<<<foo)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "cat < a <<< foo"])
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
		// The scan's placeholders are a kind letter plus an index wrapped in NUL
		// sentinels, and an input containing NUL is rejected before any masking,
		// so literal text cannot collide with a placeholder. `__NAME_0__`-style
		// text is inert word content; this round-trip pins that.
		it("round-trips a command that contains every internal placeholder token", () => {
			const input =
				"echo __QUOTE_0__ __SQUOTE_0__ __REDIR_0__ __ARITH_0__ __PARAM_0__ __VAR_0__ __SUBSH_0__ __TOPLEVEL_QUOTE_0__"
			expect(parseCommand(input).commands).toEqual([input])
		})
	})

	describe("structural error reporting", () => {
		it("returns null for balanced and quote-free input", () => {
			expect(structuralError("git status")).toBeNull()
			expect(structuralError("echo 'hello'")).toBeNull()
			expect(structuralError('echo "hello"')).toBeNull()
			expect(structuralError("sh -c 'echo a\necho b'")).toBeNull()
			expect(structuralError("sh -c $'echo a\necho b'")).toBeNull()
		})

		it("detects an unterminated single quote and reports its opening index", () => {
			expect(structuralError("echo 'hello")).toEqual(
				expect.objectContaining({ quoteType: "posix-single", openIndex: 5 }),
			)
		})

		it("detects an unterminated double quote and reports its opening index", () => {
			expect(structuralError('echo "hello')).toEqual(
				expect.objectContaining({ quoteType: "double", openIndex: 5 }),
			)
		})

		it("reports ansi-c style and the $ position for an unterminated ANSI-C quote", () => {
			expect(structuralError("echo $'hello")).toEqual(
				expect.objectContaining({ quoteType: "ansi-c", openIndex: 5 }),
			)
		})

		it("treats a backslash-escaped quote outside a string as literal", () => {
			// `echo \'` is a literal quote, not an unterminated region.
			expect(structuralError("echo \\'")).toBeNull()
			expect(structuralError('echo \\"')).toBeNull()
		})

		it("ignores a quote that appears inside a comment", () => {
			expect(structuralError("echo hi # it's fine")).toBeNull()
		})

		it("ignores an apostrophe inside a # comment that follows a closed quoted argument", () => {
			// A well-formed quoted argument followed by a comment whose content
			// contains a quote character. The comment apostrophe must not open a
			// new region.
			expect(structuralError("echo 'hello' # it's a comment")).toBeNull()
			expect(structuralError('echo "hello" # it\'s a comment')).toBeNull()
		})

		it("treats # attached to a word as an ordinary character", () => {
			expect(structuralError("echo foo#'bar'")).toBeNull()
			expect(structuralError("echo foo#'bar")).toEqual(
				expect.objectContaining({ quoteType: "posix-single", openIndex: 9 }),
			)
		})

		it("does not let an apostrophe inside double quotes open a region", () => {
			expect(structuralError(`echo "don't"`)).toBeNull()
		})

		it("does not let a double quote inside single quotes open a region", () => {
			expect(structuralError(`echo 'a " b'`)).toBeNull()
		})

		it("honors backslash escapes inside double quotes", () => {
			// The escaped quote does not close the region; the final quote does.
			expect(structuralError('echo "a \\" b"')).toBeNull()
			expect(structuralError('echo "a \\"')?.quoteType).toBe("double")
		})

		it("honors backslash escapes inside ANSI-C quotes", () => {
			expect(structuralError("echo $'it\\'s ok'")).toBeNull()
			expect(structuralError("echo $'it\\'s ok")?.quoteType).toBe("ansi-c")
		})

		it("treats POSIX single quotes as opaque to backslashes", () => {
			// Inside a POSIX single quote a backslash is literal, so the quote
			// closes at the next apostrophe regardless of any preceding backslash.
			expect(structuralError("echo 'a\\'")).toBeNull()
		})

		it("reports locale style and the $ position for an unterminated locale quote", () => {
			expect(structuralError('echo $"hello')).toEqual(
				expect.objectContaining({ quoteType: "locale", openIndex: 5 }),
			)
		})

		it("returns null for a balanced locale-quoted string", () => {
			expect(structuralError('echo $"hello world"')).toBeNull()
		})

		it("returns null for a balanced <<- heredoc with an indented terminator", () => {
			// The <<- form alone enables tab stripping. Unconditional stripping
			// would make << and <<- indistinguishable at the terminator.
			expect(structuralError("sh <<-EOF\n\techo hello\n\tEOF")).toBeNull()
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
			// bash's legacy `$[…]` reader ends the expression at an unquoted
			// `]` even inside an open `$(`, so this input's `$(` never closes.
			// bash refuses it with an unexpected-EOF error, and the interior
			// walk reports the same shape. The quoted-`]` class the same reader
			// accepts parses instead; see the next test.
			const input = "echo $[1+$(echo ])]"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("command-substitution")
			const body = "cat <<EOF\n$[1+$(echo ])]\nEOF"
			const bodyResult = parseCommand(body)
			expect(bodyResult.commands).toEqual([body])
			expect(bodyResult.parseError?.quoteType).toBe("command-substitution")
			// The accepted class: bash closes the expression at the final `]`
			// because the earlier one sits inside single quotes, then inside
			// `$(`. The payload is extracted and the host stays parseable.
			const accepted = parseCommand("echo $[1+$(printf '2]' | cut -c1)]")
			expect(accepted.parseError).toBeNull()
			expect(accepted.commands).toEqual(["echo $[1+$(printf '2]' | cut -c1)]", "printf '2]'", "cut -c1"])
		})

		it("closes $[…] at the first ] outside quotes and substitutions", () => {
			// A subscript's `[` opens a bracket the shell closes last-open-
			// first, so the expression ends at the depth-zero `]`, not the
			// first `]`. Quote and substitution interiors are inert to the
			// closer scan.
			const subscript = parseCommand("a=(5 7)\necho $[a[0]+1]")
			expect(subscript.parseError).toBeNull()
			expect(subscript.commands).toEqual(["a= ( 5 7 )", "echo $[a[0]+1]"])
			// A double-quoted `]` is equally inert: bash runs this input.
			const dq = parseCommand('echo $[1+$(printf "2]" | cut -c1)]')
			expect(dq.parseError).toBeNull()
			expect(dq.commands).toEqual(['echo $[1+$(printf "2]" | cut -c1)]', 'printf "2]"', "cut -c1"])
			// A substitution may open a subscript's bracket too: the `]` that
			// closes the subscript is the one balancing its `[`.
			const nested = parseCommand("a=(5 7)\necho $[a[$(echo 0)]+1]")
			expect(nested.parseError).toBeNull()
			expect(nested.commands).toEqual(["a= ( 5 7 )", "echo $[a[$(echo 0)]+1]", "echo 0"])
			// Unclosed forms still fail closed: no depth-zero `]` arrives.
			expect(structuralError("echo $[1+2")?.quoteType).toBe("arithmetic")
		})

		it("fails closed when a region inside an arithmetic expression never closes", () => {
			// An opener inside `$((…))`/`$[…]` that never closes is bash's own
			// unclosed-delimiter error: the shell reads every later byte inside
			// it and runs nothing, so the expression fails closed whatever the
			// masked tail looks like to a depth count. The closer scan masks
			// the tail from that reading on instead of re-walking it per byte;
			// these rows pin the fail-closed set and the accept rows pin that
			// a scan which masks too much (dropping a real closer's effect on
			// the interior walk) cannot pass.
			expect(structuralError("echo $(( $(evil)")?.quoteType).toBe("arithmetic")
			expect(structuralError("echo $(( `x")?.quoteType).toBe("arithmetic")
			expect(structuralError("echo $[1 ${")?.quoteType).toBe("arithmetic")
			expect(structuralError("echo $(( $(f 'x) ))")?.quoteType).toBe("command-substitution")
			// The interior walk can only report a frame-kind opener that never
			// closes; it reads a top-level quote inside the expression as
			// literal text, so the closer scan itself must fail an unclosed
			// quote closed. bash refuses each of these inputs too.
			expect(structuralError("echo $(( 'x ))")?.quoteType).toBe("arithmetic")
			expect(structuralError('echo $(( "x ))')?.quoteType).toBe("arithmetic")
			expect(structuralError("echo $[1 'x ]")?.quoteType).toBe("arithmetic")
			// An unclosed frame region stays on the masked path: plain counting
			// closes the expression and the interior walk names the frame, so
			// the error kind is the opener's, never "arithmetic". bash refuses
			// each of these inputs too.
			expect(structuralError("echo $[ $(f ]")?.quoteType).toBe("command-substitution")
			expect(structuralError("echo $[ ${f ]")?.quoteType).toBe("parameter-expansion")
			expect(structuralError("echo $[ `f ]")?.quoteType).toBe("backtick")
			expect(structuralError("echo $(( ${f ))")?.quoteType).toBe("parameter-expansion")
			const closed = parseCommand("echo $(( 1 + $(printf 2) ))")
			expect(closed.parseError).toBeNull()
			expect(closed.commands).toEqual(["echo $(( 1 + $(printf 2) ))", "printf 2"])
			const quoted = parseCommand("echo $(( $(printf ')') + 1 ))")
			expect(quoted.parseError).toBeNull()
			expect(quoted.commands).toEqual(["echo $(( $(printf ')') + 1 ))", "printf ')'"])
		})

		it("keeps the arithmetic closer scan linear past an unclosed region", () => {
			// One unclosed region inside `$((` makes every later byte a
			// non-opener for the shell: the closer scan masks that tail and
			// plain-counts instead of re-walking it per byte. The fail-closed
			// set is pinned by the block above; this pin bounds the cost — the
			// per-byte re-walk shape measures ~410 ms at this size vs ~1 ms
			// linear, so the ceiling cannot fire on the shipped scan and does
			// fire the moment the unclosed-region sentinel stops ending the
			// region walk.
			const input = "echo $(( " + "${".repeat(8000)
			expect(parseCommand(input).parseError?.quoteType).toBe("arithmetic")
			let best = Number.POSITIVE_INFINITY
			for (let run = 0; run < 3; run++) {
				const t0 = process.hrtime.bigint()
				parseCommand(input)
				best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6)
			}
			expect(best).toBeLessThan(100)
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

		it("extracts a substitution from a parameter expansion on the opener line", () => {
			// bash expands `$(zap x)` inside `${x:-$(zap x)}` on the opener line
			// and runs it. The remainder walk masks the expansion to a
			// placeholder the tokenizer can read, so the inner command still
			// surfaces as its own segment and the host keeps its verbatim text.
			const { commands, parseError } = parseCommand("cat <<E ${x:-$(zap x)}\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE ${x:-$(zap x)}", "zap x"])
		})

		it("restores a plain parameter expansion on the opener line verbatim", () => {
			// A `${…}` without substitutions costs nothing extra: the masked
			// placeholder restores to one segment carrying the expansion text,
			// exactly like a top-level parameter expansion.
			const { commands, parseError } = parseCommand("cat <<E ${z}\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE ${z}"])
		})

		it("keeps a nested parameter expansion on the opener line inside its region", () => {
			// The inner `${b}` closer must not end the outer `${a:-…}` region:
			// the `;` lives inside the expansion, never reaches bash as an
			// operator, and the whole word stays in the one host segment. The
			// mask onset belongs to the outermost region only; an onset set at
			// the nested region drops the outer region's opener bytes from the
			// restored host text, which this exact-text pin catches.
			const { commands, parseError } = parseCommand("cat <<E ${a:-${b};zap x}\nb\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nb\nE ${a:-${b};zap x}"])
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

		it("splits a |& pipe operator into its own segment", () => {
			// bash pipes stdout and stderr of `echo a` into `zap x`: `|&` is one
			// operator token, so the right-hand command reaches its own segment
			// instead of riding the left-hand word's allowlist match.
			const { commands, parseError } = parseCommand("echo a |& zap x")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo a", "zap x"])
			// A delimiter word glued to `|&` ends at the `|` like the other
			// operators, so the terminator still matches and the tail splits.
			const glued = parseCommand("cat <<EOF|&grep y\nhi\nEOF")
			expect(glued.parseError).toBeNull()
			expect(glued.commands).toEqual(["cat <<EOF\nhi\nEOF", "grep y"])
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

		it("parses an opener comment containing an apostrophe", () => {
			// bash discards a word-start comment before scanning for quotes, so
			// the apostrophe in the comment text never opens a region: the
			// opener line is `cat <<EOF` plus a discarded comment.
			const { commands, parseError } = parseCommand("cat <<EOF # don't\ndon't\nEOF")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<EOF\ndon't\nEOF"])
			// A comment glued to the delimiter discards the same way; the onset
			// must stop AT the `#` so the comment's leading quote is never read
			// as a residual quote pairing with the body's apostrophe.
			const glued = parseCommand("cat <<E #'don't\nbody'\nE")
			expect(glued.parseError).toBeNull()
			expect(glued.commands).toEqual(["cat <<E\nbody'\nE"])
		})

		it("parses an opener comment whose apostrophe precedes a body apostrophe", () => {
			// The same discarded comment on a longer opener: the quote-state
			// check may only read the live prefix before the comment onset, or
			// the comment's apostrophe pairs with the body's and fails an
			// opener bash runs.
			const { commands, parseError } = parseCommand("git commit -F - <<EOF # don't\nfix: it's\nEOF")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["git commit -F - <<EOF\nfix: it's\nEOF"])
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

		it("fails closed when a remainder quote spans the newline into the body", () => {
			// bash carries the `'` open across the newline, closes it at `b'`,
			// and runs `; zap x` as live syntax. The remainder cut stops at the
			// newline, so the masked body never accounts for those bytes: the
			// heredoc fails closed instead of approving a hidden command.
			const input = "cat <<E 'a\nb'; zap x\nhi\nE"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when a double-quoted remainder spans the newline into the body", () => {
			// The guard is quote-kind agnostic: bash carries `"` across the
			// newline exactly like `'`, closes it on a later line, and runs the
			// bytes after its closer as live syntax.
			const input = 'cat <<E "a\nb"; zap x\nhi\nE'
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("accepts an opener quote that never closes again", () => {
			// A quote with no later closer is bash's own syntax error: bash
			// reads one unterminated word and executes nothing, so nothing is
			// hidden and the opener stays parseable.
			const { commands, parseError } = parseCommand("cat <<E 'a\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE a"])
		})

		it("fails closed when a quote opened before an opener comment spans the newline", () => {
			// The comment skip starts only at a word-start `#`: the `'` before
			// it is live syntax bash carries across the newline, closing at `b'`
			// so `; zap x` runs. Skipping the comment tail must not discard the
			// quote state opened before it.
			const input = "cat <<E 'a # b\nc'; zap x\nhi\nE"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
			// Quoting the word around the `#` restores the accept side: the
			// comment onset must respect quoting, so `# ` inside `'a # b'` is
			// word content, the live `'` closes on the body's `b'`, and the
			// tail after it still splits into its own segment.
			const quoted = parseCommand("cat <<E 'a # b'; zap x\nb'ody\nE")
			expect(quoted.parseError).toBeNull()
			expect(quoted.commands).toEqual(["cat <<E\nb'ody\nE a # b", "zap x"])
			// The same shape with `"`: the residual quote is double-quoted, and
			// the onset scan must track that quoting kind too.
			const dq = parseCommand('cat <<E "a # b"; zap x\nb"ody\nE')
			expect(dq.parseError).toBeNull()
			expect(dq.commands).toEqual(['cat <<E\nb"ody\nE a # b', "zap x"])
		})

		it("keeps a double-quoted opener region open across an apostrophe before a #", () => {
			// bash closes a `"` region only at another `"`: the apostrophe is
			// word content, so the `#` stays inside the region, never opens a
			// comment, and the substitution after it stays live syntax that
			// reaches its own segment. An onset scan that closes the region on
			// the other quote kind sees a comment at the `#` and drops the tail.
			const { commands, parseError } = parseCommand('cat <<E "a\' # $(zap x)"\nbody\nE')
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE a' # $(zap x)", "zap x"])
			// The same shape carrying a denied head: the denylist can only reject
			// what the decomposition surfaces, so the substitution after the
			// in-region `#` must still split into its own segment.
			const denied = parseCommand('cat <<E "a\' # $(rm x)"\nbody\nE')
			expect(denied.parseError).toBeNull()
			expect(denied.commands).toEqual(["cat <<E\nbody\nE a' # $(rm x)", "rm x"])
			// The reverse kind pair pins the mask from the other side: a
			// balanced `'…'` span on the remainder undergoes bash's quote
			// removal, so the bytes inside it never parse as syntax. The `#`
			// there never tests as a comment onset either, and neither the `#`
			// nor the substitution inside the span produces a segment: bash
			// opens one file named by the whole word.
			const sq = parseCommand("cat <<E 'a\" # $(zap x)'\nbody\nE")
			expect(sq.parseError).toBeNull()
			expect(sq.commands).toEqual(['cat <<E\nbody\nE a" # $(zap x)'])
		})

		it("scans the body of a second heredoc opener on the same line", () => {
			// bash opens a heredoc for every redirect on the opener line and
			// expands each body: a heredoc body carries no comments, so the
			// `# $(evil)` line in the second body executes. The scan collects
			// the chained opener on the opener line and searches its body
			// after the outer one, so `evil` surfaces as its own segment and
			// no allowlist decision can let the command through clean. Without
			// the collection the body's bytes stay host text and nothing
			// surfaces.
			const { commands, parseError } = parseCommand("cat <<A <<cat\nA\n# $(evil)\ncat\n")
			expect(parseError).toBeNull()
			// One H placeholder spans the opener through the last chained
			// terminator; the opener-line remainder (chained `<<` token and
			// delimiter word included) stays live host text after it.
			expect(commands).toEqual(["cat <<A\nA\n# $(evil)\ncat << cat", "evil"])
			// A `<<<` herestring is one operator, never a chained opener: the
			// walk consumes all three bytes and the word passes to the host.
			expect(parseCommand("cat <<E <<<str\nbody\nE").commands).toEqual(["cat <<E\nbody\nE <<< str"])
			// Fail-closed controls: a chained body that never reaches its
			// terminator hides everything after it, so the whole heredoc fails
			// closed like any other unclosed construct — bash's own read layer
			// reports the missing terminator for both shapes.
			const unclosed = parseCommand("cat <<A <<B\nA\n$(x)\n")
			expect(unclosed.commands).toEqual(["cat <<A <<B\nA\n$(x)\n"])
			expect(unclosed.parseError?.quoteType).toBe("heredoc")
			const glued = parseCommand("cat <<E x<<y\nbody\nE")
			expect(glued.commands).toEqual(["cat <<E x<<y\nbody\nE"])
			expect(glued.parseError?.quoteType).toBe("heredoc")
			// Frame-context pin: the same opener inside `$(…)` re-scan runs the
			// emission at top level, so the frame branch's heredoc route chains
			// through the identical path.
			expect(parseCommand("echo $(cat <<A <<cat\nA\n# $(evil)\ncat\n)").commands).toEqual([
				"echo",
				"cat <<A\nA\n# $(evil)\ncat << cat",
				"evil",
			])
		})

		it("extracts a substitution from a chained opener's body", () => {
			// An unquoted chained body is expansion-active exactly like the
			// first body: the substitution inside it must reach its own
			// segment instead of hiding in the outer host word.
			const { commands, parseError } = parseCommand("cat <<A <<B\nA\n$(mid)\nB\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<A\nA\n$(mid)\nB << B", "mid"])
		})

		it("keeps a quoted chained delimiter's body inert", () => {
			// A quoted delimiter suppresses expansion in its own body: the
			// `$(quiet)` line is literal data, so no payload surfaces and the
			// construct still parses clean.
			const { commands, parseError } = parseCommand("cat <<A <<'Q'\nA\n$(quiet)\nQ\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<A\nA\n$(quiet)\nQ << Q"])
		})

		it("consumes three chained openers in body order", () => {
			// Every chained body starts on the line after the previous
			// construct's terminator, in bash's sequential read order, and
			// only the innermost body carries the substitution. The single
			// masked region spans the opener through the last terminator.
			const { commands, parseError } = parseCommand("cat <<A <<B <<C\nA\nB\n$(deep)\nC\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<A\nA\nB\n$(deep)\nC << B << C", "deep"])
		})

		it("fails closed when the chained body runs past the end of input (sequential stdin cursor)", () => {
			// bash reads chained bodies sequentially: B's body starts after
			// A's terminator line, so the `# $(evil) B` line is B's unterminated
			// body and bash expands the substitution there anyway (its warning
			// only reports the missing terminator). A parser that anchored B's
			// body at the line after the shared opener line found the stray `B`
			// inside A's body instead and returned the `#` line to the main
			// scan, where it reads as a top-level comment — the executed bytes
			// hid. bash's executed set for this input carries `evil`.
			const { commands, parseError } = parseCommand("cat <<A <<B\nB\nA\n# $(evil) B\n")
			expect(parseError?.quoteType).toBe("heredoc")
			expect(commands).toEqual(["cat <<A <<B\nB\nA\n# $(evil) B\n"])
		})

		it("reads chained bodies in bash's sequential order when a chained terminator lands inside the outer body", () => {
			// A's body runs to the `A` line; B's body starts on the next line
			// and holds `$(two)`. bash expands both substitutions; a body
			// anchored at the shared opener line would take B's body from the
			// `B` line and lose the `$(two)` byte range.
			const { commands, parseError } = parseCommand("cat <<A <<B\n$(one)\nA\n$(two)\nB\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<A\n$(one)\nA\n$(two)\nB << B", "one", "two"])
		})

		it("fails closed beyond MAX_PAYLOAD_SCAN_DEPTH chained openers on one line", () => {
			// The collector cap rides the scan's existing generated-input bound.
			// 64 chained openers (plus the outer one) parse; the 65th chained
			// opener fails the construct closed before any body search runs, so
			// the accept half pins the boundary from both sides. The equality
			// pins hold the resolved host text exactly: dropping a chained
			// token or leaking a placeholder changes the string, not just the
			// segment count.
			const chain = (count: number): string => {
				const delims = Array.from({ length: count }, (_, k) => `d${k}`)
				return "cat " + delims.map((d) => `<<${d}`).join(" ") + "\n" + delims.map((d) => `${d}\n`).join("")
			}
			const delims = Array.from({ length: 65 }, (_, k) => `d${k}`)
			const at = parseCommand(chain(65))
			expect(at.parseError).toBeNull()
			expect(at.commands).toEqual([
				"cat <<d0\n" +
					delims.join("\n") +
					delims
						.slice(1)
						.map((d) => ` << ${d}`)
						.join(""),
			])
			const over = parseCommand(chain(66))
			expect(over.parseError?.quoteType).toBe("heredoc")
			// A fail-closed construct returns the raw input verbatim as its one
			// host word: no masking, no placeholder, no dropped bytes.
			expect(over.commands).toEqual([chain(66)])
			// Stack safety: a generated chain far beyond the cap fails closed
			// at the collector, never through recursion.
			const huge = parseCommand(chain(8000))
			expect(huge.parseError?.quoteType).toBe("heredoc")
			expect(huge.commands).toEqual([chain(8000)])
		})

		it("starts a frame comment after every word-ending metacharacter", () => {
			// The frame-comment word-boundary set is the default $IFS blanks
			// plus every metacharacter that ends a word. Each member row gets
			// the same shape: a `#` glued after the member comments out the
			// `$(zap y)` payload, exactly as bash discards the comment bytes.
			// The grouped-frame forms pin `(` and `)`, where a bare paren
			// would otherwise be read as group bookkeeping. The glued control
			// pins that a `#` after an ordinary word character stays word text
			// and still yields the payload.
			const rows = [
				{ name: "semicolon", input: "echo $(x;#$(zap y)\n)", commands: ["echo", "x"], error: null },
				// Decoy-closer rows for `&`, `(` and `)`: the comment swallows a
				// `)` that would otherwise close the frame, so bash rejects the
				// whole input and the scan must fail the frame closed too.
				// Dropping the member from the boundary class instead closes the
				// frame at the decoy and accepts bash-invalid input clean.
				{
					name: "ampersand",
					input: "echo $(x&#) $(evil)",
					commands: ["echo $(x&#) $(evil)"],
					error: "command-substitution",
				},
				{ name: "pipe", input: "echo $(x|#$(zap y)\n)", commands: ["echo", "x"], error: null },
				{ name: "less-than", input: "echo $(x<#$(zap y)\n)", commands: ["echo", "x <"], error: null },
				{ name: "greater-than", input: "echo $(x>#$(zap y)\n)", commands: ["echo", "x >"], error: null },
				{
					name: "open-paren",
					input: "echo $(x(#) $(evil)",
					commands: ["echo $(x(#) $(evil)"],
					error: "command-substitution",
				},
				{
					name: "open-paren-process-sub",
					input: "echo $(x>(#$(zap y)\n)",
					commands: ["echo $(x>(#$(zap y)\n)"],
					error: "command-substitution",
				},
				{
					name: "close-paren",
					input: "echo $( (x)#) end",
					commands: ["echo $( (x)#) end"],
					error: "command-substitution",
				},
				// Glued control: mid-word `#` keeps the payload live.
				{ name: "glued-word", input: "echo $(x#a$(zap y)\n)", commands: ["echo", "x#a", "zap y"], error: null },
			]
			const observed = rows.map(({ name, input }) => {
				const result = parseCommand(input)
				return { name, commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ name, input: _input, ...expected }) => ({ name, ...expected })))
		})

		it("keeps a # after a nested substitution's closer word-internal inside a frame", () => {
			// A closer that pops a nested frame inside a frame ends the
			// expansion, not the surrounding word: bash prints `a#b` for this
			// input, so the frame-comment rule must skip a `#` directly after
			// such a closer. Only a group-paren closer stays a word boundary
			// (the table above pins the group row).
			const { commands, parseError } = parseCommand("echo $(echo $(echo a)#b)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "echo", "echo a", "#b"])
		})

		it("keeps a # after a nested substitution's closer word-internal in a heredoc body", () => {
			// The body walk's frame-comment rule carries the same closer
			// tracker: inside a body substitution the `#` after a nested
			// frame's closer continues the word, and bash expands the body's
			// substitution to `a#b` instead of losing the frame closer to a
			// comment.
			const { commands, parseError } = parseCommand("cat <<E\n$(echo $(echo a)#b)\nE\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\n$(echo $(echo a)#b)\nE", "echo", "echo a", "#b"])
		})

		it("keeps a # after an escaped blank word-internal inside a frame", () => {
			// A `\c` escape pair inside a frame leaves the escaped character
			// as word content. When `c` is a blank, the raw blank before a
			// following `#` is not a real word boundary: bash prints `a #b`
			// for this input, so the frame-comment rule must skip a `#`
			// directly after the pair, as the top-level rule already does.
			// The frame never closes if the comment is honored, and the
			// fail-closed rule refuses a command bash runs. The control row
			// pins the exact boundary: after the escaped blank, a real blank
			// is one, and the `#` it exposes starts the comment bash starts —
			// bash loses the frame closer to that comment too and fails.
			const rows = [
				{
					input: "echo $(printf %s a\\ #b)",
					commands: ["echo", "printf %s a #b"],
					error: null,
				},
				{
					input: "echo $(a\\  #b)",
					commands: ["echo $(a\\  #b)"],
					error: "command-substitution",
				},
			]
			const observed = rows.map(({ input }) => {
				const result = parseCommand(input)
				return { commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ input: _input, ...expected }) => expected))
		})

		it("keeps a # after an escaped blank word-internal in a heredoc body", () => {
			// The body walk carries the same escape tracker as the main scan:
			// the body's `$(…)` frame closes and bash prints `echo a #b`, so
			// the `#` after the frame's escaped blank continues the word. The
			// control row keeps the body walk's boundary exact: with a real
			// blank before the `#` the comment starts, bash loses the frame
			// closer while expanding the body, and the region fails closed.
			const rows = [
				{
					input: "cat <<EOF\necho $(printf %s a\\ #b)\nEOF",
					commands: ["cat <<EOF\necho $(printf %s a\\ #b)\nEOF", "printf %s a #b"],
					error: null,
				},
				{
					input: "cat <<EOF\necho $(a\\  #b)\nEOF",
					commands: ["cat <<EOF\necho $(a\\  #b)\nEOF"],
					error: "command-substitution",
				},
			]
			const observed = rows.map(({ input }) => {
				const result = parseCommand(input)
				return { commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ input: _input, ...expected }) => expected))
		})

		it("keeps a # after an escaped blank word-internal in a process substitution", () => {
			// The process-substitution frame takes the same exclusion: bash
			// runs the diff (the exit status is irrelevant to parsing) with
			// the escaped blank keeping the `#` inside the frame's word.
			const { commands, parseError } = parseCommand("diff <(printf %s a\\ #b) /dev/null")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["diff", "printf %s a #b", "/dev/null"])
		})

		it("starts a # comment after a real blank inside a process substitution", () => {
			// The control for the escaped-blank pin above: with a real blank
			// before the `#` the frame-comment rule must fire. The comment
			// runs to end of line, so bash loses the frame's closer to it and
			// refuses the input with an unexpected-EOF error; the scan loses
			// the closer to the same comment and fails the frame closed.
			const input = "diff <(printf %s x #y) /dev/null"
			expect(structuralError(input)?.quoteType).toBe("process-substitution")
			expect(parseCommand(input).commands).toEqual([input])
		})

		it("keeps every executed command visible when a continuation comment swallows the frame closer and a quote", () => {
			// The shell removes a backslash-newline pair before tokenizing, so
			// the `#` that follows one sits at a real word boundary and starts
			// the comment bash starts: it runs to end of line, swallowing the
			// `)` and the opening `'`. The quote never opens. The frame stays
			// open past the swallowed closer, closes at the next `)` — the one
			// inside `>&2` — and the payload re-scan surfaces each executed
			// command as its own segment. The `#` after that closer is a host
			// comment again, so the trailing `'` never opens either. bash runs
			// `echo` and `printf MARKER` inside the substitution here; both
			// surface to the command lists, so no executed byte rides a mask.
			const input = "echo $(echo \\\n#x ) '\nprintf MARKER >&2) #'"
			const { commands, parseError } = parseCommand(input)
			expect(parseError?.quoteType ?? null).toBeNull()
			expect(commands).toEqual(["echo", "echo ", "printf MARKER >&2"])
		})

		it("extracts payloads when a continuation comment swallows the heredoc opener", () => {
			// Same removal rule: the comment at the `#` swallows `) <<E` to end
			// of line, so no heredoc opens, the body lines stay inside the
			// substitution, and the shell comments bash comments. The scan
			// reaches the `)` on its own line, closes the frame, and the
			// payload re-scan runs the host rules: there the comment fires
			// again, `zap x` surfaces as its own segment, and the `E` after
			// the frame closer is an ordinary trailing word. bash runs
			// `zap x` inside the substitution here, so every executed byte
			// the shell expands stays visible to the command lists instead
			// of riding a mask. Where the comment line ends the frame's last
			// command instead, the frame closes at `)` and the payload after
			// the comment line is extracted on its own segment; the comment
			// bytes themselves are shell-discarded, never a segment.
			const rows = [
				{
					input: "echo $(a \\\n#b) <<E\nzap x\n)\nE",
					commands: ["echo", "a ", "zap x", "E"],
					error: null,
				},
				{
					input: "echo $(a \\\n#b\nrm -rf /)",
					commands: ["echo", "a ", "rm -rf /"],
					error: null,
				},
			]
			const observed = rows.map(({ input }) => {
				const result = parseCommand(input)
				return { commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ input: _input, ...expected }) => expected))
		})

		it("keeps a glued backslash-newline-hash sequence word text inside a frame", () => {
			// The removal leaves `a` directly before the `#`: mid-word, never a
			// comment. bash runs the word `a#b` here, so the boundary walk must
			// land on the `a`, not on the raw newline, and the frame must close
			// at its `)` like any word-text frame.
			const rows = [
				{
					input: "echo $(a\\\n#b)",
					commands: ["echo", "a", "#b"],
					error: null,
				},
				{
					input: "echo $(printf %s a\\\n#b)",
					commands: ["echo", "printf %s a", "#b"],
					error: null,
				},
			]
			const observed = rows.map(({ input }) => {
				const result = parseCommand(input)
				return { commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ input: _input, ...expected }) => expected))
		})

		it("tests the frame-comment boundary against the byte the shell sees", () => {
			// The boundary walk pairs a backslash run off left to right, like
			// the shell's tokenizer. An even run leaves the newline standing as
			// a real line break, so a `#` after it is word-initial: the comment
			// fires, swallows the frame closer and the opener remainder, and
			// the payload inside the frame is extracted — the same reading as
			// bash, which runs that payload inside the substitution. An odd run
			// longer than one pairs down to an escaped backslash before the
			// `#`; the walk here steps over the whole run, which reads the
			// still-escaped `#` as word-initial and comments it: the frame
			// stays open and the input is refused. bash runs the word in that
			// shape, so the divergence is a refusal of input bash accepts — the
			// safe direction, never the reverse. The end-of-frame pin walks
			// over the frame opener to start-of-input, a boundary like any
			// blank: bash loses the closer to the same comment and rejects the
			// input with an unexpected-EOF error too. A backslash followed by
			// CR is an escaped CR, not a continuation: the LF stays a real
			// break and the comment fires on the raw boundary.
			const rows = [
				{
					// Even run: the newline is a real break; the comment takes
					// `) <<E` and `zap x` is extracted from inside the frame.
					input: "echo $(a\\\\\n#b) <<E\nzap x\n)\nE",
					commands: ["echo", "a\\", "zap x", "E"],
					error: null,
				},
				{
					// Odd run R=3: bash runs the word `a\#b`; the full-run step
					// comments and fails closed instead (safe direction).
					input: "echo $(printf %s a \\\\\\\n#b)",
					commands: ["echo $(printf %s a \\\\\\\n#b)"],
					error: "command-substitution",
				},
				{
					// The continuation pair before the `#` is walked over; the
					// space before the backslash is the boundary the shell sees,
					// so the comment fires and swallows the frame closer.
					input: "echo $( \\\n#)",
					commands: ["echo $( \\\n#)"],
					error: "command-substitution",
				},
				{
					// Escaped CR: the LF stands, the comment fires, the frame
					// never closes.
					input: "echo $(a\\\r\n#b)",
					commands: ["echo $(a\\\r\n#b)"],
					error: "command-substitution",
				},
				{
					// An even backslash run directly before the `#` ends in an
					// escaped backslash: the `#` is mid-word word text and the
					// frame closes normally.
					input: "echo $(a \\\\#b)",
					commands: ["echo", "a \\#b"],
					error: null,
				},
				{
					// Two stacked single continuations: both pairs are removed,
					// so the shell sees `a` directly before the `#` — word
					// text. The frame closes normally; the split segments are
					// the host tokenizer's own reading of the continuation
					// bytes, never a comment swallowing.
					input: "echo $(a\\\n\\\n#b)",
					commands: ["echo", "a", "", "#b"],
					error: null,
				},
				{
					// An odd run of one directly before the `#` escapes the
					// `#` itself: literal word text, frame closes normally.
					input: "echo $(a \\#b)",
					commands: ["echo", "a #b"],
					error: null,
				},
			]
			const observed = rows.map(({ input }) => {
				const result = parseCommand(input)
				return { commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ input: _input, ...expected }) => expected))
		})

		it("walks continuations at the frame-comment boundary inside heredoc bodies", () => {
			// The body walk carries the same tracker and the same boundary walk
			// as the main scan, so a continuation comment inside a body frame
			// reads the same. The swallowed-closer shape keeps every executed
			// command visible: the body mask holds the raw text, and the
			// unquoted-delimiter payload re-scan starts at host level, where
			// the same comment rule fires on the `#` after the removed
			// continuation pair — the quote on that line dies with the
			// comment, and each executed command surfaces as its own segment.
			// The glued shape stays word text with its frame closing normally.
			const rows = [
				{
					input: "cat <<E\necho $(echo \\\n#x ) '\nprintf MARKER >&2) #'\nE",
					commands: [
						"cat <<E\necho $(echo \\\n#x ) '\nprintf MARKER >&2) #'\nE",
						"echo ",
						"printf MARKER >&2",
					],
					error: null,
				},
				{
					input: "cat <<E\necho $(a\\\n#b)\nE",
					commands: ["cat <<E\necho $(a\\\n#b)\nE", "a", "#b"],
					error: null,
				},
			]
			const observed = rows.map(({ input }) => {
				const result = parseCommand(input)
				return { commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ input: _input, ...expected }) => expected))
		})

		it("fires a host-level comment reached through a line continuation", () => {
			// The shell removes a backslash-newline pair before tokenizing, so
			// a `#` opening the continuation line is word-initial: the comment
			// fires and every quote on that line dies with it. Recording the
			// pair as an escape-pair word continuation suppressed both comments
			// in the two-comment shape below: the `"` on each comment line
			// opened a live mask, the pair kept quote parity even so the input
			// parsed, and the executed lines rode the quote-shaped segments
			// hidden from the command lists. With the comment firing, the one
			// quote still live at end of input stays unterminated and the
			// parser refuses the shape — the same reading bash reaches, which
			// aborts on the same unmatched `"` after the executable printf
			// lines have already run. The residual quote pairing need not be
			// byte-exact to bash: the
			// pinned security property is that an executed line is either a
			// visible word or the input is refused. The quote-free rows show
			// the visible-word side: the comment takes the `# p` / backtick
			// bytes (a comment is not shell syntax, so no payload extracts) and
			// the executed line surfaces as an ordinary word.
			const rows = [
				{
					input: 'echo a \\\n# "p\nprintf RAN1\n" q\nb \\\n# "r\nprintf RAN2\n" s',
					commands: ['echo a \\\n# "p\nprintf RAN1\n" q\nb \\\n# "r\nprintf RAN2\n" s'],
					error: "double",
				},
				{
					input: 'echo a \\\n# "p\nprintf RAN\n" q',
					commands: ['echo a \\\n# "p\nprintf RAN\n" q'],
					error: "double",
				},
				{
					input: "echo x \\\n# p\nprintf RAN",
					commands: ["echo x ", "printf RAN"],
					error: null,
				},
				{
					input: "echo a \\\n#c `printf RAN4`",
					commands: ["echo a "],
					error: null,
				},
			]
			const observed = rows.map(({ input }) => {
				const result = parseCommand(input)
				return { commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ input: _input, ...expected }) => expected))
		})

		it("keeps host-level continuation word text on the accept path", () => {
			// The recording guard excludes only the backslash-newline pair, so
			// the accept paths bash runs must keep parsing as word text. A
			// glued pair leaves the word bytes directly before the `#`: mid-
			// word, no comment, and the following line stays its own word. At
			// start of input the removal puts the `#` at the logical start: a
			// comment, and nothing after it executes. Stacked pairs both
			// remove, again gluing the word bytes to the `#`. An ordinary
			// escape pair still records its end: a `#` after an escaped blank
			// is word interior, and commenting it would refuse a word bash
			// runs.
			const rows = [
				{
					input: "printf %s a\\\n#b",
					commands: ["printf %s a", "#b"],
					error: null,
				},
				{
					input: "a\\\n#b",
					commands: ["a", "#b"],
					error: null,
				},
				{
					input: "\\\n#x",
					commands: [""],
					error: null,
				},
				{
					input: "printf %s a\\\n\\\n#b",
					commands: ["printf %s a", "", "#b"],
					error: null,
				},
				{
					input: "printf %s a\\ #b",
					commands: ["printf %s a #b"],
					error: null,
				},
			]
			const observed = rows.map(({ input }) => {
				const result = parseCommand(input)
				return { commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ input: _input, ...expected }) => expected))
		})

		it("does not treat exotic JS-\\s bytes as shell word separators", () => {
			// bash word-splits on the default $IFS blanks (space, tab, newline)
			// only. JS `\s` is wider — VT, FF, NBSP, U+3000, U+2001, U+2028 —
			// and a `#` after one of those extras is mid-word to bash, so the
			// comment bytes (here a whole `$(evil)`) execute. Reading the
			// extras as boundaries commented the payload away and approved the
			// command. The frame rows pin the substitution-frame rule and its
			// payload re-scan; the top rows pin the same rule's top-level twin.
			// The accept rows keep space and tab commenting: exact $IFS, never a
			// widened refusal.
			const exotic = ["\x0b", "\x0c", "\u00a0", "\u3000", "\u2001", "\u2028"]
			// The top-level host word reaches the tokenizer as
			// `a<exotic><# placeholder>`: the tokenizer ends the word at the
			// exotic byte and the placeholder rejoins with one space, so the
			// pinned invariant is the `#` surviving as a restored word byte
			// (not a dropped comment) and `evil` surfacing as its own segment.
			const rows = exotic.flatMap((b) => [
				{
					name: `frame-${b.codePointAt(0)}`,
					input: `echo $( ${b}#$(evil)\n)`,
					commands: ["echo", "#", "evil"],
					error: null,
				},
				// Decoy-closer frame shape: a boundary class that wrongly ends
				// the word at the exotic byte would start a comment swallowing
				// the frame's own `)`, leaving bash-valid input open.
				{
					name: `frame-decoy-${b.codePointAt(0)}`,
					input: `echo $(x${b}#c) $(evil)`,
					commands: ["echo", "x #c", "evil"],
					error: null,
				},
				{
					name: `top-${b.codePointAt(0)}`,
					input: `echo a${b}#$(evil)`,
					commands: ["echo a #", "evil"],
					error: null,
				},
			])
			const observed = rows.map(({ name, input }) => {
				const result = parseCommand(input)
				return { name, commands: result.commands, error: result.parseError?.quoteType ?? null }
			})
			expect(observed).toEqual(rows.map(({ name, input: _input, ...expected }) => ({ name, ...expected })))
			for (const blank of [" ", "\t"]) {
				expect(parseCommand(`echo $( ${blank}#$(evil)\n)`).commands).toEqual(["echo"])
				expect(parseCommand(`echo a${blank}#$(evil)`).commands).toEqual(["echo a"])
			}
		})

		it("does not extract a substitution from a single-quoted span on the opener remainder", () => {
			// bash tokenizes the opener-line remainder, so a balanced `'…'`
			// span undergoes quote removal and nothing inside it executes: the
			// span contributes no payload, and the command keeps the head's
			// clean approval path. Over-extracting here turns an inert argument
			// into a denied segment bash never runs.
			const { commands, parseError } = parseCommand("cat <<E '$(rm -rf /)'\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE $(rm -rf /)"])
		})

		it("still extracts from unquoted text following a masked single-quoted remainder span", () => {
			// The mask ends at the span's closing quote: live syntax after it
			// still reaches its own segment, so masking cannot become a way to
			// hide a payload by prefixing an inert quote word.
			const { commands, parseError } = parseCommand("cat <<E '$(inert)' $(zap x)\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE $(inert) $ ( zap x )", "zap x"])
			// A single quote inside a double-quoted word is literal: the word
			// still expands, so the interior `'…'` shape must not mask the
			// substitution. bash runs `zap x` here (the quotes inside `"…"`
			// never open a single-quote region).
			const dq = parseCommand(`cat <<E "x' $(zap x)' y"\nbody\nE`)
			expect(dq.parseError).toBeNull()
			expect(dq.commands).toEqual(["cat <<E\nbody\nE x' $(zap x)' y", "zap x"])
		})

		it("extracts the substitution after an ANSI-C word whose escaped quote ends the word", () => {
			// bash ends an ANSI-C word at its first unescaped `'`: in `$'\''`
			// the `\'` is the word's content and the word closes at the third
			// quote, so `$(zap x)` after it is live syntax that bash expands
			// before running `cat`. A mask that pairs raw quote bytes consumes
			// the escaped quote, treats the following space and substitution as
			// quoted host text, and lets the executed payload ride the host
			// unchecked.
			const { commands, parseError } = parseCommand("cat <<E $'\\'' $(zap x) ''\nbody\nE\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE ' $ ( zap x ) ", "zap x"])
		})

		it("keeps an ANSI-C word's body inert and its chain collection faithful", () => {
			// The ANSI-C region is opaque to its unescaped closer: a
			// substitution inside its body expands to nothing (bash performs
			// no expansion inside `$'…'`) and must not surface as a segment,
			// while live syntax after the word still reaches its own.
			const inert = parseCommand("cat <<E $'a $(inert) b' $(zap x)\nbody\nE\n")
			expect(inert.parseError).toBeNull()
			expect(inert.commands).toEqual(["cat <<E\nbody\nE a $(inert) b $ ( zap x )", "zap x"])
			// An ANSI-C word whose closer is escaped never closes: bash reads
			// one unterminated word, runs nothing, and executes no
			// substitution — so none may surface as a segment either.
			const unterminated = parseCommand("cat <<E $'a\\' $(zap x)\nbody\nE\n")
			expect(unterminated.parseError).toBeNull()
			// The full array pins what the parse does return: the payload never
			// surfaces, and the unterminated word's bytes ride the host verbatim.
			expect(unterminated.commands).toEqual(["cat <<E\nbody\nE $a\\ $ ( zap x )"])
			expect(unterminated.commands).not.toContain("zap x")
			// The chained-opener collector reads the same remainder bytes: an
			// ANSI-C word must not shift its quote parity into a hidden `<<`
			// chain opener. Here the chain resolves and the second body's
			// substitution reaches its own segment; in the comment variant the
			// chain body runs past end of input and the construct fails closed
			// (bash reads the chained bodies sequentially from the input
			// stream and expands what it reads), where a parity-flipped word
			// would silently drop the opener and hand the body lines back as
			// live text.
			const chain = parseCommand("cat <<A $'\\'' <<B\nA\n$(evil)\nB\n")
			expect(chain.parseError).toBeNull()
			expect(chain.commands).toEqual(["cat <<A\nA\n$(evil)\nB ' << B", "evil"])
			const chainComment = parseCommand("cat <<A $'\\'' <<B\nA\n# $(evil) B\n")
			expect(chainComment.parseError?.quoteType).toBe("heredoc")
			expect(chainComment.commands).toEqual(["cat <<A $'\\'' <<B\nA\n# $(evil) B\n"])
		})

		it("keeps a word-start # inside an open ANSI-C region from cutting the live remainder", () => {
			// bash starts a comment at a word-start `#` only outside quotes:
			// here the `#` sits inside the open `$'…'` region, so it is region
			// content and the region closes at the final quote — bash expands
			// the substitution after the word. An onset scan that pairs raw
			// quote bytes closes the region at the escaped `\'`, reads that
			// `#` as a comment start, and drops the executed payload into the
			// host text.
			const { commands, parseError } = parseCommand("cat <<E $'a \\' # b' $(echo M30 >&2)\nbody\nE\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE a ' # b $ ( echo M30 >& 2 )", "echo M30 >&2"])
		})

		it("fails closed when an ANSI-C word precedes a line-continuation backslash on a quoted-delimiter opener", () => {
			// bash joins a trailing-backslash continuation before
			// tokenizing, so the substitution is live on the opener line
			// while the remainder cut cannot account for the joined bytes
			// — the construct must fail closed. The guard reads the quote
			// state just before the backslash run: ANSI-C-aware pairing
			// closes `$'\''` at its third quote and reports no open quote,
			// while raw-byte pairing closes at the escaped quote and
			// reopens at the trailing one, silencing the guard exactly
			// where bash runs the joined payload.
			const join = "cat <<'E' $'\\'' \\\n$(echo M20 >&2)\nE\n"
			const joined = parseCommand(join)
			expect(joined.parseError?.quoteType).toBe("heredoc")
			expect(joined.commands).toEqual([join])
			// The joinless shape still passes the same guard: the quoted
			// delimiter suppresses body expansion, not opener-line
			// remainder expansion, so the substitution reaches its own
			// segment.
			const clean = parseCommand("cat <<'E' $'\\'' $(echo M22 >&2)\nbody\nE\n")
			expect(clean.parseError).toBeNull()
			expect(clean.commands).toEqual(["cat <<'E'\nbody\nE ' $ ( echo M22 >& 2 )", "echo M22 >&2"])
		})

		it("keeps an escaped double quote from closing a double-quoted opener region", () => {
			// Inside `"..."` bash pairs a backslash with the next character, so
			// `\"` is an escaped double quote and the region stays open: the `#`
			// after it is region content, never a comment onset, and the
			// substitution remains live syntax reaching its own segment. An
			// onset scan that tests the escape exemption against the wrong quote
			// kind treats `\"` as the closer, reads the following `#` as a
			// word-start comment, and drops the payload as comment material.
			const { commands, parseError } = parseCommand('cat <<E "a\\" # $(zap x)"\nbody\nE')
			expect(parseError).toBeNull()
			expect(commands).toEqual(['cat <<E\nbody\nE a" # $(zap x)', "zap x"])
		})

		it("keeps a single-quoted backslash literal so its closer ends the region", () => {
			// Inside `'...'` bash reads a backslash as literal, so `\'` closes the
			// region: the following word-start `#` opens the comment bash sees and
			// the substitution after it is discarded text, never an extracted
			// payload. An onset scan that applies the escape pair inside single
			// quotes carries the region past the closer and turns that comment
			// material into a live segment.
			const { commands, parseError } = parseCommand("cat <<E 'a\\' # $(zap x)'\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE a\\"])
		})

		it("fails closed on an apostrophe after a mid-word # in the opener remainder", () => {
			// A `#` glued to a word is word content, not a comment start, so the
			// `'` after it is live syntax that spans the newline like the
			// un-commented shape.
			const input = "cat <<E x#'a\nb'; zap x\nhi\nE"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
			// A blank escaped by `\ ` also keeps the following `#` mid-word:
			// bash carries the opened `'` across the newline, so the opener
			// stays over-rejected rather than swallowing the quote.
			const escapedInput = "cat <<E \\ #'a\nbody'\nE"
			const escaped = parseCommand(escapedInput)
			expect(escaped.commands).toEqual([escapedInput])
			expect(escaped.parseError?.quoteType).toBe("heredoc")
			// The escape pair consumes exactly the backslash and the escaped
			// character: the word after it is read normally, so `\'` contributes
			// a literal quote word and the following word-start `#` is a comment.
			// (The body apostrophe matters: an over-read that left the escaped
			// `'` unpaired would read it as a residual quote closing here.)
			const escapeQuote = parseCommand("cat <<E \\' # dont\nb'ody\nE")
			expect(escapeQuote.parseError).toBeNull()
			expect(escapeQuote.commands).toEqual(["cat <<E\nb'ody\nE '"])
			// A quote byte directly after the pair is visited, not skipped: it
			// opens a region that swallows the `#`, so the comment never starts
			// and the quote text reaches the host. (An under-read that skipped
			// this `'` would open the comment and see its apostrophe as a
			// residual quote closing on the body.)
			const quoteAfterPair = parseCommand("cat <<E \\x' # don't\nb'ody\nE")
			expect(quoteAfterPair.parseError).toBeNull()
			expect(quoteAfterPair.commands).toEqual(["cat <<E\nb'ody\nE x # dont"])
			// The escape pair consumes exactly two bytes, so the `\'` word and
			// the following word-start comment stay separated: the comment's
			// `$(zap x)` is discarded text, never an extracted payload segment.
			const commentPayload = parseCommand("cat <<E \\' # it's here's $(zap x)\nbody\nE")
			expect(commentPayload.parseError).toBeNull()
			expect(commentPayload.commands).toEqual(["cat <<E\nbody\nE '"])
		})

		it("starts a # comment on the opener line regardless of the byte after the #", () => {
			// bash opens a comment at any unquoted word-start `#`: only the
			// byte before the `#` decides word start, so `#don't` opens a
			// comment just like a spaced `#`. The comment is discarded before
			// any quote is interpreted, so its apostrophe never opens a
			// region. A remainder quote that closes on a later line fails the
			// opener closed, which is why the body carries the matching
			// apostrophe: reading the byte after the `#` instead of before it
			// misses this onset, keeps the comment bytes live, and refuses an
			// opener bash runs.
			const { commands, parseError } = parseCommand("cat <<E #don't\nb'ody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nb'ody\nE"])
		})

		it("starts the opener-remainder comment at a # right after a semicolon", () => {
			// A metacharacter terminates the previous word, so the `#` after
			// `;` sits at a word start and opens a comment bash discards
			// before any quote is interpreted: its apostrophe never opens a
			// region. The bare-`(` onset shows the same rule from the other
			// side of the metacharacter set. Reading the byte after the `#`
			// instead of before it misses this onset, keeps the comment bytes
			// live, and refuses an opener bash runs on the comment's
			// apostrophe closing at the body's `b'`.
			const { commands, parseError } = parseCommand("cat <<E ;#don't\nb'ody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nb'ody\nE"])
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
			// the `#` as ordinary content and runs the tail. The parameter
			// expansion carries its verbatim text as the masked placeholder
			// restores it; the arithmetic frame must close at its second `)`,
			// never the first.
			const param = parseCommand("cat <<E ${x}#y ; rm z\nhi\nE")
			expect(param.parseError).toBeNull()
			expect(param.commands).toEqual(["cat <<E\nhi\nE ${x}#y", "rm z"])
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
			// instead of approving unexecutable input whose remainder hides the
			// parenthesized text unsplit.
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

		it("splits a spaced parenthesized remainder: the heredoc closes and keeps the group (no over-reject)", () => {
			// A blank before the `(` ends the delimiter word at bash's token
			// boundary, so the heredoc closes and the group reaches the host
			// text unsplit.
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
			// never terminates, and the construct is rejected.
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

		const delimiterBreakRows: Array<{
			name: string
			input: string
			commands: string[]
			error: "heredoc" | null
		}> = [
			{
				name: "fails closed on | starting the delimiter word",
				input: "cat <<|x\nb\n|x",
				commands: ["cat <<|x\nb\n|x"],
				error: "heredoc",
			},
			{
				name: "fails closed on & starting the delimiter word",
				input: "cat <<&x\nb\n&x",
				commands: ["cat <<&x\nb\n&x"],
				error: "heredoc",
			},
			{
				name: "fails closed on ; starting the delimiter word",
				input: "cat <<;x\nb\n;x",
				commands: ["cat <<;x\nb\n;x"],
				error: "heredoc",
			},
			{
				name: "fails closed on < starting the delimiter word",
				input: "cat << <x\nb\nE",
				commands: ["cat << <x\nb\nE"],
				error: "heredoc",
			},
			{
				name: "fails closed on > starting the delimiter word",
				input: "cat <<>x\nb\n>x",
				commands: ["cat <<>x\nb\n>x"],
				error: "heredoc",
			},
			{
				name: "ends the delimiter word at a glued | and splits the tail",
				input: "cat <<E|x\nb\nE",
				commands: ["cat <<E\nb\nE", "x"],
				error: null,
			},
			{
				name: "ends the delimiter word at a glued & and splits the tail",
				input: "cat <<E&x\nb\nE",
				commands: ["cat <<E\nb\nE", "x"],
				error: null,
			},
			{
				name: "ends the delimiter word at a glued ; and splits the tail",
				input: "cat <<E;x\nb\nE",
				commands: ["cat <<E\nb\nE", "x"],
				error: null,
			},
			{
				name: "ends the delimiter word at a glued < redirect",
				input: "cat <<E<x\nb\nE",
				commands: ["cat <<E\nb\nE < x"],
				error: null,
			},
			{
				name: "ends the delimiter word at a glued > redirect",
				input: "cat <<E>x\nb\nE",
				commands: ["cat <<E\nb\nE > x"],
				error: null,
			},
		]

		const singleQuoteEscapeRows: Array<{
			name: string
			input: string
			commands: string[]
			error: "heredoc" | null
		}> = [
			{
				name: "keeps a backslash literal inside a single-quoted remainder region",
				input: "cat <<E 'a\\'#x ; rm x\nbody\nE",
				commands: ["cat <<E\nbody\nE a\\#x", "rm x"],
				error: null,
			},
		]

		it.each(singleQuoteEscapeRows)("$name", ({ input, commands, error }) => {
			// Inside single quotes bash reads a backslash as literal, so `'a\'`
			// closes at the second `'` and `; rm x` stays live syntax. The walk's
			// `quote !== "'"` exemption owns that reading: dropping it makes the
			// walk consume `\'` as an escape pair, carry the single-quote region
			// across the newline, and fold `; rm x` into one masked word.
			const result = parseCommand(input)
			expect(result.commands).toEqual(commands)
			expect(result.parseError?.quoteType ?? null).toBe(error)
		})

		it.each(delimiterBreakRows)("$name", ({ input, commands, error }) => {
			// Each metacharacter in the delimiter break sets ends the word at
			// both positions. At word start the empty word plus the operator
			// token is the shape bash rejects, so the opener fails closed.
			// Glued after the word the operator is live syntax: the body
			// closes at the terminator and the tail becomes a host segment (or
			// redirect word text for `<`/`>`, which the tokenizer keeps with the
			// word). Erasing an operator from either set absorbs it into the
			// delimiter word: the start row loses its rejection and the glued
			// row's terminator never matches, so one row per operator goes red.
			const result = parseCommand(input)
			expect(result.commands).toEqual(commands)
			expect(result.parseError?.quoteType ?? null).toBe(error)
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

		it("extracts the substitution whose opener a line continuation forms inside a parameter expansion", () => {
			// The shell removes backslash-newline pairs before tokenizing, so a
			// `$` and the `(` or `{` on the other side of a continuation are
			// adjacent to the shell: the expansions below really open, and the
			// substitution inside each must be extracted as its own segment
			// instead of vanishing into the expansion's verbatim host text.
			const printf = parseCommand("echo ${x:-$\\\n(printf RAN > ran.marker)}\n")
			expect(printf.parseError).toBeNull()
			expect(printf.commands).toEqual(["echo ${x:-$\\\n(printf RAN > ran.marker)}", "printf RAN > ran.marker"])
			const rm = parseCommand("echo ${x:-$\\\n(rm -rf /tmp/join.marker)}\n")
			expect(rm.parseError).toBeNull()
			expect(rm.commands).toEqual(["echo ${x:-$\\\n(rm -rf /tmp/join.marker)}", "rm -rf /tmp/join.marker"])
			const brace = parseCommand("echo a$\\\n{x:-$(printf RAN > ran.marker)}\n")
			expect(brace.parseError).toBeNull()
			expect(brace.commands).toEqual(["echo a$\\\n{x:-$(printf RAN > ran.marker)}", "printf RAN > ran.marker"])
			const processSub = parseCommand("echo ${x:-<\\\n(printf RAN > ran.marker)}\n")
			expect(processSub.parseError).toBeNull()
			expect(processSub.commands).toEqual([
				"echo ${x:-<\\\n(printf RAN > ran.marker)}",
				"printf RAN > ran.marker",
			])
			const processTop = parseCommand("cat <\\\n(printf RAN > ran.marker)\n")
			expect(processTop.parseError).toBeNull()
			expect(processTop.commands).toEqual(["cat", "printf RAN > ran.marker"])
		})

		it("extracts through stacked and escaped-backslash continuation runs", () => {
			// The shell removes each continuation pair independently, so a run of
			// pairs still joins the opener bytes, and an `\\` escape pair consumes
			// only itself: the `$` standing after it still joins across the
			// continuation that follows. Each payload below is a command bash
			// substitutes and executes, so each is extracted on its own.
			const stacked = parseCommand("echo ${x:-$\\\n\\\n(printf RAN > ran.marker)}\n")
			expect(stacked.parseError).toBeNull()
			expect(stacked.commands).toEqual([
				"echo ${x:-$\\\n\\\n(printf RAN > ran.marker)}",
				"printf RAN > ran.marker",
			])
			const escaped = parseCommand("echo ${x:-\\\\$\\\n(printf RAN > ran.marker)}\n")
			expect(escaped.parseError).toBeNull()
			expect(escaped.commands).toEqual([
				"echo ${x:-\\\\$\\\n(printf RAN > ran.marker)}",
				"printf RAN > ran.marker",
			])
			const escapedTop = parseCommand("echo a\\\\$\\\n(printf RAN > ran.marker)\n")
			expect(escapedTop.parseError).toBeNull()
			expect(escapedTop.commands).toEqual(["echo a\\", "printf RAN > ran.marker"])
		})

		it("keeps a surviving byte unjoined and a join-formed ANSI-C word opaque", () => {
			// Continuation removal deletes exactly the backslash and the newline,
			// so a space between them keeps `$` and `(` apart for the shell: the
			// word below is never substituted, and the parser must neither open a
			// frame nor refuse it. A `$'` word joined the same way quotes its
			// interior for the shell, and that interior stays unextracted.
			const spaced = parseCommand("echo ${x:-$\\ (rm -rf /tmp/example)}\n")
			expect(spaced.parseError).toBeNull()
			expect(spaced.commands).toEqual(["echo ${x:-$\\ (rm -rf /tmp/example)}"])
			const ansiC = parseCommand("echo ${x:-$\\\n'a$(printf RAN > ran.marker)'}\n")
			expect(ansiC.parseError).toBeNull()
			expect(ansiC.commands).toEqual(["echo ${x:-$\\\n'a$(printf RAN > ran.marker)'}"])
		})

		it("forms substitution openers across CRLF continuation runs", () => {
			// On the reference shell a carriage return between the continuation
			// backslash and the newline does not stop the join, so a `$` or `<`
			// and the opener byte behind a backslash-CR-LF run are adjacent to
			// that shell: each substitution below really executes, so the parser
			// must open its frame and extract the payload instead of leaving it
			// masked in the expansion's verbatim host text. The CR-joined `{` is
			// the exception the next test covers: the reference shell reads that
			// join only to reject the whole line, so it fails closed.
			const inExpansion = parseCommand("echo ${x:-$\\\r\n(printf RAN > ran.marker)}\n")
			expect(inExpansion.parseError).toBeNull()
			expect(inExpansion.commands).toEqual([
				"echo ${x:-$\\\r\n(printf RAN > ran.marker)}",
				"printf RAN > ran.marker",
			])
			const topLevel = parseCommand("echo $\\\r\n(printf RAN > ran.marker)\n")
			expect(topLevel.parseError).toBeNull()
			expect(topLevel.commands).toEqual(["echo", "printf RAN > ran.marker"])
			const braceInput = "echo a$\\\r\n{x:-$(printf RAN > ran.marker)}\n"
			const brace = parseCommand(braceInput)
			expect(brace.parseError?.quoteType).toBe("ambiguous-opener")
			// A fail-closed result returns the raw input verbatim as its one
			// opaque token.
			expect(brace.commands).toEqual([braceInput])
			const processSub = parseCommand("echo ${x:-<\\\r\n(printf RAN > ran.marker)}\n")
			expect(processSub.parseError).toBeNull()
			expect(processSub.commands).toEqual([
				"echo ${x:-<\\\r\n(printf RAN > ran.marker)}",
				"printf RAN > ran.marker",
			])
			const processTop = parseCommand("cat <\\\r\n(printf RAN > ran.marker)\n")
			expect(processTop.parseError).toBeNull()
			expect(processTop.commands).toEqual(["cat", "printf RAN > ran.marker"])
			const processOut = parseCommand("echo >\\\r\n(printf RAN > ran.marker)\n")
			expect(processOut.parseError).toBeNull()
			expect(processOut.commands).toEqual(["echo", "printf RAN > ran.marker"])
		})

		it("fails closed on a brace opener its CR continuation joins ambiguously", () => {
			// A `{` that meets its `$` only through a backslash-CR-LF run is
			// ambiguous between read models of the executing shell, unlike the
			// `(` arms the tests above show the reference shell executing. The
			// scan masks nothing behind the opener and refuses the input
			// instead, so no allowlisted host word can carry the remainder.
			const crBrace = "echo $\\\r\n{ touch /tmp/cr.marker; }\n"
			expect(parseCommand(crBrace).parseError?.quoteType).toBe("ambiguous-opener")
			expect(parseCommand(crBrace).commands).toEqual([crBrace])
			// The strict adjacency rule still opens the expansion: the
			// adjacent and LF-only joins parse as before.
			expect(parseCommand("echo a$\\\n{x:-$(printf RAN > ran.marker)}\n").parseError).toBeNull()
			expect(parseCommand("echo ${x:-2}").parseError).toBeNull()
			// The CR tolerance stays exactly where the reference shell joins:
			// the `(` arms keep extracting their payloads across CR runs.
			const crParen = parseCommand("echo $\\\r\n(printf RAN > ran.marker)\n")
			expect(crParen.parseError).toBeNull()
			expect(crParen.commands).toEqual(["echo", "printf RAN > ran.marker"])
		})

		it("fails closed on a CR-joined brace opener nested inside an expansion", () => {
			// The nested `{` arm applies the same strictness as the top-level
			// one, so the enclosing expansion cannot mask it away.
			const nested = "echo ${x:-a$\\\r\n{y:-2}}"
			expect(parseCommand(nested).parseError?.quoteType).toBe("ambiguous-opener")
			expect(parseCommand(nested).commands).toEqual([nested])
			// The LF-only twin still parses: the strictness is scoped to CR.
			expect(parseCommand("echo ${x:-a$\\\n{y:-2}}").parseError).toBeNull()
		})

		it("fails closed on a glob word inside a re-scanned substitution payload", () => {
			// shell-quote reduces a glob word to an inert `glob` token whose
			// pattern the reconstruction drops, so the re-scanned words would
			// under-approximate what bash glob-expands. The payload fails
			// closed on the shared error channel.
			const input = "echo $(rm* /tmp/victim)"
			const { commands, parseError } = parseCommand(input)
			expect(parseError?.quoteType).toBe("payload-glob")
			expect(commands).toEqual([input])
			// Payloads without a glob token are unchanged: the accept path.
			const clean = parseCommand("echo $(printf x /tmp/victim)")
			expect(clean.parseError).toBeNull()
			expect(clean.commands).toEqual(["echo", "printf x /tmp/victim"])
			// The strict rule is scoped to re-scanned payloads: a host-level
			// glob word stays host text exactly as before, so an ordinary
			// globbed host line still parses.
			expect(parseCommand("ls *.ts").parseError).toBeNull()
		})

		it("expands placeholders in the payload-glob message excerpt", () => {
			// The excerpt quotes the rejected line back to the user and the
			// model, so it must render the expanded text rather than the raw
			// masked line with its placeholder sentinel and internal names.
			const { parseError } = parseCommand("echo $(rm* 'a $b')")
			expect(parseError?.quoteType).toBe("payload-glob")
			expect(parseError?.message).not.toContain("\x00")
			expect(parseError?.message).not.toMatch(/\0[A-Z]\d+\0/)
			expect(parseError?.message).toContain("glob pattern inside a substitution payload")
			expect(parseError?.message).toContain("rm* 'a $b'")
			// A rejection kind renders its label bare, never behind the
			// `unterminated ` prefix an unclosed region gets.
			expect(parseError?.message).not.toContain("unterminated")
		})

		it.each([
			"echo $(rm -rf /tmp/victim)*",
			'echo "$(rm -rf /tmp/victim)"*',
			"echo ${x:-$(rm -rf /tmp/victim)}*",
			"echo <(rm -rf /tmp/victim)*",
		])("fails closed on a host glob word carrying a substitution: %s", (input) => {
			// The tokenizer collapses the whole word to the literal `glob`,
			// swallowing the construct's placeholder, so the construct's
			// payload is never extracted, re-scanned, or checked. The bare
			// `glob` word could ride an allow rule to an approval while bash
			// runs the embedded command. The word fails closed on the shared
			// error channel, like the payload-glob rule above.
			const { commands, parseError } = parseCommand(input)
			expect(parseError?.quoteType).toBe("placeholder-glob")
			expect(commands).toEqual([input])
		})

		it("keeps glob words that carry no executable placeholder on the main-line path", () => {
			// The strict rule is scoped to glob words that swallow a masked
			// executable construct. A plain host glob, a plain substitution,
			// and a glob sharing its word with a payload-free variable all
			// behave exactly as before.
			expect(parseCommand("ls *.log").parseError).toBeNull()
			expect(parseCommand("ls *.log").commands).toEqual(["ls glob"])
			expect(parseCommand("echo $(ls)").parseError).toBeNull()
			expect(parseCommand("echo $(ls)").commands).toEqual(["echo", "ls"])
			expect(parseCommand("ls $HOME/*.log").parseError).toBeNull()
			expect(parseCommand("ls $HOME/*.log").commands).toEqual(["ls glob"])
			// Two adjacent variable placeholders sit side by side in the
			// masked word, but neither is an executable construct: the match
			// must carry a class letter, not just sentinels.
			expect(parseCommand("ls $a$b*.log").parseError).toBeNull()
			expect(parseCommand("ls $a$b*.log").commands).toEqual(["ls glob"])
			// A glob word sharing its word with a redirection stays unchanged.
			expect(parseCommand("cat <file*.txt").parseError).toBeNull()
			// A quoted substitution without a glob character is unchanged.
			expect(parseCommand('echo "$(ls)"').parseError).toBeNull()
		})

		it("expands placeholders in the placeholder-glob message excerpt", () => {
			// The excerpt quotes the rejected line back to the user and the
			// model, so it must not expose the placeholder sentinel or
			// internal names.
			const { parseError } = parseCommand('echo "$(rm x)"*')
			expect(parseError?.quoteType).toBe("placeholder-glob")
			expect(parseError?.message).not.toContain("\x00")
			expect(parseError?.message).not.toMatch(/\0[A-Z]\d+\0/)
			expect(parseError?.message).toContain("glob word carrying a command substitution")
			expect(parseError?.message).toContain('echo "$(rm x)"*')
			// A rejection kind renders its label bare, never behind the
			// `unterminated ` prefix an unclosed region gets.
			expect(parseError?.message).not.toContain("unterminated")
		})

		it("renders the substitution payload in the placeholder-glob excerpt", () => {
			// The excerpt quotes the rejected word back to the user and the
			// model. Dropping the masked substitution hides the very construct
			// the rejection names, so the message path renders its payload
			// text while the decision path keeps masking it.
			const { parseError } = parseCommand("echo $(ls)*")
			expect(parseError?.quoteType).toBe("placeholder-glob")
			expect(parseError?.message).toContain("$(ls)")
			expect(parseError?.message).not.toContain("\x00")
			expect(parseError?.message).not.toMatch(/\0[A-Z]\d+\0/)
		})

		it("accepts a glob word whose glob characters are all backslash-escaped", () => {
			// A backslash makes a glob character literal to bash, so the word
			// cannot expand to files and the tokenizer's glob collapse hides
			// no expansion. The word is not rejected; its placeholders keep
			// their segment handling, so a substitution inside the word is
			// still extracted and checked, and the glob character survives as
			// literal word text (the escape character itself is word syntax,
			// the same byte class quote characters are for a quoted word).
			const simple = parseCommand("echo $(printf foo)\\*")
			expect(simple.parseError).toBeNull()
			expect(simple.commands).toEqual(["echo", "printf foo", "\\*"])
			const question = parseCommand("echo $(printf foo)\\?")
			expect(question.parseError).toBeNull()
			expect(question.commands).toEqual(["echo", "printf foo", "\\?"])
			const bracket = parseCommand("echo $(printf foo)\\[a")
			expect(bracket.parseError).toBeNull()
			expect(bracket.commands).toEqual(["echo", "printf foo", "\\[a"])
			// A `#` directly after an escaped glob character sits at the end of
			// the escape pair, so it is word interior: no comment starts and the
			// whole word survives as one token.
			const hashAfter = parseCommand("echo \\*#foo")
			expect(hashAfter.parseError).toBeNull()
			expect(hashAfter.commands).toEqual(["echo \\*#foo"])
			// Word text that merely starts with the letter Q is literal content,
			// not a quote placeholder: the accept path stays open.
			const textQ = parseCommand("echo \\*Quality")
			expect(textQ.parseError).toBeNull()
			expect(textQ.commands).toEqual(["echo \\*Quality"])
		})

		it("still rejects a placeholder-carrying glob word with an unescaped glob character", () => {
			// The accept path is scoped to fully escaped glob characters. The
			// same word with a plain `*` collapses a live glob and keeps its
			// placeholder hidden, so it stays on the rejection channel — and
			// the escaped and unescaped spellings act as the discriminator
			// pair for the guard.
			const star = parseCommand("echo $(printf foo)*")
			expect(star.parseError?.quoteType).toBe("placeholder-glob")
			expect(star.commands).toEqual(["echo $(printf foo)*"])
			// A quote region riding the masked escape stays on the rejection
			// channel: the region is opaque, so a substitution inside it would
			// never reach extraction, and bash runs it.
			const quoted = parseCommand('echo "$(rm x)"\\*')
			expect(quoted.parseError?.quoteType).toBe("placeholder-glob")
			expect(quoted.commands).toEqual(['echo "$(rm x)"\\*'])
			expect(quoted.parseError?.message).toContain("glob word carrying a command substitution")
			// A parameter-expansion region riding the masked escape is rejected
			// for the same reason: bash expands a substitution inside double
			// quotes within the region, and the region's payload list does not
			// carry that nested command, so no check would ever see it.
			const paramQuoted = parseCommand('echo ${x:-"$(rm y)"}\\*')
			expect(paramQuoted.parseError?.quoteType).toBe("placeholder-glob")
			expect(paramQuoted.commands).toEqual(['echo ${x:-"$(rm y)"}\\*'])
			// A parameter expansion riding the escape is rejected even when its
			// own substitution would be extracted: the region can hide a
			// substitution inside double quotes that its payload list does not
			// carry, so the accept path cannot be proven complete for regions.
			const paramQuoted2 = parseCommand("echo ${x:-$(printf x)}\\*")
			expect(paramQuoted2.parseError?.quoteType).toBe("placeholder-glob")
			expect(paramQuoted2.commands).toEqual(["echo ${x:-$(printf x)}\\*"])
			// An arithmetic expression riding the escape is rejected for the same
			// reason: the region may hide a quoted substitution.
			const arith = parseCommand("echo $(( 1 + $(printf x) ))\\*")
			expect(arith.parseError?.quoteType).toBe("placeholder-glob")
		})

		it("refuses a comment that ends at a lone carriage return", () => {
			// bash ends a comment only at a newline. When this scan's comment
			// stops at a lone carriage return, the comment text bash still
			// keeps — a quote opener included — would open a live region in
			// this scan. The two readings of the terminator disagree, so the
			// input fails closed as one opaque token. Every comment terminated
			// by a lone carriage return takes this path, with or without quote
			// characters in its text.
			const shapes = [
				"echo;# '\recho '\nrm -rf /\n# '\n",
				"echo;# '\rx '\nrm -rf /\n'",
				"echo;#x\recho '\nrm -rf /\n'\n",
				"echo;#x\r'\nrm -rf /\n'\n",
				"echo;#x\rrm -rf /",
				"echo #x\rrm -rf /",
			]
			for (const input of shapes) {
				const { commands, parseError } = parseCommand(input)
				expect(parseError?.quoteType).toBe("ambiguous-comment")
				expect(commands).toEqual([input])
			}
			// The message names the disagreement by its own label: not the
			// generic "unterminated ..." form, because no region is open.
			const message = parseCommand(shapes[0]).parseError?.message ?? ""
			expect(message).toContain(
				"comment terminated by a lone carriage return (the executing shell reads the comment as extending past it)",
			)
			expect(message).not.toContain("unterminated")
		})

		it("refuses a comment inside a substitution frame that ends at a lone carriage return", () => {
			// The frame-comment walks end comments at the same line boundary
			// as the host comment branch, so the same disagreement exists
			// there: inside a command substitution, and inside a substitution
			// extracted from a heredoc body.
			const nestedInput = "echo $(# '\recho '\nrm -rf /\n# '\n)"
			const nested = parseCommand(nestedInput)
			expect(nested.parseError?.quoteType).toBe("ambiguous-comment")
			expect(nested.commands).toEqual([nestedInput])
			const heredocInput = "cat <<EOF\n$(# c\rx)\nEOF\n"
			const heredoc = parseCommand(heredocInput)
			expect(heredoc.parseError?.quoteType).toBe("ambiguous-comment")
			expect(heredoc.commands).toEqual([heredocInput])
			// The frame walk's own refusal, before any unclosed-frame report:
			// a lone CR ends the comment, and the terminator disagreement is
			// what the scan reports — not the frame's missing closer.
			const unclosedInput = "echo $(# c\rx"
			const unclosed = parseCommand(unclosedInput)
			expect(unclosed.parseError?.quoteType).toBe("ambiguous-comment")
			expect(unclosed.commands).toEqual([unclosedInput])
			// The frame closer sits on the same line as the comment. The
			// frame's own walk refuses before any payload survives to be
			// re-scanned: the bash reading runs the comment (closer included)
			// past end of input, so the input is unparseable there too.
			const closerInput = "echo $(# x\r)"
			const closer = parseCommand(closerInput)
			expect(closer.parseError?.quoteType).toBe("ambiguous-comment")
			expect(closer.commands).toEqual([closerInput])
		})

		it("refuses a comment's lone carriage return before the quote region it opens", () => {
			// The same terminator with an unclosed quote region: without the
			// refusal the scan ends the comment at the carriage return and
			// reports the quote after it as unterminated, while bash reads the
			// whole tail as comment text. The terminator disagreement wins over
			// the quote report.
			const input = "echo;# '\rx '\nrm -rf /\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError?.quoteType).toBe("ambiguous-comment")
			expect(commands).toEqual([input])
		})

		it("keeps an LF-terminated comment masking its text as comment bytes", () => {
			// The LF-only twin of the refused shapes: bash and this scan agree
			// the comment ends at the newline, so the quoted word after it
			// parses as a region and the decomposition is unchanged.
			const { commands, parseError } = parseCommand("echo;# '\necho '\nrm -rf /\n# '\n")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "echo '\nrm -rf /\n# '"])
		})

		it("keeps CRLF line endings and CRLF-terminated comments on the parse path", () => {
			// A carriage return that is the CR of a CRLF pair is a line ending
			// for both read models (the splitter treats it as one), so nothing
			// about these shapes changes: CRLF lines still split into
			// segments, and a comment terminated by CRLF still masks its line.
			const lines = parseCommand("echo a\r\nrm -rf /")
			expect(lines.parseError).toBeNull()
			expect(lines.commands).toEqual(["echo a", "rm -rf /"])
			const comment = parseCommand("echo # c\r\nrm -rf /\n")
			expect(comment.parseError).toBeNull()
			expect(comment.commands).toEqual(["echo", "rm -rf /"])
		})

		it("keeps a carriage return inside a delimiter word from joining a dollar to a quote byte", () => {
			// The delimiter-word walk asks which bytes the tokenizer removes
			// inside a word, and a carriage return is not one of them: the run
			// stops at the CR, the CR stays inside the construct's region, and
			// the heredoc fails closed. That strict reading is the reviewed
			// delimiter-word invariant and the CR-tolerant opener reading must
			// not reach it.
			const input = "cat <<$\\\r\n'EOF'\nbody\nEOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("forms openers across continuation runs carrying several carriage returns", () => {
			// On the reference shell a backslash line continuation still joins
			// when several carriage returns sit before the newline, and when a
			// stack mixes CRLF and LF pairs: every shape below substitutes and
			// executes, so each opener must be recognized and its payload
			// extracted.
			const doubled = parseCommand("echo ${x:-$\\\r\r\n(printf RAN > ran.marker)}\n")
			expect(doubled.parseError).toBeNull()
			expect(doubled.commands).toEqual([
				"echo ${x:-$\\\r\r\n(printf RAN > ran.marker)}",
				"printf RAN > ran.marker",
			])
			const mixed = parseCommand("echo ${x:-$\\\n\\\r\n(printf RAN > ran.marker)}\n")
			expect(mixed.parseError).toBeNull()
			expect(mixed.commands).toEqual([
				"echo ${x:-$\\\n\\\r\n(printf RAN > ran.marker)}",
				"printf RAN > ran.marker",
			])
			const stacked = parseCommand("echo ${x:-$\\\r\n\\\r\n(printf RAN > ran.marker)}\n")
			expect(stacked.parseError).toBeNull()
			expect(stacked.commands).toEqual([
				"echo ${x:-$\\\r\n\\\r\n(printf RAN > ran.marker)}",
				"printf RAN > ran.marker",
			])
		})

		it("routes payloads through frames opened inside joined substitution bodies", () => {
			// The joins below open a frame nested inside another open frame, so
			// each payload travels the region walk's closer and comment rules on
			// its way out: a joined `>(` inside a substitution inside an
			// expansion, an escaped byte that keeps a `#` word content inside a
			// joined frame, a real comment that swallows the frame's own closer
			// only after the line ends, and a joined `{` whose expansion must
			// stay accounted inside its enclosing one. Every payload bash
			// substitutes here must reach the segment list exactly once.
			// A payload nested in a joined expansion reaches the list through
			// the re-scan of its enclosing payload, so the enclosing command is
			// emitted before it — the same order the top-level twins show.
			const outNested = parseCommand("echo ${x:-$(cat >\\\n(printf b > b.marker))}\n")
			expect(outNested.parseError).toBeNull()
			expect(outNested.commands).toEqual([
				"echo ${x:-$(cat >\\\n(printf b > b.marker))}",
				"cat",
				"printf b > b.marker",
			])
			const escapedTop = parseCommand("echo $(cat <\\\n(printf a\\ #c))\n")
			expect(escapedTop.parseError).toBeNull()
			expect(escapedTop.commands).toEqual(["echo", "cat", "printf a #c"])
			const escapedArith = parseCommand("echo $(( $(cat <\\\n(printf a\\ #c)) ))\n")
			expect(escapedArith.parseError).toBeNull()
			expect(escapedArith.commands).toEqual(["echo $(( $(cat <\\\n(printf a\\ #c)) ))", "cat", "printf a #c"])
			const comment = parseCommand("echo $(cat <\\\n(printf x # )y\n))\n")
			expect(comment.parseError).toBeNull()
			expect(comment.commands).toEqual(["echo", "cat", "printf x"])
			const commentNested = parseCommand("echo ${x:-$(cat <\\\n(printf x # )y\n))}\n")
			expect(commentNested.parseError).toBeNull()
			expect(commentNested.commands).toEqual(["echo ${x:-$(cat <\\\n(printf x # )y\n))}", "cat", "printf x"])
			// Drop guard: dedup must remove the duplicate emission, not a real
			// segment. A fix that dropped the payload (or the host word) instead
			// of its second emission would still produce a three-element list, so
			// each payload and host word is additionally asserted to appear
			// exactly once.
			const countSegments = (list: string[], segment: string): number =>
				list.filter((command) => command === segment).length
			expect(countSegments(outNested.commands, "printf b > b.marker")).toBe(1)
			expect(countSegments(outNested.commands, "cat")).toBe(1)
			expect(countSegments(commentNested.commands, "printf x")).toBe(1)
			expect(countSegments(commentNested.commands, "cat")).toBe(1)
			const braceNested = parseCommand("echo ${x:-a$\\\n{y:-2}}")
			expect(braceNested.parseError).toBeNull()
			expect(braceNested.commands).toEqual(["echo ${x:-a$\\\n{y:-2}}"])
			const bracePayload = parseCommand("echo ${x:-$\\\n{y:$(printf X > x.marker)}}")
			expect(bracePayload.parseError).toBeNull()
			expect(bracePayload.commands).toEqual(["echo ${x:-$\\\n{y:$(printf X > x.marker)}}", "printf X > x.marker"])
		})

		it("routes arithmetic payloads through the directly enclosing expansion", () => {
			// The arithmetic branch delivers its collected payloads only when a
			// parameter expansion is the frame directly enclosing it. Payloads
			// deeper in a chain arrive when the enclosing frame's text is
			// re-scanned, so an unconditional push would emit them a second
			// time, and skipping the directly-enclosing case would drop them.
			const arithInParam = parseCommand("echo ${p:-$(( $(printf b) * 1 ))}\n")
			expect(arithInParam.parseError).toBeNull()
			expect(arithInParam.commands).toEqual(["echo ${p:-$(( $(printf b) * 1 ))}", "printf b"])
			const arithInSubInParam = parseCommand("echo ${p:-$(echo $(( $(printf d) * 1 )))}\n")
			expect(arithInSubInParam.parseError).toBeNull()
			expect(arithInSubInParam.commands).toEqual([
				"echo ${p:-$(echo $(( $(printf d) * 1 )))}",
				"echo $(( $(printf d) * 1 ))",
				"printf d",
			])
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
				// continues the word. The expansion travels verbatim with its
				// placeholder. A closer picked as `)` or `]` for the `{` frame
				// never pops it, changing the masked bytes and the split.
				name: "closes a { frame at its } closer in the remainder",
				input: "cat <<E ${a}$(b)#c\nbody\nE\n",
				commands: ["cat <<E\nbody\nE ${a}$ ( b ) #c", "b"],
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

		// The next rows pin how the comment-onset scan reads a `#` glued to a
		// closer, and the delimiter's continuation rule. A `#` glued directly
		// after the closer that ends a substitution frame continues the word:
		// bash ends the region at its closer but not the word, so a comment
		// there never starts and the text behind the `#` stays live syntax. A
		// `)` that closes no frame is an operator token, and the next `#` is
		// at a word start. Separately, bash removes a backslash-newline pair
		// as a line continuation before tokenizing, so such a pair inside the
		// delimiter word never quotes the body.
		it("extracts a substitution behind a # glued to a $( … ) closer", () => {
			// bash prints `ab#c` for `echo a$(echo b)#c`: the glued `#` is
			// mid-word, so `$(zap y)` executes. Dropping the frame bookkeeping
			// reads the `#` as a word-start comment and swallows the payload.
			const { commands, parseError } = parseCommand("cat <<E $(echo x)#$(zap y)\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE $ ( echo x ) #$ ( zap y )", "echo x", "zap y"])
		})

		it("extracts a substitution behind a # glued to a $(( )) closer", () => {
			// bash prints `a2#c` for `echo a$((1+1))#c`: the arithmetic frame's
			// second `)` empties the frames, so the glued `#` continues the
			// word. A frame that closes at the first `)` lands the closer
			// early and turns the `#` into a word-start comment.
			const { commands, parseError } = parseCommand("cat <<E $((1+1))#$(zap y)\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE $ ( ( 1+1 ) ) #$ ( zap y )", "zap y"])
		})

		it("extracts a substitution behind a # glued to a backtick closer", () => {
			// bash prints `ab#c` for `` echo a`echo b`#c ``: a backtick closer
			// ends the region, not the word, so the glued `#` is word content
			// and the `$(zap y)` behind it stays live syntax. A backtick before
			// the `#` is neither a blank nor an operator, so it is no word start.
			const { commands, parseError } = parseCommand("cat <<E `echo a`#$(zap y)\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE `echo a`#$ ( zap y )", "echo a", "zap y"])
		})

		it("extracts a substitution behind a # glued to a chained process-sub closer", () => {
			// Each `>(…)` pops one frame; only the final `)` empties the stack,
			// so that closer marks the word-continuation index and the glued
			// `#$(zap y)` stays live. Marking an inner pop instead reads the
			// chain's tail as a comment.
			const { commands, parseError } = parseCommand("cat <<E >(a)>(b)#$(zap y)\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE >( a ) >( b ) #$ ( zap y )", "a", "b", "zap y"])
		})

		it("keeps a # glued to a bare group closer as a comment onset", () => {
			// bash balances the `; (echo x)` group before the `#`: the `)`
			// closes no frame, so the glued `#` opens a comment and `$(zap y)`
			// never runs. Treating every `)` as a word-continuation would
			// extract a payload bash discards.
			const { commands, parseError } = parseCommand("cat <<E ;(echo x)#$(zap y)\nbody\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\nbody\nE", "( echo x )"])
		})

		// The onset scan mirrors the remainder walk's frame stack byte for byte.
		// Each row below fails if the scan's bookkeeping drifts on one
		// construct: a wrong closer index, a frame that pops (or fails to pop)
		// at the wrong byte, or a mismatched frame type.
		type OnsetFrameRow = {
			name: string
			input: string
			commands: string[]
			error: "heredoc" | "backtick" | "command-substitution" | "process-substitution" | null
		}
		const onsetFrameRows: OnsetFrameRow[] = [
			{
				name: "reads a # inside an open backtick region as opaque region text",
				input: "cat <<'E' ` #a`y\na`b\nE\n",
				commands: ["cat <<'E'\na`b\nE `"],
				error: null,
			},
			{
				name: "keeps a word-start # inside a nested backtick region from cutting the remainder",
				input: "cat <<'E' $( `a #b` )#c\na`b\nE\n",
				commands: ["cat <<'E'\na`b\nE $ ( `a", "a"],
				error: null,
			},
			{
				name: "keeps the empty backtick region's closer from marking a later comment",
				input: "cat <<'E' $( ``) #`\nbody\nE\n",
				commands: ["cat <<'E'\nbody\nE $ ( `` )"],
				error: null,
			},
			{
				name: "fails closed on a quote that opens inside an unclosed frame",
				input: "cat <<E $($()##'\nb'ody\nE\n",
				commands: ["cat <<E $($()##'\nb'ody\nE\n"],
				error: "command-substitution",
			},
			{
				name: "extracts a payload behind a # glued to the group-balanced closer",
				input: "cat <<'E' $( ((a)) )#$(zap)\nbody\nE\n",
				commands: ["cat <<'E'\nbody\nE $ ( ( ( a ) ) ) #$ ( zap )", "( ( a ) )", "zap"],
				error: null,
			},
			{
				name: "keeps a brace mismatch from letting an inner closer end the frame",
				input: "cat <<'E' $( $({a) ))#$(zap)\nbody\nE\n",
				commands: ["cat <<'E'\nbody\nE $ ( $ ( {a ) ) )", "{a"],
				error: null,
			},
			{
				name: "keeps a # after a bare-dollar group closer from swallowing the tail",
				input: "cat <<E $$()#`\nbody\nE\n",
				commands: ["cat <<E $$()#`\nbody\nE\n"],
				error: "backtick",
			},
			{
				name: "fails closed on the opener the brace frame cannot balance",
				input: "cat <<E $(${)#$[\nbody\nE\n",
				commands: ["cat <<E $(${)#$[\nbody\nE\n"],
				error: "command-substitution",
			},
			{
				name: "extracts a payload behind a # glued to a bracket frame holding a group paren",
				input: "cat <<'E' $( $[(] )#$(zap)\nbody\nE\n",
				commands: ["cat <<'E'\nbody\nE $ ( $[ ( ] ) #$ ( zap )", "$[(]", "zap"],
				error: null,
			},
			{
				name: "reads the arithmetic opener from its own bytes inside a group frame",
				input: "cat <<E $(($[(x]))#$(zap y)\nbody\nE\n",
				commands: ["cat <<E\nbody\nE $ ( ( $[ ( x] ) ) #$ ( zap y )", "( $[(x] )", "zap y"],
				error: null,
			},
			{
				name: "keeps a # riding a closer after a brace mismatch from cutting the tail",
				input: "cat <<'E' $( $({a) )#$(zap)\nbody\nE\n",
				commands: ["cat <<'E'\nbody\nE $ ( $ ( {a ) ) #$ ( zap )", "{a", "zap"],
				error: null,
			},
			{
				name: "extracts a payload behind a # glued to the closer after a parameter expansion",
				input: "cat <<'E' $( ${a} )#$(zap)\nbody\nE\n",
				commands: ["cat <<'E'\nbody\nE $ (  ) #$ ( zap )", "${a}", "zap"],
				error: null,
			},
			{
				name: "fails closed on a word-start quote after a process-substitution closer",
				input: "cat <<'E' <()#'\nb'ody\nE\n",
				commands: ["cat <<'E' <()#'\nb'ody\nE\n"],
				error: "heredoc",
			},
			{
				name: "reads a # between a redirect and a paren as no process substitution",
				input: "cat <<'E' <#(`\na`b\nE\n",
				commands: ["cat <<'E'\na`b\nE <"],
				error: null,
			},
			{
				name: "fails closed on an unclosed process substitution before a word-start quote",
				input: "cat <<'E' <(#'\nb'ody\nE\n",
				commands: ["cat <<'E' <(#'\nb'ody\nE\n"],
				error: "process-substitution",
			},
			{
				name: "keeps a backslash-escaped delimiter opaque even with an empty word",
				input: "cat <<\\E\na`b\nE\n",
				commands: ["cat <<\\E\na`b\nE"],
				error: null,
			},
		]

		it.each(onsetFrameRows)("$name", ({ input, commands, error }) => {
			const result = parseCommand(input)
			expect(result.commands).toEqual(commands)
			expect(result.parseError?.quoteType ?? null).toBe(error)
		})

		it("walks the body of a heredoc whose delimiter ends in a backslash-newline", () => {
			// bash removes the backslash-newline pair as a line continuation
			// before tokenizing, leaving an ordinary unquoted delimiter, so it
			// expands `$(touch x)` in the body. Reading the backslash as a
			// quoting construct masks the body and hides the payload.
			const { commands, parseError } = parseCommand("cat <<E\\\n\n$(touch x)\nE")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["cat <<E\\\n\n$(touch x)\nE", "touch x"])
		})

		it("fails closed when a delimiter continuation swallows the body's first line", () => {
			// One newline is consumed by the continuation, so bash joins
			// `$(touch x)` onto the opener line: the body then has no first
			// line before the substitution and no terminator can match. The
			// parser cannot account for the joined bytes, so it fails closed.
			const input = "cat <<E\\\n$(touch x)\nE"
			const { commands, parseError } = parseCommand(input)
			expect(commands).toEqual([input])
			expect(parseError?.quoteType).toBe("heredoc")
		})

		it("fails closed when a delimiter backslash escapes a CR", () => {
			// POSIX bash reads `\<CR>` as an escaped CR -- a quoting construct
			// the msys read layer instead strips -- so the two models disagree
			// on whether the body is quoted. A CR inside the region leaves the
			// layers reading different bytes, and the heredoc fails closed
			// without picking a model.
			const input = "cat <<E\\\r\n$(touch x)\r\nE\r\n"
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
			expect(structuralError("echo $(x")).toEqual(
				expect.objectContaining({ quoteType: "command-substitution", openIndex: 5 }),
			)
			expect(structuralError("echo `x")).toEqual(expect.objectContaining({ quoteType: "backtick", openIndex: 5 }))
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
			expect(structuralError("echo $(( x")?.quoteType).toBe("arithmetic")
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
			// Without any depth-1 closer nothing closes the inner `(`, so the opener stays arithmetic.
			const unclosed = parseCommand("echo $((rm -rf /")
			expect(unclosed.commands).toEqual(["echo $((rm -rf /"])
			expect(unclosed.parseError?.quoteType).toBe("arithmetic")
			// With a closer that never doubles, the converted frame is the
			// outermost construct that cannot close.
			const halfClosed = parseCommand("echo $((rm -rf /) ")
			expect(halfClosed.commands).toEqual(["echo $((rm -rf /) "])
			expect(halfClosed.parseError?.quoteType).toBe("command-substitution")
		})

		it("ignores a single-quoted ) while counting arithmetic parentheses", () => {
			// bash reads the `'` here as a quote, so its `)` is quoted text and
			// cannot look like the arithmetic closer. The expression stays
			// arithmetic and the inner substitution is extracted as its own
			// segment. A counter that reads the quoted `)` as a closer trips the
			// closer-adjacency re-route and degrades the command to a group
			// segment bash never runs.
			const { commands, parseError } = parseCommand("echo $(( $(printf 1 ')') + 1 ))")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo $(( $(printf 1 ')') + 1 ))", "printf 1 ')'"])
		})

		it("ignores parens inside quoted text and nested substitution bodies when counting", () => {
			// Double quotes, nested `$(` bodies, and nested `${…}` regions are
			// each read with the shell's own matching rules, so their parens
			// never enter the arithmetic depth. Controls: the adjacency re-route
			// still fires for a mis-nested `$(( … ) … )`, and well-formed
			// arithmetic stays masked.
			const dq = parseCommand('echo $(( $(echo "1)" | cut -c1) + 1 ))')
			expect(dq.parseError).toBeNull()
			expect(dq.commands).toEqual(['echo $(( $(echo "1)" | cut -c1) + 1 ))', 'echo "1)"', "cut -c1"])
			// Frame call site: the nested arithmetic closes inside the frame.
			const frame = parseCommand("echo $( x=$(( $(printf '%d' 2) + 1 )); echo $x )")
			expect(frame.parseError).toBeNull()
			expect(frame.commands).toEqual(["echo", "x=$(( $(printf '%d' 2) + 1 ))", "printf '%d' 2", "echo $x"])
			// Body call site.
			const body = parseCommand("cat <<EOF\necho $(( $(printf '%d' 2) + 1 ))\nEOF")
			expect(body.parseError).toBeNull()
			expect(body.commands).toEqual(["cat <<EOF\necho $(( $(printf '%d' 2) + 1 ))\nEOF", "printf '%d' 2"])
			// Controls: the depth-1 closer that is not doubled is still bash's
			// `$(`-plus-group reading, and balanced arithmetic stays masked.
			expect(parseCommand("echo $((rm -rf /) )").commands).toEqual(["echo", "( rm -rf / )"])
			expect(parseCommand("echo $((1 + (2) ))").commands).toEqual(["echo $((1 + (2) ))"])
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
			// The main scan applies the same word-start comment rule inside
			// substitution frames as the body walk. The comment hides the first
			// line's `)`, the frame stays open across the newline, and the second
			// line's `)` is the shell's own closer. The payload re-scan comments
			// its first line too, so `curl evil` surfaces without a closer
			// remnant.
			const input = "$( echo ok # )\ncurl evil)"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo ok", "curl evil"])
		})

		it("does not open a substitution from a $( inside a comment within an open substitution frame", () => {
			// bash discards the comment bytes before parsing, so the `$(x` inside
			// the comment never opens a frame. The frame closes at the second
			// line's `)` and only `echo ok` ever runs. A frame scan that reads
			// the commented `$(` as live opens a second frame that the `)`
			// closes at the wrong place, leaving the outer frame open and
			// refusing this valid input as malformed.
			const { commands, parseError } = parseCommand("echo $( echo ok # $(x\n)")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo", "echo ok"])
			// A process-substitution frame takes the rule too: bash prints `hi`.
			const proc = parseCommand("cat <( echo hi # decoy\n)")
			expect(proc.parseError).toBeNull()
			expect(proc.commands).toEqual(["cat", "echo hi"])
		})

		it("closes a frame at the shell's closer when a word-start comment hides a decoy )", () => {
			// The comment's `)` is discarded before parsing, so the frame's only
			// real closer is the second line's `)`. Each executed line becomes its
			// own segment. A frame whose comment hides the only closer still
			// fails closed, like bash's own unexpected-EOF refusal.
			const { commands, parseError } = parseCommand("$( echo a # decoy )\necho b )")
			expect(parseError).toBeNull()
			expect(commands).toEqual(["echo a", "echo b"])
			const swallowed = parseCommand("$( echo # )")
			expect(swallowed.commands).toEqual(["$( echo # )"])
			expect(swallowed.parseError?.quoteType).toBe("command-substitution")
			// The rule stays confined to substitution frame kinds: `#` inside
			// `${…}` is operator syntax, not a comment.
			expect(parseCommand("echo ${#x}").parseError).toBeNull()
			expect(parseCommand("echo ${x#pat}").parseError).toBeNull()
		})

		it("does not open a substitution at a `$(` inside a body comment", () => {
			// The body comment hides an unclosed `$(`, so the frame's closer is
			// the next line's `)`. Reading the comment as live instead would
			// open a second frame the `)` closes at the wrong place.
			const input = "cat <<EOF\n$( echo ok # $(x\n)\nEOF"
			const { commands, parseError } = parseCommand(input)
			expect(parseError).toBeNull()
			expect(commands).toEqual([input, "echo ok"])
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

	describe("heredoc delimiters with undeterminable terminators fail closed", () => {
		// A quote character inside the delimiter word opens a quote region. bash
		// carries that region across newlines until its closing quote. A word
		// that still has a region open at end of input is a delimiter that no
		// body line can ever match. The opener line's tail keeps executing as
		// ordinary syntax. This is exactly where a mask to end of input would
		// hand bash's separate commands to the allowlists unaccounted for. A
		// delimiter is equally unresolvable when bash applies a quote removal
		// the walk does not reproduce (ANSI-C/locale rows below).

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

		// bash applies ANSI-C/locale quote removal to the delimiter word before
		// matching it against a terminator line. The delimiter walk pairs raw
		// quote bytes, so it reads `$'EOF'` as the terminator `$EOF` while bash
		// closes the heredoc at the real `EOF` line — and executes everything
		// after it. The terminator cannot be determined from the walk, so the
		// construct fails closed instead of masking bash's live commands.
		it("fails closed on an ANSI-C quoted delimiter word (bash executes the tail)", () => {
			// With `cat` allowlisted, masking the body would auto-approve this
			// input while bash runs the `rm` after the real terminator as its own
			// command. Refused input returns the raw bytes verbatim as the one
			// host word, and the decision layer fails closed on the parse error.
			const input = "cat <<$'EOF'\nbody\nEOF\nrm -rf /tmp/target\n$EOF\n"
			const { commands, parseError } = parseCommand(input)
			expect(parseError?.quoteType).toBe("heredoc")
			expect(commands).toEqual([input])
		})

		it("fails closed on a locale-quoted delimiter word", () => {
			// `$"EOF"` is the locale-quoted sibling: bash performs locale quote
			// removal, so the heredoc closes at the `EOF` line and the `printf`
			// after it executes. Same undeterminable terminator, same refusal.
			const input = 'cat <<$"EOF"\nbody\nEOF\nprintf RAN > ran.marker\n$EOF\n'
			const { commands, parseError } = parseCommand(input)
			expect(parseError?.quoteType).toBe("heredoc")
			expect(commands).toEqual([input])
		})

		it("fails closed on concatenated, blank-separated, and substitution-framed ANSI-C delimiters", () => {
			// The scan flags an unquoted ANSI-C quote start at any position in
			// the delimiter word, so these shapes all refuse: a concatenation
			// after the ANSI-C word (`$'EO'F` removes to `EOF`), a blank
			// between `<<` and the word, and a heredoc opened inside a
			// substitution frame, whose error propagates the same way an
			// unclosed quote's does.
			const concat = parseCommand("cat <<$'EO'F\nbody\nEOF\nprintf RAN > ran.marker\n$EOF\n")
			expect(concat.parseError?.quoteType).toBe("heredoc")
			expect(concat.commands).toEqual(["cat <<$'EO'F\nbody\nEOF\nprintf RAN > ran.marker\n$EOF\n"])
			const spaced = parseCommand("cat << $'EOF'\nbody\nEOF\nprintf RAN > ran.marker\n$EOF\n")
			expect(spaced.parseError?.quoteType).toBe("heredoc")
			expect(spaced.commands).toEqual(["cat << $'EOF'\nbody\nEOF\nprintf RAN > ran.marker\n$EOF\n"])
			const framed = parseCommand("echo $(cat <<$'EOF'\nbody\nEOF\nprintf RAN > ran.marker\n$EOF\n)\n")
			expect(framed.parseError?.quoteType).toBe("heredoc")
			expect(framed.commands).toEqual(["echo $(cat <<$'EOF'\nbody\nEOF\nprintf RAN > ran.marker\n$EOF\n)\n"])
		})

		it("fails closed on mid-word ANSI-C and locale concatenation delimiters", () => {
			// bash removes ANSI-C/locale quotes at any unquoted occurrence in
			// the delimiter word, so each word below closes the heredoc at the
			// quote-removed text — a line the delimiter walk never derives —
			// and runs the tail after it as its own command. Refusing keeps the
			// raw bytes unapprovable.
			const shape = (input: string) => {
				const { commands, parseError } = parseCommand(input)
				expect(parseError?.quoteType).toBe("heredoc")
				expect(commands).toEqual([input])
			}
			// `a$'X'Y` removes to `aXY`; `a$"X"Y` is the locale twin; `'a'$'X'`
			// concatenates a plain-quoted piece before the ANSI-C piece;
			// `x$'EOF'` matches its quote-removed `xEOF` line mid-file.
			shape("cat <<a$'X'Y\nbody\naXY\nprintf RAN > ran.marker\na$XY\n")
			shape('cat <<a$"X"Y\nbody\naXY\nprintf RAN > ran.marker\na$XY\n')
			shape("cat <<'a'$'X'\nbody\naX\nprintf RAN > ran.marker\na$X\n")
			shape("cat <<x$'EOF'\nbody\nxEOF\nprintf RAN > ran.marker\nx$EOF\n")
		})

		it("fails closed on the tab-form and continuation mid-word ANSI-C delimiters", () => {
			// The scan covers the delimiter word after the `<<-` strip and the
			// opener's blank skip, so the tab-indented form refuses like the
			// plain one. A backslash-newline pair joins the next line into the
			// word before bash tokenizes it, and the joined word still carries
			// the unquoted ANSI-C occurrence.
			const tabForm = parseCommand("cat <<-\tx$'EOF'\nbody\n\txEOF\nprintf RAN > ran.marker\nx$EOF\n")
			expect(tabForm.parseError?.quoteType).toBe("heredoc")
			expect(tabForm.commands).toEqual(["cat <<-\tx$'EOF'\nbody\n\txEOF\nprintf RAN > ran.marker\nx$EOF\n"])
			const joined = parseCommand("cat <<a$'X'\\\nY\nbody\naXY\nprintf RAN > ran.marker\na$XY\n")
			expect(joined.parseError?.quoteType).toBe("heredoc")
			expect(joined.commands).toEqual(["cat <<a$'X'\\\nY\nbody\naXY\nprintf RAN > ran.marker\na$XY\n"])
		})

		it("fails closed when a line continuation joins a delimiter's dollar to a quote byte", () => {
			// bash removes backslash-newline line continuations before
			// tokenizing, so the `$` and the quote byte of a `$'`/`$"`
			// occurrence can sit on separate physical lines. bash joins the
			// bytes and removes the quotes before matching the delimiter word
			// against a terminator line, so each word below closes the heredoc
			// at the joined quote-removed text — a line the terminator search
			// never derives from the physical lines — and runs the tail after
			// it as its own command. The `<<-` tab form is scanned after the
			// strip, and a word whose dollar follows a closed quote region
			// reaches the scan unquoted.
			const shape = (input: string) => {
				const { commands, parseError } = parseCommand(input)
				expect(parseError?.quoteType).toBe("heredoc")
				expect(commands).toEqual([input])
			}
			shape("cat <<a$\\\n'b'\nbody\nab\nprintf RAN > ran.marker\na$b\n")
			shape('cat <<a$\\\n"b"\nbody\nab\nprintf RAN > ran.marker\na"b"\n')
			shape("cat <<'x'$\\\n'b'\nbody\nxb\nprintf RAN > ran.marker\nx$b\n")
			shape("cat <<-a$\\\n'b'\nbody\n\tab\nprintf RAN > ran.marker\n\ta$b\n")
		})

		it("fails closed when stacked or escaped-backslash continuations join a delimiter's dollar to a quote byte", () => {
			// bash removes each backslash-newline pair independently, so a run
			// of continuations between the `$` and the quote byte still joins
			// them. An escaped `\\` consumes only its own pair, leaving the
			// following `$` unquoted, so a continuation after it counts the
			// same way. Both words below join to carry an ANSI-C occurrence
			// and close the heredoc at the quote-removed line: refuse.
			const shape = (input: string) => {
				const { commands, parseError } = parseCommand(input)
				expect(parseError?.quoteType).toBe("heredoc")
				expect(commands).toEqual([input])
			}
			shape("cat <<a$\\\n\\\n'b'\nbody\nab\nprintf RAN > ran.marker\na$b\n")
			shape("cat <<a\\\\$\\\n'b'\nbody\na\\b\nprintf RAN > ran.marker\na\\$b\n")
		})

		it("keeps a delimiter whose dollar a surviving byte holds from the joined quote parsing", () => {
			// Continuation removal deletes exactly the two bytes of a
			// backslash-newline pair. A space after the pair survives, so
			// bash sees `$` and `'` apart: the delimiter word stays `a$`, the
			// quote on the joined line belongs to a later word, and the
			// heredoc closes at the matching `a$` line. The terminator stays
			// determinable, so the occurrence test must end its continuation
			// skip at any byte the removal leaves standing — even a plain
			// newline that no backslash joins.
			const joined = parseCommand("cat <<a$\\\n 'b'\nbody\na$\nprintf RAN > ran.marker\n")
			expect(joined.parseError).toBeNull()
			expect(joined.commands).toEqual(["cat <<a$\\\n\nbody\na$ b", "printf RAN > ran.marker"])
			const spaced = parseCommand("cat <<a$ \n'b'\nbody\na$\nprintf RAN > ran.marker\n")
			expect(spaced.parseError).toBeNull()
			expect(spaced.commands).toEqual(["cat <<a$\n'b'\nbody\na$", "printf RAN > ran.marker"])
		})

		it("reports a chained malformed delimiter at its own opener", () => {
			// A chained opener's un-closeable delimiter word fails its own
			// heredoc: the error names the chained construct's opener position,
			// not the first heredoc on the line.
			const { parseError } = parseCommand("cat <<A <<'x\nbody\nA\nprintf RAN > ran.marker\n")
			expect(parseError?.quoteType).toBe("heredoc")
			expect(parseError?.openIndex).toBe(8)
		})

		it("keeps escaped-dollar and in-quote-dollar delimiter words parsing", () => {
			// Precision controls: bash treats an escaped `\$` as a literal
			// dollar and a `$` inside a quote region as ordinary word content,
			// and the walk derives both words exactly, so the terminator stays
			// determinable and these words keep parsing. An escaped backslash
			// after an unquoted dollar keeps its own pair, so the following
			// quote belongs to a later word, not to the dollar: the word stays
			// `a$\X`, no ANSI-C occurrence exists, and only a continuation pair
			// -- never a lone `\\` -- may join bytes in the occurrence test.
			const escaped = parseCommand("cat <<\\$'X'\nbody\n$X")
			expect(escaped.parseError).toBeNull()
			expect(escaped.commands).toEqual(["cat <<\\$'X'\nbody\n$X"])
			const escapedBackslash = parseCommand("cat <<a$\\\\'X'\nbody\na$\\X")
			expect(escapedBackslash.parseError).toBeNull()
			expect(escapedBackslash.commands).toEqual(["cat <<a$\\\\'X'\nbody\na$\\X"])
			const quotedDollar = parseCommand("cat <<'EOF$'\nbody\nEOF$")
			expect(quotedDollar.parseError).toBeNull()
			expect(quotedDollar.commands).toEqual(["cat <<'EOF$'\nbody\nEOF$"])
			const dqDollar = parseCommand(`cat <<a"$'x'"\nbody\na$'x'`)
			expect(dqDollar.parseError).toBeNull()
			expect(dqDollar.commands).toEqual([`cat <<a"$'x'"\nbody\na$'x'`])
		})

		it("refuses mid-word ANSI-C concatenation and leaves ordinary quoting untouched", () => {
			// The scan fires on any unquoted `$'`/`$"` occurrence in the
			// delimiter word. Plain quoting constructs, a body merely
			// containing a `$'EOF'` line, and a bare `$VAR` at word start keep
			// parsing; the unclosed mixed quote still fails closed through the
			// open-region rule, not through this scan.
			const sq = parseCommand("cat <<'EOF'\nbody\nprintf RAN > ran.marker\nEOF")
			expect(sq.parseError).toBeNull()
			expect(sq.commands).toEqual(["cat <<'EOF'\nbody\nprintf RAN > ran.marker\nEOF"])
			const dq = parseCommand('cat <<"EOF"\nbody\nprintf RAN > ran.marker\nEOF')
			expect(dq.parseError).toBeNull()
			expect(dq.commands).toEqual(['cat <<"EOF"\nbody\nprintf RAN > ran.marker\nEOF'])
			const mixed = parseCommand(`cat <<"EOF'\nbody\nEOF`)
			expect(mixed.parseError?.quoteType).toBe("heredoc")
			expect(mixed.commands).toEqual([`cat <<"EOF'\nbody\nEOF`])
			const midWord = parseCommand("cat <<a$'b'\nbody\na$b")
			expect(midWord.parseError?.quoteType).toBe("heredoc")
			expect(midWord.commands).toEqual(["cat <<a$'b'\nbody\na$b"])
			const midWordLocale = parseCommand('cat <<a$"b"\nbody\na$b')
			expect(midWordLocale.parseError?.quoteType).toBe("heredoc")
			expect(midWordLocale.commands).toEqual(['cat <<a$"b"\nbody\na$b'])
			const bodyLine = parseCommand("cat <<EOF\nbody\n$'EOF'\nprintf RAN > ran.marker\nEOF")
			expect(bodyLine.parseError).toBeNull()
			expect(bodyLine.commands).toEqual(["cat <<EOF\nbody\n$'EOF'\nprintf RAN > ran.marker\nEOF"])
			// A `$` without a quote byte after it is a variable expansion, not
			// the ANSI-C quoting start: the scan must not fire on it.
			const bareVar = parseCommand("cat <<$EOF\nbody\n$EOF")
			expect(bareVar.parseError).toBeNull()
			expect(bareVar.commands).toEqual(["cat <<$EOF\nbody\n$EOF"])
		})

		it("keeps a chained ANSI-C delimiter refused and a quoted chain's tail visible", () => {
			// bash strips the ANSI-C quotes from a chained delimiter too, so the
			// `$'A'` chain must stay refused; the guard now refuses it at the
			// delimiter itself. The quoted twin is ordinary chained syntax: it
			// keeps parsing, and the tail after the last terminator reaches its
			// own segment for the deny surface.
			const chain = parseCommand("cat <<$'A' <<B\na1\nA\nb1\nB\nprintf RAN > ran.marker")
			expect(chain.parseError?.quoteType).toBe("heredoc")
			expect(chain.commands).toEqual(["cat <<$'A' <<B\na1\nA\nb1\nB\nprintf RAN > ran.marker"])
			const quotedChain = parseCommand("cat <<'A' <<B\na1\nA\nb1\nB\nprintf RAN > ran.marker")
			expect(quotedChain.parseError).toBeNull()
			expect(quotedChain.commands).toEqual(["cat <<'A'\na1\nA\nb1\nB << B", "printf RAN > ran.marker"])
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

		it("fails closed on masked placeholders when the tokenizer throws", () => {
			forceShellQuoteFailure = true
			try {
				const input = "echo $((1+1)) && cat <<EOF\nbody\nEOF"
				const { commands, parseError } = parseCommand(input)
				// The masked host text carries no active shell syntax, so a
				// tokenizer rejection means the decomposition cannot account for
				// this line. The raw input stays one opaque token: no fragment of
				// a partial split can be approved in isolation.
				expect(commands).toEqual([input])
				expect(parseError?.quoteType).toBe("tokenize-failure")
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

		it("fails closed on a substitution placeholder when the tokenizer throws", () => {
			forceShellQuoteFailure = true
			try {
				const input = "echo $(whoami) && cat <<EOF\nbody\nEOF"
				const { commands, parseError } = parseCommand(input)
				// An operator split would restore the masked substitution's
				// inner text inline, letting the substitution's command ride a
				// word that could match its host's allowlist prefix — so a
				// tokenizer rejection fails the whole command closed.
				expect(commands).toEqual([input])
				expect(parseError?.quoteType).toBe("tokenize-failure")
				expect(commands.join("")).not.toContain("\x00")
			} finally {
				forceShellQuoteFailure = false
			}
		})
	})
})
