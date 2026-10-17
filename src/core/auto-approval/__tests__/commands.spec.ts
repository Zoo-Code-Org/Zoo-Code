import { containsDangerousSubstitution, getCommandDecision, getCommandDecisionDetailed } from "../commands"

describe("containsDangerousSubstitution", () => {
	describe("zsh array assignments (should NOT be flagged)", () => {
		it("should return false for files=(a b c)", () => {
			expect(containsDangerousSubstitution("files=(a b c)")).toBe(false)
		})

		it("should return false for var=(item1 item2)", () => {
			expect(containsDangerousSubstitution("var=(item1 item2)")).toBe(false)
		})

		it("should return false for x=(hello)", () => {
			expect(containsDangerousSubstitution("x=(hello)")).toBe(false)
		})
	})

	describe("zsh process substitution (should be flagged)", () => {
		it("should return true for standalone =(whoami)", () => {
			expect(containsDangerousSubstitution("=(whoami)")).toBe(true)
		})

		it("should return true for =(ls) with leading space", () => {
			expect(containsDangerousSubstitution(" =(ls)")).toBe(true)
		})

		it("should return true for echo =(cat /etc/passwd)", () => {
			expect(containsDangerousSubstitution("echo =(cat /etc/passwd)")).toBe(true)
		})
	})
})

describe("getCommandDecision", () => {
	it("should auto_approve array assignment command with wildcard allowlist", () => {
		const command = 'files=(a.ts b.ts); for f in "${files[@]}"; do echo "$f"; done'
		const result = getCommandDecision(command, ["*"])
		expect(result).toBe("auto_approve")
	})
})

describe("containsDangerousSubstitution — node -e one-liner false positive regression", () => {
	const nodeOneLiner = `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('prd.json','utf8'));const allowed=new Set(['pending','in-progress','complete','blocked']);const bad=(p.items||[]).filter(i=>!allowed.has(i.status));console.log('meta.status',p.meta?.status);console.log('workstreams', (p.workstreams||[]).length);console.log('items', (p.items||[]).length);console.log('statusCounts', (p.items||[]).reduce((a,i)=>(a[i.status]=(a[i.status]||0)+1,a),{}));console.log('invalidStatuses', bad.length);if(bad.length){console.log(bad.map(i=>i.id+':'+i.status).join('\\\\n'));process.exit(2);} "`

	it("should NOT flag the complex node -e one-liner as dangerous substitution", () => {
		expect(containsDangerousSubstitution(nodeOneLiner)).toBe(false)
	})
})

describe("containsDangerousSubstitution — arrow function patterns (should NOT be flagged)", () => {
	it("should return false for node -e with simple arrow function", () => {
		expect(containsDangerousSubstitution(`node -e "const a=(b)=>b"`)).toBe(false)
	})

	it("should return false for node -e with spaced arrow function", () => {
		expect(containsDangerousSubstitution(`node -e "const fn = (x) => x * 2"`)).toBe(false)
	})

	it("should return false for node -e with arrow function in method chain", () => {
		expect(containsDangerousSubstitution(`node -e "arr.filter(i=>!set.has(i))"`)).toBe(false)
	})
})

describe("containsDangerousSubstitution — true positives still caught", () => {
	it("should flag dangerous parameter expansion ${var@P}", () => {
		expect(containsDangerousSubstitution('echo "${var@P}"')).toBe(true)
	})

	it("should flag here-string with command substitution <<<$(…)", () => {
		expect(containsDangerousSubstitution("cat <<<$(whoami)")).toBe(true)
	})

	it("should flag indirect variable reference ${!var}", () => {
		expect(containsDangerousSubstitution("echo ${!prefix}")).toBe(true)
	})

	it("should flag zsh process substitution =(…) at start of token", () => {
		expect(containsDangerousSubstitution("echo =(cat /etc/passwd)")).toBe(true)
	})

	it("should flag zsh glob qualifier with code execution", () => {
		expect(containsDangerousSubstitution("ls *(e:whoami:)")).toBe(true)
	})
})

