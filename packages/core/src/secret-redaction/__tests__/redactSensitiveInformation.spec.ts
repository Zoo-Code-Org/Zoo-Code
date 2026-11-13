// npx vitest run packages/core/src/secret-redaction/__tests__/redactSensitiveInformation.spec.ts

import { redactSensitiveInformation } from "../redactSensitiveInformation.js"

// A fake npm token: "npm_" followed by 36 letters and digits.
const FAKE_NPM_TOKEN = `npm_${"a1B2c3D4e5".repeat(3)}f6G7h8`

/** A diff of one file with one hunk that has the given content lines. */
function fileDiff(path: string, ...content: string[]): string {
	return [`diff --git a/${path} b/${path}`, `@@ -0,0 +1,${content.length} @@`, ...content].join("\n")
}

describe("redactSensitiveInformation", () => {
	describe("sensitive files", () => {
		it.each([
			[".env"],
			["config/.env.production"],
			["certs/server.pem"],
			["deploy/signing.key"],
			[".ssh/id_ed25519"],
			["k8s/secrets.yaml"],
			["credentials.json"],
			[".npmrc"],
			["infra/prod.tfvars"],
			[".envrc"],
			["config/prod.env"],
			["config/.env.d/prod"],
			[".vault-token"],
			["keys/service_account_prod.json"],
			["infra/terraform.tfstate.backup"],
		])("hides every content line of %s, also without a credential word", (path) => {
			const diff = fileDiff(path, "+HOST=example.org", "-PORT=1", " hunter2")
			expect(redactSensitiveInformation(diff)).toBe(fileDiff(path, "+[REDACTED]", "-[REDACTED]", " [REDACTED]"))
		})

		it.each([["src/env.ts"], ["docs/envoy.yaml"], ["docs/service_account.md"], ["config/.environment"]])(
			"keeps the lines of %s, which is not a sensitive file",
			(path) => {
				const diff = fileDiff(path, "+HOST=example.org")
				expect(redactSensitiveInformation(diff)).toBe(diff)
			},
		)

		it("hides a sensitive file in a combined diff of a merge conflict", () => {
			const combined = [
				"diff --cc .env",
				"index 1111111,2222222..3333333",
				"--- a/.env",
				"+++ b/.env",
				"@@@ -1,1 -1,1 +1,2 @@@",
				"++DB=hunter2xyz",
				" +HOST=example.org",
			].join("\n")
			const diff = `${fileDiff("a.ts", "+let a = 1")}\n${combined}`
			expect(redactSensitiveInformation(diff)).toBe(
				`${fileDiff("a.ts", "+let a = 1")}\n${combined.replace("++DB=hunter2xyz", "++[REDACTED]").replace(" +HOST=example.org", " +[REDACTED]")}`,
			)
		})

		it.each([
			["a quoted path", 'diff --git "a/my app/.env" "b/my app/.env"'],
			["a path without a/ and b/ prefixes", "diff --git .env .env"],
			["a CRLF header line", "diff --git a/.env b/.env\r"],
			["an escaped non-ASCII name", 'diff --git "a/.env.pr\\303\\266d" "b/.env.pr\\303\\266d"'],
			["an escaped quote in the name", 'diff --git "a/keys/a\\"b.pem" "b/keys/a\\"b.pem"'],
		])("finds a sensitive file with %s", (_label, header) => {
			const redacted = redactSensitiveInformation(`${header}\n@@ -0,0 +1 @@\n+HOST=hunter2`)
			expect(redacted).not.toContain("hunter2")
		})

		it.each([
			["renamed from a sensitive path", "a/.env", "b/settings.txt", "rename"],
			["renamed to a sensitive path", "a/settings.txt", "b/.env", "rename"],
			["copied from a sensitive path", "a/certs/server.pem", "b/notes.txt", "copy"],
		])("hides every content line of a file %s", (_label, from, to, kind) => {
			const header = [
				`diff --git ${from} ${to}`,
				"similarity index 80%",
				`${kind} from ${from.slice(2)}`,
				`${kind} to ${to.slice(2)}`,
				`--- ${from}`,
				`+++ ${to}`,
				"@@ -1,2 +1,2 @@",
			].join("\n")
			expect(redactSensitiveInformation(`${header}\n-SESSION=hunter2\n+HOST=x\n PORT=1`)).toBe(
				`${header}\n-[REDACTED]\n+[REDACTED]\n [REDACTED]`,
			)
		})

		it("reads the path of a renamed file from the --- line when Git gives no rename lines", () => {
			const diff = "diff --git a/x b/y\n--- a/.env\n+++ b/settings.txt\n@@ -1 +1 @@\n-SESSION=hunter2"
			expect(redactSensitiveInformation(diff)).not.toContain("hunter2")
		})

		it("does not treat /dev/null as a file that is not code", () => {
			const diff = [
				"diff --git a/app.ts b/app.ts",
				"new file mode 100644",
				"--- /dev/null",
				"+++ b/app.ts",
				"@@ -0,0 +1,2 @@",
				"+const token = load()",
				"+const other = 1",
			].join("\n")
			expect(redactSensitiveInformation(diff)).toBe(diff.replace("+const token = load()", "+[REDACTED]"))
		})

		it("keeps the header lines of a sensitive file", () => {
			const diff =
				"diff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+A=1"
			expect(redactSensitiveInformation(diff)).toBe(diff.replace("+A=1", "+[REDACTED]"))
		})
	})

	describe("files that are not code", () => {
		it.each([
			["a YAML pair with the value first", "deploy.yaml", ["+  - value: hunter2", "+    name: API_TOKEN"]],
			["a nested YAML value", "values.yml", ["+password:", "+  value: hunter2"]],
			[
				"a JSON pair with the value first",
				"config.json",
				['+{"value":"hunter2","options":{},"name":"API_TOKEN"}'],
			],
			[
				"a pretty-printed JSON pair",
				"config.json",
				["+{", '+  "value": "hunter2",', '+  "name": "API_TOKEN"', "+}"],
			],
			["an XML element at the same indentation", "app.config", ["+<password>", "+hunter2", "+</password>"]],
			["an XML attribute pair", "web.config", ['+<add key="DbPassword" value="hunter2" />']],
			["a credential word only in a removed line", "settings.ini", ["-token=old", "+level=hunter2"]],
			["a credential word only in a context line", "settings.toml", [" [auth]", "+key = 'hunter2'"]],
			["a file without an extension", "Procfile", ["+web: run --secret hunter2"]],
			[
				"a JSON pair 64 records deep",
				"config.json",
				[`+${'{"nested":'.repeat(63)}{"value":"hunter2","options":{},"name":"API_TOKEN"}${"}".repeat(63)}`],
			],
		])("hides every content line when one line has a credential word: %s", (_label, path, content) => {
			const redacted = redactSensitiveInformation(fileDiff(path, ...content))
			expect(redacted).not.toContain("hunter2")
			expect(redacted).toContain(`diff --git a/${path} b/${path}`)
		})

		it("keeps a file without a credential word", () => {
			const diff = fileDiff("deploy.yaml", "+  - name: LOG_LEVEL", "+    value: debug")
			expect(redactSensitiveInformation(diff)).toBe(diff)
		})

		it("hides only the file that has the credential word", () => {
			const settings = fileDiff("settings.json", '+{"token": "hunter2"}')
			const readme = fileDiff("README.md", "+Install the app.")
			expect(redactSensitiveInformation(`${settings}\n${readme}`)).toBe(
				`${fileDiff("settings.json", "+[REDACTED]")}\n${readme}`,
			)
		})

		it("does not treat the word author as a credential word", () => {
			const diff = fileDiff("package.json", '+  "author": "Zoo Code",', '+  "authors": ["Zoo Code"]')
			expect(redactSensitiveInformation(diff)).toBe(diff)
		})
	})

	describe("code files", () => {
		it.each([
			["an assignment", "+const apiKey = 'hunter2'", "+[REDACTED]"],
			["a value before the key on one line", '+register("hunter2", "API_TOKEN")', "+[REDACTED]"],
			["a removed line", "-  password: 'hunter2',", "-  [REDACTED]"],
			["a context line", "   db_password = 'hunter2'", "   [REDACTED]"],
			["an Authorization header", '+headers["Authorization"] = `Basic ${x}`', "+[REDACTED]"],
			["a cookie", "+document.cookie = 'sid=hunter2'", "+[REDACTED]"],
		])("hides %s", (_label, line, expected) => {
			expect(redactSensitiveInformation(fileDiff("app.ts", line))).toBe(fileDiff("app.ts", expected))
		})

		it("hides the block of an indented credential line, before and after it", () => {
			const diff = fileDiff(
				"fixture.ts",
				"+const fixture = {",
				'+  value: "hunter2",',
				"+  nested: {",
				'+    note: "hunter3",',
				"",
				"+  },",
				'+  name: "API_TOKEN",',
				"+}",
				"+export default fixture",
			)
			expect(redactSensitiveInformation(diff)).toBe(
				fileDiff(
					"fixture.ts",
					"+const fixture = {",
					"+  [REDACTED]",
					"+  [REDACTED]",
					"+    [REDACTED]",
					"",
					"+  [REDACTED]",
					"+  [REDACTED]",
					"+}",
					"+export default fixture",
				),
			)
		})

		it("keeps the outer block after a nested credential block ends", () => {
			const diff = fileDiff(
				"fixture.ts",
				"+const fixture = {",
				"+  auth: {",
				'+    token: "a",',
				"+  },",
				'+  value: "hunter2",',
				"+}",
			)
			expect(redactSensitiveInformation(diff)).toBe(
				fileDiff(
					"fixture.ts",
					"+const fixture = {",
					"+  [REDACTED]",
					"+    [REDACTED]",
					"+  [REDACTED]",
					"+  [REDACTED]",
					"+}",
				),
			)
		})

		it("reads the prefix columns and the hunk header of a combined diff", () => {
			const diff = [
				"diff --combined app.ts",
				'@@@ -1,2 -1,2 +1,3 @@@ const API_KEY = "abc"',
				"++const token = load(",
				"++  hunter2xyz,",
				" +const other = 1",
			].join("\n")
			expect(redactSensitiveInformation(diff)).toBe(
				[
					"diff --combined app.ts",
					"@@@ -1,2 -1,2 +1,3 @@@",
					"++[REDACTED]",
					"++  [REDACTED]",
					" +const other = 1",
				].join("\n"),
			)
		})

		it("does not hide the lines before a credential line at column 0", () => {
			const diff = fileDiff("app.py", "+def run():", "+    return 1", "+API_TOKEN = load()")
			expect(redactSensitiveInformation(diff)).toBe(
				fileDiff("app.py", "+def run():", "+    return 1", "+[REDACTED]"),
			)
		})

		it("hides only the deeper lines after a credential line at column 0", () => {
			const diff = fileDiff(
				"app.ts",
				"+const before = 1",
				"+const API_TOKEN =",
				"+\t'hunter2'",
				"+const after = 2",
			)
			expect(redactSensitiveInformation(diff)).toBe(
				fileDiff("app.ts", "+const before = 1", "+[REDACTED]", "+\t[REDACTED]", "+const after = 2"),
			)
		})

		it("hides the block on both diff sides", () => {
			const diff = fileDiff(
				"app.ts",
				"   env: {",
				"-    value: 'old',",
				"+    value: 'hunter2',",
				"     name: 'DB_PASSWORD',",
				"   },",
			)
			expect(redactSensitiveInformation(diff)).toBe(
				fileDiff("app.ts", "   env: {", "-    [REDACTED]", "+    [REDACTED]", "     [REDACTED]", "   },"),
			)
		})

		it("tracks blocks on each diff side, so a removed line does not end an added block", () => {
			const diff = fileDiff(
				"config.ts",
				" const entry = {",
				'   name: "API_TOKEN",',
				"-}",
				'+  value: "hunter2",',
				"+};",
				" export default entry",
			)
			expect(redactSensitiveInformation(diff)).toBe(
				fileDiff(
					"config.ts",
					" const entry = {",
					"   [REDACTED]",
					"-}",
					"+  [REDACTED]",
					"+};",
					" export default entry",
				),
			)
		})

		it("ends a block at the next hunk", () => {
			const diff = [
				"diff --git a/app.py b/app.py",
				"@@ -1 +1 @@",
				"+SECRET = (",
				"@@ -9 +9 @@",
				"+    level = 'debug'",
			].join("\n")
			expect(redactSensitiveInformation(diff)).toBe(diff.replace("+SECRET = (", "+[REDACTED]"))
		})

		it("keeps code lines without a credential word", () => {
			const diff = fileDiff("app.ts", "+const value = load()", "+console.log('hello world')")
			expect(redactSensitiveInformation(diff)).toBe(diff)
		})

		it("removes the hunk function context when it has a credential word", () => {
			const diff = 'diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@ const API_KEY = "hunter2"\n+x = 1'
			expect(redactSensitiveInformation(diff)).toBe("diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n+x = 1")
		})

		it("keeps the hunk function context without a credential word", () => {
			const diff = "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@ function run() {\n+x = 1"
			expect(redactSensitiveInformation(diff)).toBe(diff)
		})

		it("hides a credential line in a CRLF diff", () => {
			expect(redactSensitiveInformation(fileDiff("a.ts", "+token = 'hunter2'\r"))).not.toContain("hunter2")
		})

		it("uses the line rule for text before the first diff header", () => {
			expect(redactSensitiveInformation("Untracked files:\nsrc/app.ts\n.secret-key")).toBe(
				"Untracked files:\nsrc/app.ts\n[REDACTED]",
			)
		})
	})

	describe("values on any line", () => {
		it.each([
			["OpenAI key", "sk-proj-abcdefghijklmnopqrstuvwx"],
			["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
			["npm token", FAKE_NPM_TOKEN],
			["GitLab token", "glpat-abcdefghij0123456789"],
			["AWS access key id", "AKIAABCDEFGHIJKLMNOP"],
			["temporary AWS key id", `ASIA${"ABCD".repeat(4)}`],
			["Slack token", "xoxb-1234567890-abcdef"],
			["Slack app token", `xapp-1-${"A1".repeat(8)}`],
			["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
			// Built from parts so that secret scanners do not flag these fake values in the source.
			["Stripe secret key", ["sk", "live", "a1b2c3d4e5f6g7h8i9j0"].join("_")],
			["Stripe restricted key", ["rk", "test", "a1b2c3d4e5f6g7h8i9j0"].join("_")],
			["Hugging Face token", `hf_${"aB3".repeat(11)}`],
			["Google OAuth token", `ya29.${"aB3-_".repeat(5)}`],
			["SendGrid key", `SG.${"aB3".repeat(8)}.${"cD4".repeat(8)}`],
			["PyPI token", `pypi-${"aB3".repeat(20)}`],
			["DigitalOcean token", `dop_v1_${"a1".repeat(32)}`],
			["Shopify token", `shpat_${"a1".repeat(16)}`],
		])("redacts a bare %s", (_label, value) => {
			expect(redactSensitiveInformation(`+const value = callWith(${value})`)).toBe(
				"+const value = callWith([REDACTED_SECRET])",
			)
		})

		it.each([
			["Slack", ["https://hooks.slack.com/services", "T000", "B000", "XXXXXXXX"].join("/"), "XXXXXXXX"],
			["Discord", ["https://discord.com/api/webhooks", "123", "abc-DEF_ghi"].join("/"), "abc-DEF_ghi"],
			["mixed-case Slack", ["HTTPS://Hooks.Slack.Com/services", "T000", "B000", "YYYY"].join("/"), "YYYY"],
		])("redacts the secret path of a %s webhook URL", (_label, url, secret) => {
			const redacted = redactSensitiveInformation(`+  url: "${url}"`)
			expect(redacted).not.toContain(secret)
			expect(redacted).toContain("[REDACTED]")
		})

		it.each([
			["a URL password", "+url = postgres://admin:s3cret@db/app", "+url = postgres://admin:[REDACTED]@db/app"],
			["a URL password with an empty user", "+url=redis://:s3cret@cache", "+url=redis://:[REDACTED]@cache"],
			["a URL password that contains @", "+url = mysql://a:p@ss@db", "+url = mysql://a:[REDACTED]@db"],
		])("redacts %s", (_label, content, expected) => {
			expect(redactSensitiveInformation(content)).toBe(expected)
		})

		it.each([
			["a private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nnext"],
			["a private key block without an END line", "+const pem = `-----BEGIN PRIVATE KEY-----\n+MIIE\n+abc"],
		])("redacts %s", (_label, content) => {
			const redacted = redactSensitiveInformation(content)
			expect(redacted).not.toContain("MIIE")
			expect(redacted).toContain("[REDACTED")
		})

		it.each([
			["one address", "+// mail jane@example.org", "+// mail [REDACTED_EMAIL]"],
			["back-to-back addresses", "a@b.co+c@d.co", "[REDACTED_EMAIL][REDACTED_EMAIL]"],
			["addresses in a list", "to: x@y.io, z@w.dev", "to: [REDACTED_EMAIL], [REDACTED_EMAIL]"],
			["an address after a bare @", "@ then bob@example.org", "@ then [REDACTED_EMAIL]"],
			["an address before a period", "Mail bob@example.org.", "Mail [REDACTED_EMAIL]."],
		])("redacts %s", (_label, content, expected) => {
			expect(redactSensitiveInformation(content)).toBe(expected)
		})

		it.each([
			["a decorator", "+@Input() name"],
			["a scoped package name", '+import { x } from "@roo-code/types"'],
			["a versioned package spec", "+npx react@18.3.1"],
			["a domain without a top-level label", "+user@localhost"],
		])("leaves %s unchanged", (_label, content) => {
			expect(redactSensitiveInformation(content)).toBe(content)
		})
	})

	it.each([
		["a long run without @", "a".repeat(200_000)],
		["many @ signs with no domain", "a@".repeat(100_000)],
		["many local-part characters before one @", `${"a.".repeat(100_000)}@`],
		["a long domain without a top-level label", `a@${"a-".repeat(100_000)}`],
		["a long domain of dots and dashes", `a@${"-.".repeat(100_000)}`],
		["many URL schemes without a password", "://:".repeat(50_000)],
		["many lines", "+const value = 1\n".repeat(50_000)],
		["many files", fileDiff("a.yaml", "+a: 1").concat("\n").repeat(10_000)],
		["many hunk headers", "@@ -1 +1 @@ run\n".repeat(50_000)],
	])("handles %s in linear time", (_label, content) => {
		// A quadratic scan of this much text takes far longer than this budget.
		const startedAt = performance.now()
		expect(redactSensitiveInformation(content)).toBe(content)
		expect(performance.now() - startedAt).toBeLessThan(1000)
	})

	it("redacts many private key headers without END lines in linear time", () => {
		const startedAt = performance.now()
		expect(redactSensitiveInformation("-----BEGIN A PRIVATE KEY-----\n".repeat(30_000))).toBe("[REDACTED]")
		expect(performance.now() - startedAt).toBeLessThan(1000)
	})

	it("hides many credential lines in linear time", () => {
		const startedAt = performance.now()
		expect(redactSensitiveInformation("+token = 1\n".repeat(50_000))).toBe("+[REDACTED]\n".repeat(50_000))
		expect(
			redactSensitiveInformation(
				fileDiff("a.ts", ..."+  token = 1\n+  x = 2".split("\n").concat(Array(50_000).fill("+  token = 1"))),
			),
		).not.toContain("x = 2")
		expect(performance.now() - startedAt).toBeLessThan(1000)
	})
})
