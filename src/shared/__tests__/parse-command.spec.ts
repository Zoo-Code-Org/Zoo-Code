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
			expect(parseCommand("")).toEqual([])
			expect(parseCommand("   ")).toEqual([])
		})

		it("returns a single command unchanged", () => {
			expect(parseCommand("git status")).toEqual(["git status"])
		})

		it("splits on &&", () => {
			expect(parseCommand("git add . && git commit")).toEqual(["git add .", "git commit"])
		})

		it("splits on ||, ;, and |", () => {
			expect(parseCommand("a || b")).toEqual(["a", "b"])
			expect(parseCommand("a ; b")).toEqual(["a", "b"])
			expect(parseCommand("a | b")).toEqual(["a", "b"])
		})
	})

	describe("genuine multi-statement scripts (unquoted newlines)", () => {
		it("splits unquoted newlines into separate sub-commands", () => {
			const input = "echo a\necho b\necho c"
			expect(parseCommand(input)).toEqual(["echo a", "echo b", "echo c"])
		})

		it("handles Windows and old-Mac line endings", () => {
			expect(parseCommand("echo a\r\necho b")).toEqual(["echo a", "echo b"])
			expect(parseCommand("echo a\recho b")).toEqual(["echo a", "echo b"])
		})

		it("ignores blank lines", () => {
			expect(parseCommand("echo a\n\n\necho b")).toEqual(["echo a", "echo b"])
		})
	})

	describe("newlines inside single-quoted strings", () => {
		it("treats a multi-line single-quoted argument as one command", () => {
			const input = "sh -c 'echo a\necho b'"
			expect(parseCommand(input)).toEqual(["sh -c 'echo a\necho b'"])
		})

		it("does not split operators that appear inside single quotes", () => {
			const input = "sh -c 'echo a && echo b | grep x'"
			expect(parseCommand(input)).toEqual(["sh -c 'echo a && echo b | grep x'"])
		})

		it("preserves the embedded newline in the restored command", () => {
			const input = "sh -c 'echo 1\necho 2'"
			const result = parseCommand(input)
			expect(result).toEqual(["sh -c 'echo 1\necho 2'"])
			expect(result[0]).toContain("\n")
		})
	})

	describe("ANSI-C quoting ($'...')", () => {
		it("does not leak a placeholder for a $'...' multi-line argument", () => {
			const input = "sh -c $'echo 1\necho 2'"
			const result = parseCommand(input)
			// The placeholder used internally must never appear in the output.
			expect(result.join(" ")).not.toContain("SQUOTE")
			expect(result.join(" ")).not.toContain("__")
		})

		// An escaped apostrophe inside an ANSI-C string must not terminate the
		// quoted region early; otherwise a following newline would leak out and
		// split the single command into bogus sub-commands.
		it("treats a $'...' argument with an escaped apostrophe and newline as one command", () => {
			const input = "sh -c $'echo \\'1\\'\necho 2'"
			const result = parseCommand(input)
			expect(result).toEqual([input])
			expect(result.join(" ")).not.toContain("SQUOTE")
			expect(result.join(" ")).not.toContain("__")
		})
	})

	describe("newlines inside double-quoted strings", () => {
		it("treats a multi-line double-quoted argument as one command", () => {
			const input = 'sh -c "echo a\necho b"'
			expect(parseCommand(input)).toEqual(['sh -c "echo a\necho b"'])
		})

		it("does not split operators that appear inside double quotes", () => {
			const input = 'sh -c "echo a && echo b | grep x"'
			expect(parseCommand(input)).toEqual(['sh -c "echo a && echo b | grep x"'])
		})

		it("handles escaped quotes inside a double-quoted string", () => {
			const input = 'sh -c "echo \\"hello world\\""'
			expect(parseCommand(input)).toEqual(['sh -c "echo \\"hello world\\""'])
		})
	})

	describe("mixed quote styles", () => {
		it("does not let an apostrophe inside double quotes start a single-quoted region", () => {
			const input = `echo "don't" && echo ok`
			expect(parseCommand(input)).toEqual([`echo "don't"`, "echo ok"])
		})

		it("does not let a double quote inside single quotes start a double-quoted region", () => {
			const input = `echo 'a " b' && echo ok`
			expect(parseCommand(input)).toEqual([`echo 'a " b'`, "echo ok"])
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
			const result = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[result.length - 1]).toBe("echo world")
		})

		it("does not let a double-quote inside a # comment hide the newline before the next command", () => {
			// The unmatched double quote in the comment must not absorb the newline.
			const input = `echo hello # say "hi\necho world`
			const result = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[result.length - 1]).toBe("echo world")
		})

		// A comment quote that could otherwise pair with a quote several lines
		// down must not swallow the intervening newlines. Every command stays
		// separate so each is evaluated on its own, and the comment tail itself
		// is discarded (it is not part of any executable command).
		it("keeps every command separate when an earlier comment contains a quote", () => {
			const input = "echo first # what's here\necho middle\necho 'done'"
			const result = parseCommand(input)
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

			const result = parseCommand(input)
			expect(result).toHaveLength(1)
			expect(result[0]).toBe(input)
		})
	})

	describe("subshells still split", () => {
		it("extracts subshell content as separate commands", () => {
			const result = parseCommand("echo $(whoami)")
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

			const result = parseCommand("sh -c $'echo hi' && echo done")
			expect(result).toEqual(["sh -c $'echo hi'", "echo done"])
			expect(result.join(" ")).not.toContain("SQUOTE")
			expect(result.join(" ")).not.toContain("__")
		})
	})

	describe("malformed input with unterminated quotes", () => {
		// A command with an unterminated quote is a shell syntax error. It must
		// be returned as a single opaque token so that an embedded newline cannot
		// surface a line as an independent, separately auto-approvable command.
		it("returns an unclosed single-quoted command as one opaque token", () => {
			const input = "sh -c 'echo test"
			expect(parseCommand(input)).toEqual([input])
		})

		it("does not split an unclosed single quote on an embedded newline", () => {
			const input = "sh -c 'echo a\necho b"
			// Without the guard, the second line would surface as a standalone
			// `echo b` even though it was meant to live inside the unclosed quote.
			expect(parseCommand(input)).toEqual([input])
		})

		it("returns an unclosed double-quoted command as one opaque token", () => {
			const input = 'sh -c "echo a\necho b'
			expect(parseCommand(input)).toEqual([input])
		})

		it("returns an unclosed ANSI-C quoted command as one opaque token", () => {
			const input = "sh -c $'echo a\necho b"
			expect(parseCommand(input)).toEqual([input])
		})

		it("treats odd-quote improper quoting as a single opaque token", () => {
			const input = "sh -c 'cmd ''\\\n"
			expect(parseCommand(input)).toEqual([input])
		})
	})

	describe("heredoc quoting", () => {
		// The entire heredoc -- opener line, body, and terminator -- must be
		// treated as a single opaque token so body lines are never split into
		// independent sub-commands for auto-approval evaluation.

		it("treats an unquoted-delimiter heredoc as one command", () => {
			const input = "sh -c bash << EOF\necho hello\nEOF"
			expect(parseCommand(input)).toEqual([input])
		})

		it("treats a single-quoted-delimiter heredoc as one command", () => {
			const input = "sh -c bash << 'EOF'\necho hello\nEOF"
			expect(parseCommand(input)).toEqual([input])
		})

		it("treats a double-quoted-delimiter heredoc as one command", () => {
			const input = 'sh -c bash << "EOF"\necho hello\nEOF'
			expect(parseCommand(input)).toEqual([input])
		})

		it("treats a backslash-escaped-delimiter heredoc as one command", () => {
			const input = "sh -c bash << \\EOF\necho hello\nEOF"
			expect(parseCommand(input)).toEqual([input])
		})

		it("treats a <<- heredoc (strip leading tabs) as one command", () => {
			// <<- allows the terminator to be indented with tabs.
			const input = "sh -c bash <<-EOF\n\techo hello\n\tEOF"
			expect(parseCommand(input)).toEqual([input])
		})

		it("does not split body lines of a multi-line heredoc", () => {
			const input = [
				"sh -c bash << 'EOF'",
				"echo line1",
				"echo line2",
				"echo line3",
				"EOF",
			].join("\n")
			expect(parseCommand(input)).toEqual([input])
		})

		it("splits a command that follows the heredoc terminator", () => {
			const input = "sh -c bash << EOF\necho hello\nEOF\necho done"
			const result = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[0]).toBe("sh -c bash << EOF\necho hello\nEOF")
			expect(result[1]).toBe("echo done")
		})

		it("treats a heredoc with a missing terminator as one opaque token", () => {
			// An unterminated heredoc is a syntax error; the whole input must be
			// returned as a single token so no body line can be auto-approved alone.
			const input = "sh -c bash << EOF\necho hello"
			expect(parseCommand(input)).toEqual([input])
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
			expect(parseCommand(input)).toEqual([input])
		})
		it("does not treat a # comment inside a heredoc body as a command separator", () => {
			// A '#' inside a heredoc body is literal text, not a shell comment.
			// The body must not be split and the comment line must be preserved.
			const input = "sh -c bash << 'EOF'\n# this is a comment\necho hello\nEOF"
			expect(parseCommand(input)).toEqual([input])
		})

		it("does not mistake << inside a # comment as a heredoc opener", () => {
			// A heredoc opener that appears inside a # comment must be ignored;
			// the following lines must still be treated as separate commands.
			const input = "echo hi # << EOF\necho world"
			const result = parseCommand(input)
			expect(result).toHaveLength(2)
			expect(result[result.length - 1]).toBe("echo world")
		})
	})

	describe("locale quoting ($\"...\")", () => {
		// Locale quoting $"..." behaves like double quotes for delimiter purposes
		// but the $ prefix is part of the token and must be preserved verbatim.

		it("treats a locale-quoted argument as one command", () => {
			const input = `echo $"hello world"`
			expect(parseCommand(input)).toEqual([input])
		})

		it("does not split on operators inside a locale-quoted string", () => {
			const input = `echo $"hello && world"`
			expect(parseCommand(input)).toEqual([input])
		})

		it("does not split on a newline inside a locale-quoted string", () => {
			const input = `echo $"hello\nworld"`
			expect(parseCommand(input)).toEqual([input])
		})

		it("preserves the $ prefix in the output without leaking placeholders", () => {
			const input = `echo $"greeting" && echo done`
			const result = parseCommand(input)
			expect(result[0]).toContain('$"greeting"')
			expect(result.join(" ")).not.toContain("__")
		})

		it("returns an unterminated locale-quoted string as one opaque token", () => {
			const input = `echo $"hello`
			expect(parseCommand(input)).toEqual([input])
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
			expect(findUnterminatedQuote("echo 'hello")).toEqual({ quoteType: "posix-single", openIndex: 5 })
		})

		it("detects an unterminated double quote and reports its opening index", () => {
			expect(findUnterminatedQuote('echo "hello')).toEqual({ quoteType: "double", openIndex: 5 })
		})

		it("reports ansi-c style and the $ position for an unterminated ANSI-C quote", () => {
			expect(findUnterminatedQuote("echo $'hello")).toEqual({ quoteType: "ansi-c", openIndex: 5 })
		})

		it("treats a backslash-escaped quote outside a string as literal", () => {
			// `echo \'` is a literal quote, not an unterminated region.
			expect(findUnterminatedQuote("echo \\'")).toBeNull()
			expect(findUnterminatedQuote('echo \\"')).toBeNull()
		})

		it("ignores a quote that appears inside a comment", () => {
			expect(findUnterminatedQuote("echo hi # it's fine")).toBeNull()
		})

		it("treats # attached to a word as an ordinary character", () => {
			expect(findUnterminatedQuote("echo foo#'bar'")).toBeNull()
			expect(findUnterminatedQuote("echo foo#'bar")).toEqual({ quoteType: "posix-single", openIndex: 9 })
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
	})
})
