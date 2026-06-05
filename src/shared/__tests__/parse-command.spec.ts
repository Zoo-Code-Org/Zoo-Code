import { parseCommand } from "../parse-command"

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
})