describe("getCommandDecision — integration with dangerous substitution checks", () => {
	const allowedCommands = ["node", "echo"]

	it("should auto-approve the complex node -e one-liner when node is allowed", () => {
		const nodeOneLiner = `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('prd.json','utf8'));const allowed=new Set(['pending','in-progress','complete','blocked']);const bad=(p.items||[]).filter(i=>!allowed.has(i.status));console.log('meta.status',p.meta?.status);console.log('workstreams', (p.workstreams||[]).length);console.log('items', (p.items||[]).length);console.log('statusCounts', (p.items||[]).reduce((a,i)=>(a[i.status]=(a[i.status]||0)+1,a),{}));console.log('invalidStatuses', bad.length);if(bad.length){console.log(bad.map(i=>i.id+':'+i.status).join('\\\\n'));process.exit(2);} "`

		expect(getCommandDecision(nodeOneLiner, allowedCommands)).toBe("auto_approve")
	})

	it("should ask user for echo $(whoami) because subshell whoami is not in the allowlist", () => {
		expect(getCommandDecision("echo $(whoami)", allowedCommands)).toBe("ask_user")
	})

	it("should ask user for dangerous parameter expansion even when command is allowed", () => {
		expect(getCommandDecision('echo "${var@P}"', allowedCommands)).toBe("ask_user")
	})

	it("does not auto-approve a substitution embedded in a parameter expansion", () => {
		// The shell runs $(rm -rf ~/work) when x is unset, so the inner command must
		// match the lists on its own; allowing `echo` must not approve the payload.
		expect(getCommandDecision("echo ${x:-$(rm -rf ~/work)}", ["echo"])).toBe("ask_user")
	})

	it("does not auto-approve a nested substitution riding outer allowlist entries", () => {
		// `$(foo $(rm -rf /) bar)` must decompose so the innermost `rm -rf /` is
		// evaluated independently; cutting at the first ")" would let the payload ride
		// the `foo` and `bar` allowlist entries.
		expect(getCommandDecision("ls $(foo $(rm -rf /) bar)", ["ls", "foo", "bar"])).toBe("ask_user")
	})

	it("asks user when a heredoc opened inside a parameter expansion carries a substitution", () => {
		// With x unset, bash expands the alternate word and runs the heredoc body's
		// $(evil) even though the expansion itself stays one segment.
		expect(getCommandDecision("cat ${x:-y <<EOF\n$(evil)\nEOF\n}", ["cat"])).toBe("ask_user")
	})

	it("fails closed on a NUL byte gluing a substitution to an allowed command", () => {
		// bash drops the NUL and runs the glued substitution, so the placeholder
		// degradation must not leave `git status$(whoami)` looking like one allowed
		// word: the input is rejected as malformed instead.
		expect(getCommandDecision("git status\x00$(whoami)", ["git"])).toBe("malformed_command")
	})

	it("asks user for a substitution on the heredoc opener line after the delimiter", () => {
		// The opener line's remainder is expanded even when the delimiter is quoted,
		// so $(whoami) there matches the lists on its own.
		expect(getCommandDecision("cat <<EOF $(whoami)\nbody\nEOF", ["cat"])).toBe("ask_user")
	})

	it("asks user when a heredoc body with an unquoted delimiter contains a substitution", () => {
		// The shell expands $(whoami) inside an unquoted-delimiter heredoc body, so the
		// inner command must match the lists even though the heredoc is one host segment.
		const heredoc = "cat <<EOF\n$(whoami)\nEOF"
		expect(getCommandDecision(heredoc, ["cat"])).toBe("ask_user")
	})

	it("asks user for a substitution inside the deprecated $[…] arithmetic form", () => {
		// bash expands `$[ … ]` interiors before evaluating, so `touch` must
		// match the lists on its own instead of riding the allowlisted echo.
		expect(getCommandDecision("echo $[1+$(touch /tmp/pwn; echo 1)]", ["echo"])).toBe("ask_user")
	})

	it("asks user for the line after a double-quoted-delimiter heredoc whose backslash bash keeps", () => {
		// bash retains `\` before `q`, so the heredoc ends at the `a\q` line
		// and `rm -rf /` is an ordinary following command the lists must see.
		expect(getCommandDecision('cat <<"a\\q"\na\\q\nrm -rf /\naq\n', ["cat"])).toBe("ask_user")
	})

	it("asks user for the line after a heredoc whose terminator bash joins from continued lines", () => {
		// `EO\` + `F` joins into the `EOF` terminator before bash matches it,
		// so `rm -rf /` runs as a following command, not as masked body text.
		expect(getCommandDecision("cat <<EOF\nEO\\\nF\nrm -rf /\n", ["cat"])).toBe("ask_user")
	})

	it("asks user for the inner commands of process substitutions", () => {
		expect(getCommandDecision("diff <(sort a) <(sort b)", ["diff"])).toBe("ask_user")
	})

	it("auto-approves an unbalanced delimiter inside single quotes", () => {
		// A shell never parses delimiter characters inside single quotes, so an
		// unbalanced "$(" there is ordinary argument text, not a syntax error.
		expect(getCommandDecision("echo 'a $(b'", ["echo"])).toBe("auto_approve")
	})

	it("fails closed on a stray closer even when the first word is allowed", () => {
		// A stray ")" is a shell syntax error; treating the command as malformed
		// costs a prompt instead of letting an allowlisted first word carry a
		// structure the parser cannot account for straight to execution.
		expect(getCommandDecision("echo )", ["echo"])).toBe("malformed_command")
	})

	it("fails closed on an unclosed arithmetic opener even when the first word is allowed", () => {
		// bash refuses an unclosed "$(("; the masked remainder must not let the
		// allowlisted "echo" carry a never-closed "$(" straight to execution.
		expect(getCommandDecision("echo $(( $(evil)", ["echo"])).toBe("malformed_command")
	})

	it("fails closed on a CR-only heredoc opener even when the first word is allowed", () => {
		// A lone CR does not terminate the opener line, so the heredoc is
		// unterminated: the input must not look well-formed to the allowlists.
		expect(getCommandDecision("cat <<EOF\r$(evil)\rEOF", ["cat"])).toBe("malformed_command")
	})

	it("asks user when a quoted-empty heredoc delimiter lets a later command escape", () => {
		// bash's quote removal makes `<<''` terminate at the first blank line,
		// so `rm -rf /` really executes as its own command; now that the parser
		// splits it out, the unallowed segment costs a prompt instead of riding
		// the `cat` allowlist entry.
		expect(getCommandDecision("cat <<''\nbody\n\nrm -rf /", ["cat"])).toBe("ask_user")
	})

	it("fails closed on an unclosed delimiter quote hiding an executable tail", () => {
		// bash carries the open quote across the newline and runs `; rm -rf /`
		// as a separate command; the input is rejected as malformed so no
		// partial decomposition can auto-approve it.
		expect(getCommandDecision("cat <<'X\r\n'; rm -rf /\nX\r\n", ["cat"])).toBe("malformed_command")
	})

	it("does not reject a subshell group inside a command substitution as malformed", () => {
		// `$( (echo safe) )` is ordinary syntax bash runs; a top-level bare `(`
		// stays host grouping (pre-existing segmentation), so the decision must
		// not be malformed_command either way.
		expect(getCommandDecision("$( (echo safe) )", ["echo"])).not.toBe("malformed_command")
	})

	it("asks user for the payload of a >() process substitution", () => {
		// bash runs the inner command unconditionally (its output becomes the
		// device file the outer command writes to), so `evil` is evaluated
		// against the lists on its own despite the outer `cat` being allowed.
		expect(getCommandDecision("cat >(evil)", ["cat"])).toBe("ask_user")
	})

	it("auto-approves a well-formed mid-word-quoted delimiter (no over-fire)", () => {
		// `<<EOF'x'` closes its quote before the line end; after bash's quote
		// removal the terminator is the literal word EOFx, so this stays a
		// single ordinary heredoc an allowlisted `cat` may run.
		expect(getCommandDecision("cat <<EOF'x'\nbody\nEOFx\n", ["cat"])).toBe("auto_approve")
	})

	it("does not auto-approve a heredoc-body frame tail riding a mis-sliced group prefix", () => {
		// bash runs `curl evil` from this body line. An allowlist covering the
		// host and the quoted-quote group prefix must not carry the tail: the
		// frame keeps its full payload, `curl evil` is its own segment, and no
		// segment matches, so the decision is a prompt, never approval.
		expect(getCommandDecision('cat <<EOF\n$( (echo ")") ; curl evil)\nEOF', ["cat", "( echo"])).toBe("ask_user")
	})

	it("does not auto-approve the single-quoted variant of a heredoc-body frame tail", () => {
		expect(getCommandDecision("cat <<EOF\n$( (echo ')') ; curl evil)\nEOF", ["cat", "( echo"])).toBe("ask_user")
	})

	it("does not auto-approve a heredoc-body frame tail hidden behind a comment", () => {
		// bash skips the comment to end of line, so its `)` never closes the
		// frame and `curl evil` really executes inside the same substitution.
		// An allowlist covering the host and the first inner command must not
		// carry the tail: it is its own segment and costs a prompt.
		expect(getCommandDecision("cat <<EOF\n$( echo ok # )\ncurl evil)\nEOF", ["cat", "echo"])).toBe("ask_user")
	})

	it("does not auto-approve the CRLF variant of a comment-hidden frame tail", () => {
		expect(getCommandDecision("cat <<EOF\r\n$( echo ok # )\r\ncurl evil)\r\nEOF\r\n", ["cat", "echo"])).toBe(
			"ask_user",
		)
	})

	it("does not auto-approve a frame tail behind a comment at the frame start", () => {
		expect(getCommandDecision("cat <<EOF\n$(# ok )\ncurl evil)\nEOF", ["cat"])).toBe("ask_user")
	})

	it("fails closed when a frame comment swallows the frame's only closer", () => {
		// bash refuses the input outright (unterminated command substitution),
		// so no partial decomposition may carry an approval.
		expect(getCommandDecision("cat <<EOF\n$( echo # )\nEOF", ["cat", "echo"])).toBe("malformed_command")
	})

	it("asks user for a mid-word # argument whose separator hides an unallowed tail", () => {
		// `x=a#b` is one bash argument (a comment starts only at a word
		// boundary); the tail after `;` runs separately and must not ride the
		// allowlisted `echo`.
		expect(getCommandDecision("cat <<EOF\n$( echo x=a#b ; curl evil )\nEOF", ["cat", "echo"])).toBe("ask_user")
	})

	it("does not auto-approve a frame tail after a quoted # region", () => {
		// The `#` inside the quotes is literal, so the frame keeps its full
		// payload and `curl evil` splits out as an unallowed segment.
		expect(getCommandDecision('cat <<EOF\n$( echo "a # b" ; curl evil)\nEOF', ["cat", "echo"])).toBe("ask_user")
	})

	it("does not auto-approve a tail riding after a # at a word-embedded expansion closer", () => {
		// bash ends the expansion at `)` but not the word, so the adjacent `#`
		// is word content and `; curl evil` is a second executed command.
		// An allowlist covering the host and the substitution must not carry
		// the tail: it is its own segment and costs a prompt.
		expect(getCommandDecision("echo x=$(echo ok)#;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("echo $((1))#;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("echo x=`echo ok`#;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("cat <(echo ok)#;curl evil", ["cat", "echo"])).toBe("ask_user")
	})

	it("does not auto-approve a tail riding after a # at the end of an escape pair", () => {
		// bash treats an escaped character as word content, so the `#` glued
		// after the `\c` pair never starts a comment and `; curl evil` really
		// executes; each tail must cost a prompt despite the `echo` allowlist.
		// A real space before the `#` puts it at a word start instead: bash
		// comments the line and the same shape stays approved.
		expect(getCommandDecision("echo a\\)#;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("echo a\\;#;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("echo a\\ #;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("echo a\\) #c;curl evil", ["echo"])).toBe("auto_approve")
	})
})

describe("getCommandDecision — multi-line script wrapped in a quoted argument", () => {
	// A wrapper command (e.g. sh -c '...') carrying a multi-line script as a
	// single quoted argument must be treated as one command. The embedded
	// newlines belong to the quoted string and must not be mistaken for a
	// multi-statement sequence that would defeat allowlist auto-approval.
	const wrappedSingleQuoted = [
		`sh -c 'kubectl exec pod -- python3 -c "`,
		`import urllib.request`,
		`url = \\"http://127.0.0.1:49527/\\"`,
		`try:`,
		`    with urllib.request.urlopen(url, timeout=10) as r:`,
		`        print(r.status)`,
		`except Exception as e:`,
		`    print(\\"fetch failed:\\", e)`,
		`"'`,
	].join("\n")

	it("auto-approves a multi-line single-quoted script when the wrapper prefix is allowed", () => {
		expect(getCommandDecision(wrappedSingleQuoted, ["sh"])).toBe("auto_approve")
	})

	it("auto-approves a multi-line double-quoted script when the wrapper prefix is allowed", () => {
		const wrappedDoubleQuoted = 'sh -c "echo line1\necho line2"'
		expect(getCommandDecision(wrappedDoubleQuoted, ["sh"])).toBe("auto_approve")
	})

	it("asks user when the wrapper prefix is not in the allowlist", () => {
		expect(getCommandDecision(wrappedSingleQuoted, ["git"])).toBe("ask_user")
	})

	it("still splits genuine multi-statement scripts and asks when a statement is not allowed", () => {
		// Real unquoted newlines separate independent statements; each must be on
		// the allowlist for auto-approval to engage.
		const multiStatement = "echo hello\nrm -rf /tmp/x"
		expect(getCommandDecision(multiStatement, ["echo"])).toBe("ask_user")
	})

	it("auto-approves a genuine multi-statement script when every statement is allowed", () => {
		const multiStatement = "echo hello\nls -la"
		expect(getCommandDecision(multiStatement, ["echo", "ls"])).toBe("auto_approve")
	})

	it("auto-approves an ANSI-C quoted ($'...') multi-line argument when the wrapper prefix is allowed", () => {
		const ansiC = "sh -c $'echo 1\necho 2'"
		expect(getCommandDecision(ansiC, ["sh"])).toBe("auto_approve")
	})

	it("returns malformed_command for a command with an unterminated quote regardless of allowlist", () => {
		// An unterminated quote is a shell syntax error. Even if the leading word
		// is on the allowlist (or the allowlist is the wildcard), or the exact
		// full command string is listed, the command must not be auto-approved --
		// the shell would report a syntax error and any prefix that ran before
		// the error could have unintended side effects.
		const malformed = "sh -c 'echo a\necho b"
		expect(getCommandDecision(malformed, ["sh"])).toBe("malformed_command")
		expect(getCommandDecision(malformed, ["*"])).toBe("malformed_command")
		expect(getCommandDecision(malformed, [malformed])).toBe("malformed_command")
	})
})

describe("getCommandDecisionDetailed", () => {
	it("names the offending sub-command and matched denied prefix on chained commands", () => {
		const result = getCommandDecisionDetailed("git status && rm x && npm test", ["git", "npm"], ["rm"])

		expect(result.decision).toBe("auto_deny")
		expect(result.offendingCommand).toBe("rm x")
		expect(result.matchedPattern).toBe("rm")
	})

	it("preserves the original casing of the matched denied prefix", () => {
		const result = getCommandDecisionDetailed("RM -rf /tmp/x", [], ["RM -rf"])

		expect(result.decision).toBe("auto_deny")
		expect(result.matchedPattern).toBe("RM -rf")
	})

	it("names the first sub-command lacking an allowlist match for ask_user decisions", () => {
		const result = getCommandDecisionDetailed("git status && unknown-tool", ["git"])

		expect(result.decision).toBe("ask_user")
		expect(result.offendingCommand).toBe("unknown-tool")
		expect(result.matchedPattern).toBeUndefined()
	})

	it("reports the parse error message for malformed commands", () => {
		const result = getCommandDecisionDetailed("sh -c 'echo a", ["sh"])

		expect(result.decision).toBe("malformed_command")
		expect(result.offendingCommand).toBe("sh -c 'echo a")
		expect(result.parseError).toContain("unterminated")
	})

	it("returns plain approval details for auto-approved commands", () => {
		expect(getCommandDecisionDetailed("git status", ["git"])).toEqual({ decision: "auto_approve" })
		expect(getCommandDecisionDetailed("   ", ["git"])).toEqual({ decision: "auto_approve" })
	})

	it("reports malformed_command for an unclosed command substitution", () => {
		// An opened "$(" the scanner cannot close means the input's structure is
		// unaccounted for; the raw (unsplit) command is reported so no fragment of a
		// partial decomposition can be approved in isolation.
		const result = getCommandDecisionDetailed("echo $(whoami", ["echo"])

		expect(result.decision).toBe("malformed_command")
		expect(result.offendingCommand).toBe("echo $(whoami")
		expect(result.parseError).toContain("command substitution")
	})

	it("returns the same decision as getCommandDecision across representative inputs", () => {
		const cases: Array<[string, string[], string[] | undefined]> = [
			["git status", ["git"], []],
			["git push origin", ["git"], ["git push"]],
			["git status && rm file", ["git"], ["rm"]],
			["unknown command", ["git"], ["rm"]],
			['echo "${var@P}"', ["echo"], []],
			["sh -c 'echo a", ["sh"], []],
			["", ["git"], []],
		]

		for (const [command, allowed, denied] of cases) {
			expect(getCommandDecisionDetailed(command, allowed, denied).decision).toBe(
				getCommandDecision(command, allowed, denied),
			)
		}
	})
})
