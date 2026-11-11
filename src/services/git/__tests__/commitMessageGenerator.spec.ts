import * as vscode from "vscode"
import type { Mock } from "vitest"
import { providerIdentifiers } from "@roo-code/types"

import {
	buildCommitMessagePrompt,
	cleanCommitMessage,
	COMMIT_MESSAGE_SYSTEM_PROMPT,
	DIFF_CHARACTER_LIMIT,
	DIFF_LINE_LIMIT,
	DIFF_TRUNCATED_MESSAGE,
	DRAFT_CHANGED_MESSAGE,
	generateCommitMessage,
	getGitApi,
	getRepositoryDiff,
	NO_CHANGES_MESSAGE,
	redactSensitiveInformation,
	resetCommitMessageRequestState,
	resolveGitRepository,
	PREVIOUS_REQUEST_WAIT_MS,
	WAITING_FOR_PREVIOUS_REQUEST_MESSAGE,
	PREVIOUS_REQUEST_STILL_RUNNING_MESSAGE,
	type GitAPI,
	type GitRepository,
} from "../commitMessageGenerator"
import { ClineProvider } from "../../../core/webview/ClineProvider"
import { singleCompletionHandler } from "../../../utils/single-completion-handler"
import { makeUri } from "../../../test-utils/vscode"

vi.mock("vscode", () => ({
	ProgressLocation: {
		Notification: 15,
	},
	extensions: {
		getExtension: vi.fn(),
	},
	window: {
		activeTextEditor: undefined,
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		withProgress: vi.fn(),
	},
	Uri: {
		file: (path: string) => makeUri(path),
		parse: (uri: string) => makeUri(uri),
	},
}))

vi.mock("../../../utils/single-completion-handler", () => ({
	singleCompletionHandler: vi.fn(),
}))

// A fake npm token: "npm_" followed by 36 letters and digits.
const FAKE_NPM_TOKEN = `npm_${"a1B2c3D4e5".repeat(3)}f6G7h8`

function makeRepo(root: string, overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		rootUri: makeUri(root),
		inputBox: { value: "" },
		diff: vi.fn().mockResolvedValue("diff content"),
		...overrides,
	}
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

/**
 * Installs a withProgress mock whose token can be cancelled from the test. Every registered
 * cancellation listener runs on cancel(), like a real vscode.CancellationTokenSource.
 */
function useCancellableProgress({ once = false }: { once?: boolean } = {}) {
	let cancelled = false
	const listeners: Array<() => void> = []
	const disposable = { dispose: vi.fn() }
	const withProgress = vscode.window.withProgress as Mock
	// With `once`, only the next withProgress call gets this token; later calls use the default mock.
	const install = once
		? withProgress.mockImplementationOnce.bind(withProgress)
		: withProgress.mockImplementation.bind(withProgress)
	install((_opts: unknown, callback: (progress: unknown, token: unknown) => unknown) => {
		const token = {
			get isCancellationRequested() {
				return cancelled
			},
			onCancellationRequested: vi.fn((fn: () => void) => {
				listeners.push(fn)
				return disposable
			}),
		}
		return callback({ report: vi.fn() }, token)
	})
	return {
		disposable,
		cancel: () => {
			cancelled = true
			listeners.forEach((fn) => fn())
		},
	}
}

describe("commitMessageGenerator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resetCommitMessageRequestState()
		;(vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }).activeTextEditor = undefined
	})

	describe("cleanCommitMessage", () => {
		it("removes markdown code fences and backticks", () => {
			const input = "```markdown\nfeat(auth): add login flow\n```"
			expect(cleanCommitMessage(input)).toBe("feat(auth): add login flow")
		})

		it("removes surrounding quotes", () => {
			expect(cleanCommitMessage('"feat: simple commit"')).toBe("feat: simple commit")
			expect(cleanCommitMessage("'feat: simple commit'")).toBe("feat: simple commit")
		})

		it("trims whitespace", () => {
			expect(cleanCommitMessage("  fix: bug  \n")).toBe("fix: bug")
		})
	})

	describe("redactSensitiveInformation", () => {
		it("redacts private keys", () => {
			const content =
				"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----\nother text"
			expect(redactSensitiveInformation(content)).toBe("[REDACTED_SECRET]\nother text")
		})

		it("redacts api keys and secrets", () => {
			const content = 'apiKey: "super-secret-key-12345"\npassword=mysecretpassword123\nother_config=123'
			const redacted = redactSensitiveInformation(content)
			expect(redacted).toContain('apiKey: "[REDACTED]"')
			expect(redacted).toContain("password=[REDACTED]")
			expect(redacted).toContain("other_config=123")
		})

		it("redacts Bearer tokens in Authorization headers", () => {
			const content =
				"+Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature\n+other: value"
			const redacted = redactSensitiveInformation(content)
			expect(redacted).not.toContain("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature")
			expect(redacted).toContain("[REDACTED]")
			expect(redacted).toContain("+other: value")
		})

		it("redacts secret_key values", () => {
			const content = "secret_key=supersecret12345\nother=unchanged"
			const redacted = redactSensitiveInformation(content)
			expect(redacted).not.toContain("supersecret12345")
			expect(redacted).toContain("[REDACTED]")
			expect(redacted).toContain("other=unchanged")
		})

		it("redacts passwords containing special characters like @", () => {
			const content = "password=pass@word123\nother=unchanged"
			const redacted = redactSensitiveInformation(content)
			expect(redacted).not.toContain("pass@word123")
			expect(redacted).toContain("[REDACTED]")
			expect(redacted).toContain("other=unchanged")
		})

		it.each([
			["JSON key", '+  "apiKey": "sk-live-123456789",', '+  "apiKey": "[REDACTED]",', "sk-live-123456789"],
			["YAML key", "+  client_secret: hunter2", "+  client_secret: [REDACTED]", "hunter2"],
			["env var with prefix", "+OPENAI_API_KEY=abc", "+OPENAI_API_KEY=[REDACTED]", "abc"],
			["short password", "+DB_PASSWORD=a", "+DB_PASSWORD=[REDACTED]", "=a"],
			["camelCase key", '+  openAiApiKey: "abc123",', '+  openAiApiKey: "[REDACTED]",', "abc123"],
			["bare bearer token", "+curl -H x Bearer abc123def456", "+curl -H x Bearer [REDACTED]", "abc123def456"],
			["access token", "+access_token: 'tok_1'", "+access_token: '[REDACTED]'", "tok_1"],
			[
				"Basic authorization header",
				"+Authorization: Basic dXNlcjpwYXNzd29yZA==",
				"+Authorization: Basic [REDACTED]",
				"dXNlcjpwYXNzd29yZA",
			],
			[
				"JSON authorization header",
				'+"Authorization": "Bearer abc.def.ghi"',
				'+"Authorization": "Bearer [REDACTED]"',
				"abc.def.ghi",
			],
			["raw authorization header", "+authorization: rawtoken", "+authorization: [REDACTED]", "rawtoken"],
			[
				"URL credentials",
				"+url = postgres://admin:s3cr3t@db.internal:5432/app",
				"+url = postgres://admin:[REDACTED]@db.internal:5432/app",
				"s3cr3t",
			],
			["email address", '+  "author": "alice@example.com",', '+  "author": "[REDACTED_EMAIL]",', "alice@"],
			[
				"a double-quoted value with a semicolon",
				'+password: "pass;word123"',
				'+password: "[REDACTED]"',
				"word123",
			],
			[
				"a JSON value with commas and semicolons",
				'+  "api_key": "a,b;c-123",',
				'+  "api_key": "[REDACTED]",',
				"b;c-123",
			],
			["a single-quoted value with spaces", "+secret = 'two words;x'", "+secret = '[REDACTED]'", "words"],
			["a backtick value", "+const pwd = `p;w`", "+const pwd = `[REDACTED]`", "p;w"],
			["a quoted value with an escaped quote", String.raw`+password: "a\";b"`, '+password: "[REDACTED]"', ";b"],
			["an unterminated quoted value", '+password: "abc;def', "+password: [REDACTED]", "abc"],
			["an npm token variable", `+NPM_TOKEN=${FAKE_NPM_TOKEN}`, "+NPM_TOKEN=[REDACTED]", "npm_"],
			["a standalone TOKEN variable", "+TOKEN=abcdef", "+TOKEN=[REDACTED]", "abcdef"],
			["a standalone SECRET variable", "+SECRET=hunter", "+SECRET=[REDACTED]", "hunter"],
			["a JSON token key", '+  "token": "abcdef1234567890",', '+  "token": "[REDACTED]",', "abcdef1234567890"],
			["a quoted token in code", "+const token = 'opaque'", "+const token = '[REDACTED]'", "opaque"],
			["an unquoted YAML token", "+  token: abc123def456", "+  token: [REDACTED]", "abc123def456"],
			["a snake_case token key", "+npm_token: s3cr3tvalue", "+npm_token: [REDACTED]", "s3cr3tvalue"],
			[
				"an unquoted token without a digit",
				"+  token: abcdefghijklmnopqrstuvwxyz",
				"+  token: [REDACTED]",
				"abcdefghijklmnopqrstuvwxyz",
			],
			["a camelCase unquoted token", "+Token=opaqueValue", "+Token=[REDACTED]", "opaqueValue"],
			[
				"a camelCase token key",
				'+const npmToken = "opaque12345678"',
				'+const npmToken = "[REDACTED]"',
				"opaque12345678",
			],
			[
				"a dotted unquoted token",
				"+  token: abcdefghijklmnop.qrstuvwxyzabcdefgh",
				"+  token: [REDACTED]",
				"qrstuvwxyz",
			],
			["a token that starts like a type name", "+token: Abc/def+ghi=", "+token: [REDACTED]", "def+ghi"],
			[
				"a qualified type, which reads like a dotted secret",
				"+  token: vscode.CancellationToken",
				"+  token: [REDACTED]",
				"vscode.",
			],
			["a quoted token variable", '+SLACK_BOT_TOKEN="xyz;123"', '+SLACK_BOT_TOKEN="[REDACTED]"', "xyz"],
			["a YAML secret variable", "+  CI_DEPLOY_SECRET: hunter2", "+  CI_DEPLOY_SECRET: [REDACTED]", "hunter2"],
			[
				"an exported token variable",
				"+export GITLAB_TOKEN=plain-value",
				"+export GITLAB_TOKEN=[REDACTED]",
				"plain-value",
			],
			[
				"a quoted Authorization value with a semicolon",
				'+"Authorization": "Basic ab;cd=="',
				'+"Authorization": "Basic [REDACTED]"',
				";cd",
			],
		])("redacts %s", (_label, content, expected, secret) => {
			const redacted = redactSensitiveInformation(content)
			expect(redacted).toBe(expected)
			expect(redacted).not.toContain(secret)
		})

		it.each([
			["OpenAI key", "sk-proj-abcdefghijklmnopqrstuvwx"],
			["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
			["npm token", FAKE_NPM_TOKEN],
			["GitLab token", "glpat-abcdefghij0123456789"],
			["AWS access key id", "AKIAABCDEFGHIJKLMNOP"],
			["Slack token", "xoxb-1234567890-abcdef"],
			["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
		])("redacts a bare %s", (_label, token) => {
			const redacted = redactSensitiveInformation(`+const value = callWith(${token})`)
			expect(redacted).toBe("+const value = callWith([REDACTED_SECRET])")
		})

		// A credential key decides, not the shape of its value: casing or syntax cannot tell a
		// secret from code, so code under a credential key is redacted too.
		it.each([
			["a call", "+const token = getToken()", "+const token = [REDACTED]"],
			["an awaited call", "+const token = await fetchToken()", "+const token = [REDACTED]"],
			["a property read", "+const token = this.token", "+const token = [REDACTED]"],
			["a PascalCase type", "+  token: CancellationToken", "+  token: [REDACTED]"],
			["a PascalCase secret", "+token: Abcdefghijklmnop", "+token: [REDACTED]"],
			["a union type", "+  token: Token | undefined", "+  token: [REDACTED]"],
			["a Python type hint with a default", "+def run(token: str = None):", "+def run(token: [REDACTED]"],
			["a camelCase call", "+const sessionToken = createToken()", "+const sessionToken = [REDACTED]"],
			["a primitive name followed by a dot", "+token: string.abcdef123", "+token: [REDACTED]"],
		])("redacts %s under a credential key", (_label, content, expected) => {
			expect(redactSensitiveInformation(content)).toBe(expected)
		})

		it.each([
			["a Cookie header", "+Cookie: session=abc123; theme=dark", "+Cookie: [REDACTED]"],
			["a Set-Cookie header", "+set-cookie: sid=xyz; Path=/; HttpOnly", "+set-cookie: [REDACTED]"],
			[
				"a Cookie header whose first name is a type name",
				"+Cookie:string=opaqueA1b2c3; sid=opaqueD4e5f6",
				"+Cookie:[REDACTED]",
			],
			["an upper-case bearer token", "+curl -H x BEARER abc123def456", "+curl -H x BEARER [REDACTED]"],
			[
				"an alphabetic bearer token",
				'+const header = "Bearer abcdefghijklmnopqrstuvwx"',
				'+const header = "Bearer [REDACTED]"',
			],
			["a word after Bearer in prose", "+// Uses Bearer authentication", "+// Uses Bearer [REDACTED]"],
			["a short bearer token", '+const header = "Bearer hunter2"', '+const header = "Bearer [REDACTED]"'],
			[
				"a multi-line XML credential element",
				"+  <password>\n+    hunter2\n+  </password>\n+  <user>admin</user>",
				"+  <password>\n+    [REDACTED]\n+  </password>\n+  <user>admin</user>",
			],
			[
				"an XML value that starts on the tag line",
				"+<apiKey>abc\n+def</apiKey>",
				"+<apiKey>[REDACTED]\n+[REDACTED]</apiKey>",
			],
			[
				"an XML credential element with attributes",
				'+<password encoding="plain">hunter2</password>',
				'+<password encoding="plain">[REDACTED]</password>',
			],
			[
				"an XML credential value with CDATA markup",
				"+<password><![CDATA[hunter2]]></password>",
				"+<password>[REDACTED]</password>",
			],
			[
				"removed and added XML values that close on their own side",
				" <password>\n-  oldpass</password>\n+  hunter2</password>\n <user>admin</user>",
				" <password>\n-  [REDACTED]</password>\n+  [REDACTED]</password>\n <user>admin</user>",
			],
			[
				"a YAML block that an added line ends only on the new side",
				" password: |\n+newkey: value\n   still-old-secret",
				" password: [REDACTED]\n+newkey: value\n   [REDACTED]",
			],
			[
				"an unclosed XML credential element up to the next hunk",
				" <secret>\n s3cr3t\n@@ -1 +1 @@\n+next",
				" <secret>\n [REDACTED]\n@@ -1 +1 @@\n+next",
			],
			["an npmrc auth value", "+_auth=dXNlcjpwYXNz", "+_auth=[REDACTED]"],
			["a passphrase", "+  passphrase: correct-horse", "+  passphrase: [REDACTED]"],
			["a passphrase with spaces", "+passphrase: correct horse battery staple", "+passphrase: [REDACTED]"],
			["a value that starts with a type name", "+PASSWORD=string=MySecurePass123", "+PASSWORD=[REDACTED]"],
			["a type name followed by a word", "+PASSWORD=string MySecurePass123", "+PASSWORD=[REDACTED]"],
			["an XML credential element", "+  <password>hunter2</password>", "+  <password>[REDACTED]</password>"],
			["an XML API key element", "+<apiKey>abc123</apiKey>", "+<apiKey>[REDACTED]</apiKey>"],
			[
				"a URL password with an empty user",
				"+REDIS_URL=redis://:s3cret@cache:6379",
				"+REDIS_URL=redis://:[REDACTED]@cache:6379",
			],
			[
				"a URL password that contains @",
				"+url = postgres://admin:p@ss@db/app",
				"+url = postgres://admin:[REDACTED]@db/app",
			],
			[
				"a Digest authorization header",
				'+Authorization: Digest username="u", response="abc123"',
				"+Authorization: Digest [REDACTED]",
			],
			[
				"a YAML block value",
				"+  password: |\n+    first line\n+    second line\n+  user: admin",
				"+  password: [REDACTED]\n+    [REDACTED]\n+    [REDACTED]\n+  user: admin",
			],
			[
				"a folded YAML block value in context lines",
				"   client_secret: >-\n     folded\n\n     more\n   name: app",
				"   client_secret: [REDACTED]\n     [REDACTED]\n\n     [REDACTED]\n   name: app",
			],
		])("redacts %s", (_label, content, expected) => {
			expect(redactSensitiveInformation(content)).toBe(expected)
		})

		// Built from parts so that secret scanners do not flag these fake values in the source.
		it.each([
			["Stripe secret key", ["sk", "live", "a1b2c3d4e5f6g7h8i9j0"].join("_")],
			["Stripe restricted key", ["rk", "test", "a1b2c3d4e5f6g7h8i9j0"].join("_")],
			["Hugging Face token", `hf_${"aB3".repeat(11)}`],
			["Google OAuth token", `ya29.${"aB3-_".repeat(5)}`],
			["SendGrid key", `SG.${"aB3".repeat(8)}.${"cD4".repeat(8)}`],
			["PyPI token", `pypi-${"aB3".repeat(20)}`],
			["DigitalOcean token", `dop_v1_${"a1".repeat(32)}`],
			["Shopify token", `shpat_${"a1".repeat(16)}`],
			["Slack app token", `xapp-1-${"A1".repeat(8)}`],
			["temporary AWS key id", `ASIA${"ABCD".repeat(4)}`],
		])("redacts a bare %s", (_label, token) => {
			const redacted = redactSensitiveInformation(`+const value = callWith(${token})`)
			expect(redacted).toBe("+const value = callWith([REDACTED_SECRET])")
		})

		it.each([
			["Slack", ["https://hooks.slack.com/services", "T000", "B000", "XXXXXXXX"].join("/")],
			["Discord", ["https://discord.com/api/webhooks", "123", "abc-DEF_ghi"].join("/")],
			["mixed-case Slack", ["HTTPS://Hooks.Slack.Com/services", "T000", "B000", "XXXXXXXX"].join("/")],
		])("redacts the secret path of a %s webhook URL", (_label, url) => {
			const redacted = redactSensitiveInformation(`+  url: "${url}"`)
			expect(redacted).not.toContain("XXXXXXXX")
			expect(redacted).not.toContain("abc-DEF_ghi")
			expect(redacted).toContain("[REDACTED]")
		})

		it.each([
			["comparisons", "+if (password === confirmation) {"],
			["arrow functions", "+const check = (password) => verify(password)"],
			["prose mentioning the Basic scheme", "+// Adds basic functionality for Basic authentication"],
			["scoped package names", '+import { x } from "@roo-code/types"'],
			["versioned package specs", "+npx react@18.3.1"],
			["empty quoted credentials", '+  password: "",'],
			["lower-case token fields", "+  token: string"],
			["optional token fields", "+  token?: string"],
			["camelCase token fields", "+  nextPageToken: string"],
			["cookie type annotations", "+  cookie: string;"],
			["YAML mappings under a credential key", "+credentials:\n+  username: admin"],
			["self-closing XML credential tags", "+<password/>\n+<token />\n+<name>app</name>"],
			["primitive credential types", "+  apiKey: string | undefined"],
			["primitive array types", "+  passwords: string[]"],
			["typed password fields", "+  password: string[]"],
			["null credentials", "+  token: null,"],
			["LLM token limits", "+  max_tokens: 4096,"],
			["camelCase token limits", "+  maxTokens: 4096,"],
			["token counters", "+const tokenCount = countTokens(text)"],
			["author fields", "+  author: Jane"],
			["typed parameters", "+function run(token: string) {"],
			["typed parameter lists", "+  password: string,"],
			["Python typed parameters", "+def run(token: str):"],
			["Rust typed parameters", "+fn run(token: &str) {"],
			["semicolon type members", "+  secret: string | null;"],
			["plural token keys", "+  tokens: 5"],
			["token reads without an assignment", "+const value = env.TOKEN"],
			["upper-case names that only contain TOKEN", "+const MAX_TOKENS = 4096"],
			["upper-case token names without an assignment", "+if (env.NPM_TOKEN) {"],
		])("leaves %s unchanged", (_label, content) => {
			expect(redactSensitiveInformation(content)).toBe(content)
		})

		it("leaves normal diff content unchanged", () => {
			const content = "diff --git a/src/app.ts b/src/app.ts\n+console.log('hello world')"
			expect(redactSensitiveInformation(content)).toBe(content)
		})

		it.each([
			["back-to-back addresses", "a@b.co+c@d.co", "[REDACTED_EMAIL][REDACTED_EMAIL]"],
			["addresses in a list", "to: x@y.io, z@w.dev", "to: [REDACTED_EMAIL], [REDACTED_EMAIL]"],
			["an address after a bare @", "@ then bob@example.org", "@ then [REDACTED_EMAIL]"],
			["an address next to a decorator", "@Input() admin@corp.example", "@Input() [REDACTED_EMAIL]"],
		])("redacts %s", (_label, content, expected) => {
			expect(redactSensitiveInformation(content)).toBe(expected)
		})

		it.each([
			["a long run without @", "a".repeat(200_000)],
			["many @ signs with no domain", "a@".repeat(100_000)],
			["many local-part characters before one @", `${"a.".repeat(100_000)}@`],
			["a long upper-case name without a TOKEN suffix", "A_".repeat(100_000)],
			["many token type declarations", "token: string\n".repeat(14_286)],
			["long lines of credential words without a value", `${"token ".repeat(50)}\n`.repeat(600)],
			["many empty XML credential elements", "<password></password>".repeat(10_000)],
			["many self-closing XML credential tags", "<password />".repeat(18_000)],
			["many lines with a closed XML element", "<a>x</a>\n".repeat(20_000)],
			["many URL schemes without a password", "://:".repeat(50_000)],
			["a long snake_case name without a token suffix", "a_".repeat(100_000)],
		])("redacts %s in linear time", (_label, content) => {
			// A quadratic scan of 200k characters takes far longer than this budget.
			const startedAt = performance.now()
			expect(redactSensitiveInformation(content)).toBe(content)
			expect(performance.now() - startedAt).toBeLessThan(1000)
		})
	})

	describe("buildCommitMessagePrompt", () => {
		it("includes diff and instructions", () => {
			const { prompt, truncated } = buildCommitMessagePrompt("diff --git a/file b/file\n+test")
			expect(prompt).toContain("diff --git a/file b/file\n+test")
			expect(prompt).toContain("Conventional Commits")
			expect(truncated).toBe(false)
		})

		it("redacts sensitive information in the prompt", () => {
			const { prompt } = buildCommitMessagePrompt("apiKey: 'secret_token_12345678'")
			expect(prompt).not.toContain("secret_token_12345678")
			expect(prompt).toContain("[REDACTED]")
		})

		it.each([
			["character", "x".repeat(DIFF_CHARACTER_LIMIT + 1)],
			["line", Array.from({ length: DIFF_LINE_LIMIT + 1 }, (_, i) => `+line ${i}`).join("\n")],
		])("reports truncation when the diff exceeds the %s limit", (_label, diff) => {
			const { prompt, truncated } = buildCommitMessagePrompt(diff)
			expect(truncated).toBe(true)
			expect(prompt).toContain(COMMIT_MESSAGE_SYSTEM_PROMPT)
			expect(prompt).toMatch(/\[\.\.\.\d+ (?:characters|lines) omitted\.\.\.\]/)
		})

		it("does not report truncation at exactly the character limit", () => {
			const { truncated } = buildCommitMessagePrompt("x".repeat(DIFF_CHARACTER_LIMIT))
			expect(truncated).toBe(false)
		})
	})

	describe("getGitApi", () => {
		it("returns undefined if git extension not found", async () => {
			;(vscode.extensions.getExtension as Mock).mockReturnValue(undefined)
			const api = await getGitApi()
			expect(api).toBeUndefined()
		})

		it("activates git extension if not active and returns API", async () => {
			const mockApi = { repositories: [] }
			const mockExt = {
				isActive: false,
				activate: vi.fn().mockResolvedValue(undefined),
				exports: {
					getAPI: vi.fn().mockReturnValue(mockApi),
				},
			}
			;(vscode.extensions.getExtension as Mock).mockReturnValue(mockExt)

			const api = await getGitApi()
			expect(mockExt.activate).toHaveBeenCalled()
			expect(mockExt.exports.getAPI).toHaveBeenCalledWith(1)
			expect(api).toBe(mockApi)
		})
	})

	describe("resolveGitRepository", () => {
		it("returns undefined if repositories list is empty", () => {
			const git: GitAPI = { repositories: [] }
			expect(resolveGitRepository(git)).toBeUndefined()
		})

		it("resolves from repository object context directly", () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo] }

			expect(resolveGitRepository(git, repo)).toBe(repo)
		})

		it("resolves a SourceControl context from the scm/title menu by rootUri", () => {
			const repo1 = makeRepo("/workspace/repo1")
			const repo2 = makeRepo("/workspace/repo2")
			const git: GitAPI = { repositories: [repo1, repo2] }
			const sourceControl = { id: "git", rootUri: makeUri("/workspace/repo2"), inputBox: { value: "" } }

			expect(resolveGitRepository(git, sourceControl)).toBe(repo2)
		})

		it("rejects a repository-shaped context that is not a known repository", () => {
			const known = makeRepo("/workspace/repo1")
			const other = makeRepo("/workspace/repo2")
			const git: GitAPI = { repositories: [known, other] }
			const fake = makeRepo("/workspace/attacker")

			expect(resolveGitRepository(git, fake)).toBeUndefined()
			expect(fake.diff).not.toHaveBeenCalled()
		})

		it("returns the known repository, not the context object, when a fake context reuses its rootUri", () => {
			const known = makeRepo("/workspace/repo")
			const git: GitAPI = { repositories: [known, makeRepo("/workspace/other")] }
			const fake = makeRepo("/workspace/repo")

			const resolved = resolveGitRepository(git, fake)
			expect(resolved).toBe(known)
			expect(resolved).not.toBe(fake)
		})

		it.each([
			["a bare Uri", (root: vscode.Uri) => root],
			["a SourceControl rootUri", (root: vscode.Uri) => ({ rootUri: root })],
		])("matches %s by its scheme and fsPath without calling its methods", (_label, wrap) => {
			const known = makeRepo("/workspace/repo")
			const git: GitAPI = { repositories: [makeRepo("/workspace/other"), known] }
			const forgedToString = vi.fn(() => "/workspace/repo")
			const forged = { scheme: "file", fsPath: "/workspace/repo", toString: forgedToString }

			expect(resolveGitRepository(git, wrap(forged as unknown as vscode.Uri))).toBe(known)
			expect(forgedToString).not.toHaveBeenCalled()
		})

		it.each([
			["a different fsPath", { scheme: "file", fsPath: "/workspace/attacker" }],
			["a different scheme", { scheme: "untitled", fsPath: "/workspace/repo" }],
		])("rejects a forged Uri with %s even when its toString matches", (_label, fields) => {
			const git: GitAPI = { repositories: [makeRepo("/workspace/repo"), makeRepo("/workspace/other")] }
			const forgedToString = vi.fn(() => "/workspace/repo")

			expect(resolveGitRepository(git, { ...fields, toString: forgedToString })).toBeUndefined()
			expect(forgedToString).not.toHaveBeenCalled()
		})

		it("rejects a fake context with a matching-looking inputBox", () => {
			const git: GitAPI = { repositories: [makeRepo("/workspace/repo1"), makeRepo("/workspace/repo2")] }
			const fake = { inputBox: { value: "" }, diff: vi.fn() }

			expect(resolveGitRepository(git, fake)).toBeUndefined()
			expect(fake.diff).not.toHaveBeenCalled()
		})

		it("resolves from bare vscode.Uri context", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, makeUri("/workspace/repo2"))).toBe(repo2)
		})

		it("resolves from scm context with rootUri", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, { rootUri: makeUri("/workspace/repo2") })).toBe(repo2)
		})

		it("resolves from scm context with inputBox", () => {
			const inputBox1 = { value: "" }
			const inputBox2 = { value: "" }
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: inputBox1,
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: inputBox2,
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, { inputBox: inputBox2 })).toBe(repo2)
		})

		it("falls back to first repository when only one exists", () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo] }

			expect(resolveGitRepository(git)).toBe(repo)
		})

		it("matches active editor URI if multiple repositories exist", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			const mutableWindow = vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }
			mutableWindow.activeTextEditor = {
				document: {
					uri: makeUri("/workspace/repo2/src/file.ts"),
				},
			} as unknown as vscode.TextEditor // Structural test double providing document.uri

			expect(resolveGitRepository(git)).toBe(repo2)
		})

		it("returns undefined if bare vscode.Uri context does not match any repository", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, makeUri("/workspace/unknown"))).toBeUndefined()
		})

		it("returns undefined if scm context rootUri does not match any repository", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, { rootUri: makeUri("/workspace/unknown") })).toBeUndefined()
		})

		it("returns undefined if scm context inputBox does not match any repository", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			expect(resolveGitRepository(git, { inputBox: { value: "other" } })).toBeUndefined()
		})

		it("falls back to first repository when active editor does not match any repository", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo1"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo2"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			const mutableWindow = vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }
			mutableWindow.activeTextEditor = {
				document: {
					uri: makeUri("/workspace/other/file.ts"),
				},
			} as unknown as vscode.TextEditor // Structural test double providing document.uri

			expect(resolveGitRepository(git)).toBe(repo1)
		})

		it("distinguishes repository roots on path segment boundaries", () => {
			const repo1: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const repo2: GitRepository = {
				rootUri: makeUri("/workspace/repo-other"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [repo1, repo2] }

			const mutableWindow = vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }
			mutableWindow.activeTextEditor = {
				document: {
					uri: makeUri("/workspace/repo-other/file.ts"),
				},
			} as unknown as vscode.TextEditor

			expect(resolveGitRepository(git)).toBe(repo2)
		})

		it("matches longest root when repositories are nested", () => {
			const parentRepo: GitRepository = {
				rootUri: makeUri("/workspace/monorepo"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const childRepo: GitRepository = {
				rootUri: makeUri("/workspace/monorepo/packages/nested"),
				inputBox: { value: "" },
				diff: vi.fn(),
			}
			const git: GitAPI = { repositories: [parentRepo, childRepo] }

			const mutableWindow = vscode.window as unknown as { activeTextEditor?: vscode.TextEditor }
			mutableWindow.activeTextEditor = {
				document: {
					uri: makeUri("/workspace/monorepo/packages/nested/src/index.ts"),
				},
			} as unknown as vscode.TextEditor

			expect(resolveGitRepository(git)).toBe(childRepo)
		})
	})

	describe("getRepositoryDiff", () => {
		it("prioritizes staged diff", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.resolve("staged diff")
					return Promise.resolve("working diff")
				}),
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBe("staged diff")
			expect(repo.diff).toHaveBeenCalledWith(true)
		})

		it("falls back to working tree diff if staged diff is empty", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.resolve("")
					return Promise.resolve("working diff")
				}),
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBe("working diff")
			expect(repo.diff).toHaveBeenCalledWith(true)
			expect(repo.diff).toHaveBeenCalledWith(false)
		})

		it.each([
			["the working tree", 1],
			["untracked files", 2],
		])("does not read %s after the signal aborts", async (_label, abortAfterCall) => {
			// The signal aborts while the Git read with this call number is pending.
			const controller = new AbortController()
			const diff = vi.fn().mockImplementation(async () => {
				if (diff.mock.calls.length === abortAfterCall) {
					controller.abort()
				}
				return ""
			})
			const workingTreeChanges = vi.fn(() => [{ uri: makeUri("/workspace/repo/new.ts"), status: 7 }])
			const repo = makeRepo("/workspace/repo", {
				diff,
				state: {
					get workingTreeChanges() {
						return workingTreeChanges()
					},
				},
			})

			await expect(getRepositoryDiff(repo, controller.signal)).resolves.toBeUndefined()
			expect(diff).toHaveBeenCalledTimes(abortAfterCall)
			expect(workingTreeChanges).not.toHaveBeenCalled()
		})

		it("rejects without reading the working tree when the staged diff fails", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.reject(new Error("Git diff staged failed"))
					return Promise.resolve("working diff fallback")
				}),
			})

			await expect(getRepositoryDiff(repo)).rejects.toThrow("Git diff staged failed")
			expect(repo.diff).not.toHaveBeenCalledWith(false)
		})

		it("rejects with the staged error when both staged and working tree diffs fail", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi
					.fn()
					.mockImplementation((cached?: boolean) =>
						Promise.reject(new Error(cached ? "staged failed" : "working failed")),
					),
			})

			await expect(getRepositoryDiff(repo)).rejects.toThrow("staged failed")
		})

		it("returns undefined if both staged and working diffs are empty", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue(""),
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBeUndefined()
		})

		it("rejects if working diff fails after empty staged diff", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockImplementation((cached?: boolean) => {
					if (cached) return Promise.resolve("")
					return Promise.reject(new Error("Git working tree diff failed"))
				}),
			})

			await expect(getRepositoryDiff(repo)).rejects.toThrow("Git working tree diff failed")
		})

		it("lists untracked files relative to the repository root", async () => {
			const repo = makeRepo("/home/alice/workspace/repo", {
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [{ uri: makeUri("/home/alice/workspace/repo/src/new-file.ts"), status: 7 }],
				},
			})

			const diff = await getRepositoryDiff(repo)
			// path.relative uses the platform separator.
			expect(diff).toMatch(/^Untracked files:\nsrc[\\/]new-file\.ts$/)
		})

		it("lists untracked files from the separate untrackedChanges group", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [],
					untrackedChanges: [{ uri: makeUri("/workspace/repo/brand-new.ts"), status: 7 }],
				},
			})

			expect(await getRepositoryDiff(repo)).toBe("Untracked files:\nbrand-new.ts")
		})

		it("de-duplicates a file listed in both untracked locations", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [
						{ uri: makeUri("/workspace/repo/a.ts"), status: 7 },
						{ uri: makeUri("/workspace/repo/modified.ts"), status: 5 },
					],
					untrackedChanges: [
						{ uri: makeUri("/workspace/repo/a.ts"), status: 7 },
						{ uri: makeUri("/workspace/repo/b.ts"), status: 7 },
					],
				},
			})

			expect(await getRepositoryDiff(repo)).toBe("Untracked files:\na.ts\nb.ts")
		})

		it("returns undefined when both untracked locations are empty", async () => {
			const repo = makeRepo("/workspace/repo", {
				diff: vi.fn().mockResolvedValue(""),
				state: { workingTreeChanges: [], untrackedChanges: [] },
			})

			expect(await getRepositoryDiff(repo)).toBeUndefined()
		})

		it("surfaces untracked files when both diffs are empty", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [
						{ uri: makeUri("/workspace/repo/new-file.ts"), status: 7 }, // UNTRACKED
						{ uri: makeUri("/workspace/repo/modified.ts"), status: 5 }, // MODIFIED
					],
				},
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toContain("Untracked files:")
			expect(diff).toContain("new-file.ts")
			expect(diff).not.toContain("modified.ts")
		})

		it("surfaces all untracked files when mixed with tracked changes", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [
						{ uri: makeUri("/workspace/repo/new-a.ts"), status: 7 }, // UNTRACKED
						{ uri: makeUri("/workspace/repo/new-b.ts"), status: 7 }, // UNTRACKED
						{ uri: makeUri("/workspace/repo/modified.ts"), status: 5 }, // MODIFIED (not untracked)
					],
				},
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toContain("Untracked files:")
			expect(diff).toContain("new-a.ts")
			expect(diff).toContain("new-b.ts")
			expect(diff).not.toContain("modified.ts")
		})

		it("returns undefined when both diffs are empty and no untracked files exist", async () => {
			const repo: GitRepository = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue(""),
				state: {
					workingTreeChanges: [
						{ uri: makeUri("/workspace/repo/modified.ts"), status: 5 }, // MODIFIED (not untracked)
					],
				},
			}

			const diff = await getRepositoryDiff(repo)
			expect(diff).toBeUndefined()
		})
	})

	describe("generateCommitMessage", () => {
		let mockProvider: ClineProvider
		let mockOutputChannel: vscode.OutputChannel
		let mockRepo: GitRepository

		beforeEach(() => {
			mockOutputChannel = {
				appendLine: vi.fn(),
				append: vi.fn(),
				clear: vi.fn(),
				hide: vi.fn(),
				name: "test",
				replace: vi.fn(),
				show: vi.fn(),
				dispose: vi.fn(),
			}

			mockRepo = {
				rootUri: makeUri("/workspace/repo"),
				inputBox: { value: "" },
				diff: vi.fn().mockResolvedValue("diff content"),
			}

			// Structural test double providing getState for generateCommitMessage
			mockProvider = {
				getState: vi.fn().mockResolvedValue({
					apiConfiguration: {
						apiProvider: providerIdentifiers.anthropic,
						apiKey: "test-key",
					},
				}),
			} as unknown as ClineProvider

			const mockGitApi: GitAPI = {
				repositories: [mockRepo],
			}
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: {
					getAPI: () => mockGitApi,
				},
			})

			// Default withProgress mock: runs the callback immediately with a non-cancelled token.
			// Individual tests may override this for cancellation or error scenarios.
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				}
				return callback(progress, token)
			})
		})

		it("shows error if git extension is unavailable", async () => {
			;(vscode.extensions.getExtension as Mock).mockReturnValue(undefined)

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("Git extension not found or not enabled.")
		})

		it("shows error if no git repository found", async () => {
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: {
					getAPI: () => ({ repositories: [] }),
				},
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No Git repository found.")
		})

		it("shows info if no diff is found", async () => {
			mockRepo.diff = vi.fn().mockResolvedValue("")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(NO_CHANGES_MESSAGE)
		})

		it("reports a Git diff failure as an error instead of 'no changes'", async () => {
			mockRepo.diff = vi.fn().mockRejectedValue(new Error("fatal: bad index file"))

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(NO_CHANGES_MESSAGE)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to generate commit message: fatal: bad index file",
			)
			expect(singleCompletionHandler).not.toHaveBeenCalled()
		})

		it("never reads from or writes to a command context that is not a known repository", async () => {
			const fake = makeRepo("/workspace/attacker")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
				context: fake,
			})

			expect(fake.diff).not.toHaveBeenCalled()
			expect(singleCompletionHandler).not.toHaveBeenCalled()
			expect(fake.inputBox.value).toBe("")
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("No Git repository found.")
		})

		it("generates for the repository named by an scm/title SourceControl context", async () => {
			;(singleCompletionHandler as Mock).mockResolvedValue("fix: second repo")
			const second = makeRepo("/workspace/second")
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: { getAPI: () => ({ repositories: [mockRepo, second] }) },
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
				context: { rootUri: makeUri("/workspace/second"), inputBox: { value: "" } },
			})

			expect(second.inputBox.value).toBe("fix: second repo")
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("warns after writing when the diff was truncated", async () => {
			mockRepo.diff = vi.fn().mockResolvedValue("x".repeat(DIFF_CHARACTER_LIMIT + 1))
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: large change")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("feat: large change")
			expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(DIFF_TRUNCATED_MESSAGE)
		})

		it("does not warn about truncation for a diff within the limits", async () => {
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: small change")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("feat: small change")
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		})

		it("keeps text the user typed while the request was pending", async () => {
			mockRepo.inputBox.value = "draft"
			;(singleCompletionHandler as Mock).mockImplementation(async () => {
				mockRepo.inputBox.value = "typed by user"
				return "feat: generated"
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("typed by user")
			expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(DRAFT_CHANGED_MESSAGE)
		})

		it("replaces an unchanged draft with the generated message", async () => {
			mockRepo.inputBox.value = "draft"
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: generated")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("feat: generated")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(DRAFT_CHANGED_MESSAGE)
		})

		it("aborts an older request for the same repository and sends the newer one after it settles", async () => {
			const first = deferred<string>()
			let olderSignal: AbortSignal | undefined
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce((_config, _prompt, options: { abortSignal: AbortSignal }) => {
					olderSignal = options.abortSignal
					// This provider ignores the abort signal and settles later.
					return first.promise
				})
				.mockResolvedValueOnce("feat: newer")

			const older = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			const newer = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await older
			expect(olderSignal?.aborted).toBe(true)

			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(2))
			await new Promise((resolve) => setTimeout(resolve, 0))
			// No second provider request while the older one still runs.
			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)

			first.resolve("feat: older")
			await newer

			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(mockRepo.inputBox.value).toBe("feat: newer")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(DRAFT_CHANGED_MESSAGE)
		})

		it("treats new Git API wrappers for one repository as the same repository", async () => {
			// The VS Code Git API creates a new repository wrapper on each read of `repositories`.
			// The wrappers share one underlying input box.
			const sharedInputBox = { value: "" }
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: {
					getAPI: () => ({
						get repositories() {
							return [makeRepo("/workspace/repo", { inputBox: sharedInputBox })]
						},
					}),
				},
			})
			const first = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => first.promise)
				.mockResolvedValueOnce("feat: newer")

			const older = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			const newer = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await older
			first.resolve("feat: older")
			await newer

			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(sharedInputBox.value).toBe("feat: newer")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(DRAFT_CHANGED_MESSAGE)
		})

		it("never runs two provider requests for one repository, even with several waiting requests", async () => {
			const first = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => first.promise)
				.mockResolvedValueOnce("feat: latest")

			const a = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			const b = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(2))
			const c = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(3))
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)

			first.resolve("feat: first")
			await Promise.all([a, b, c])

			// The middle request is no longer the newest after the wait, so it sends nothing.
			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(mockRepo.inputBox.value).toBe("feat: latest")
		})

		it("keeps the latest request of each repository independent", async () => {
			const otherRepo = makeRepo("/workspace/other")
			;(vscode.extensions.getExtension as Mock).mockReturnValue({
				isActive: true,
				exports: { getAPI: () => ({ repositories: [mockRepo, otherRepo] }) },
			})
			const first = deferred<string>()
			const second = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => first.promise)
				.mockImplementationOnce(() => second.promise)

			const forMockRepo = generateCommitMessage({ provider: mockProvider, context: mockRepo })
			const forOtherRepo = generateCommitMessage({ provider: mockProvider, context: otherRepo })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(2))

			second.resolve("feat: other")
			await forOtherRepo
			first.resolve("feat: mock")
			await forMockRepo

			expect(mockRepo.inputBox.value).toBe("feat: mock")
			expect(otherRepo.inputBox.value).toBe("feat: other")
		})

		it("closes the progress immediately when cancelled while the LLM call is pending", async () => {
			const { cancel, disposable } = useCancellableProgress()
			let capturedSignal: AbortSignal | undefined
			// The provider ignores the abort signal and never settles.
			;(singleCompletionHandler as Mock).mockImplementation((_config, _prompt, options) => {
				capturedSignal = options.abortSignal as AbortSignal
				return new Promise(() => {})
			})

			const run = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalled())
			cancel()
			await run

			expect(capturedSignal?.aborted).toBe(true)
			expect(disposable.dispose).toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it.each([
			["a staged diff", true],
			["a working-tree diff", false],
		])("keeps tokens in %s out of the prompt", async (_label, staged) => {
			const tokenDiff = [
				`+NPM_TOKEN=${FAKE_NPM_TOKEN}`,
				`+//registry.npmjs.org/:_authToken=${FAKE_NPM_TOKEN}`,
				"+TOKEN=abcdef1234567890",
				'+  "token": "abcdef1234567890",',
				"+  token: abcdefghijklmnopqrstuvwxyz",
				'+const npmToken = "opaque12345678"',
				"+  token: abcdefghijklmnop.qrstuvwxyzabcdefgh",
				"+token: Abcdefghijklmnop",
				"+PASSWORD=string=MySecurePass123",
				"+passphrase: correct horse battery staple",
				'+const header = "Bearer abcdefghijklmnopqrstuvwx"',
				'+const short = "Bearer hunter2"',
				"+<password>",
				"+  multilinesecret",
				"+</password>",
				'+<apiKey env="prod">attrsecret</apiKey>',
				"+<secret><![CDATA[cdatasecret]]></secret>",
				" <password>",
				"-  removedsecret</password>",
				"+  addedsecret</password>",
				`+SLACK_URL=${["https://Hooks.Slack.Com/services", "T000", "B000", "WEBHOOKSECRET"].join("/")}`,
				"+  token: string",
			].join("\n")
			mockRepo.diff = vi.fn((cached?: boolean) => Promise.resolve(cached === staged ? tokenDiff : ""))
			;(singleCompletionHandler as Mock).mockResolvedValue("chore: configure npm publishing")

			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

			const prompt = (singleCompletionHandler as Mock).mock.calls[0][1] as string
			expect(prompt).toContain("+NPM_TOKEN=[REDACTED]")
			expect(prompt).toContain("_authToken=[REDACTED]")
			expect(prompt).toContain("+TOKEN=[REDACTED]")
			expect(prompt).toContain('+  "token": "[REDACTED]",')
			expect(prompt).toContain("+  token: string")
			expect(prompt).not.toContain("npm_")
			expect(prompt).not.toContain("abcdef1234567890")
			expect(prompt).not.toContain("abcdefghijklmnopqrstuvwxyz")
			expect(prompt).not.toContain("opaque12345678")
			expect(prompt).not.toContain("qrstuvwxyz")
			expect(prompt).not.toContain("Abcdefghijklmnop")
			expect(prompt).not.toContain("MySecurePass123")
			expect(prompt).not.toContain("battery staple")
			expect(prompt).not.toContain("WEBHOOKSECRET")
			expect(prompt).not.toContain("abcdefghijklmnopqrstuvwx")
			expect(prompt).not.toContain("hunter2")
			expect(prompt).not.toContain("multilinesecret")
			for (const secret of ["attrsecret", "cdatasecret", "removedsecret", "addedsecret"]) {
				expect(prompt).not.toContain(secret)
			}
			expect(mockRepo.diff).toHaveBeenCalledWith(staged)
		})

		it("does not read the working tree when cancelled while the staged diff is pending", async () => {
			const { cancel } = useCancellableProgress()
			const stagedDiff = deferred<string>()
			mockRepo.diff = vi.fn((cached?: boolean) => (cached ? stagedDiff.promise : Promise.resolve("working diff")))

			const run = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockRepo.diff).toHaveBeenCalledWith(true))
			cancel()
			await run
			stagedDiff.resolve("")
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(mockRepo.diff).toHaveBeenCalledTimes(1)
			expect(mockProvider.getState).not.toHaveBeenCalled()
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
		})

		it("waits for a cancelled request that ignores the abort before it sends the retry", async () => {
			const { cancel } = useCancellableProgress({ once: true })
			const cancelledRequest = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => cancelledRequest.promise)
				.mockResolvedValueOnce("feat: retry")

			const first = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			cancel()
			await first

			const retry = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(2))
			await new Promise((resolve) => setTimeout(resolve, 0))
			// The retry does not start a second provider request while the cancelled one runs.
			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)

			cancelledRequest.resolve("feat: cancelled")
			await retry

			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(mockRepo.inputBox.value).toBe("feat: retry")
			expect(vscode.window.showInformationMessage).not.toHaveBeenCalled()
			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
		})

		it("lets the user cancel a retry while it waits for the cancelled request", async () => {
			const firstProgress = useCancellableProgress({ once: true })
			const retryProgress = useCancellableProgress({ once: true })
			const cancelledRequest = deferred<string>()
			;(singleCompletionHandler as Mock).mockImplementationOnce(() => cancelledRequest.promise)

			const first = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			firstProgress.cancel()
			await first

			const retry = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(mockProvider.getState).toHaveBeenCalledTimes(2))
			retryProgress.cancel()
			await retry

			expect(singleCompletionHandler).toHaveBeenCalledTimes(1)
			expect(mockRepo.inputBox.value).toBe("")
			cancelledRequest.resolve("feat: cancelled")
		})

		it("stops the retry with a message, without a second request, when the cancelled request outlasts the wait limit", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				const { cancel } = useCancellableProgress({ once: true })
				const report = vi.fn()
				;(singleCompletionHandler as Mock).mockImplementationOnce(() => new Promise(() => {}))

				const first = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
				await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
				cancel()
				await first

				;(vscode.window.withProgress as Mock).mockImplementationOnce((_opts, callback) =>
					callback(
						{ report },
						{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) },
					),
				)
				const retry = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
				// vi.waitFor advances fake timers by its poll interval, so keep a margin below the limit.
				await vi.waitFor(
					() => expect(report).toHaveBeenCalledWith({ message: WAITING_FOR_PREVIOUS_REQUEST_MESSAGE }),
					{ interval: 1 },
				)
				await vi.advanceTimersByTimeAsync(PREVIOUS_REQUEST_WAIT_MS - 1_000)
				expect(singleCompletionHandler).toHaveBeenCalledTimes(1)

				await vi.advanceTimersByTimeAsync(1_000)
				await retry

				expect(singleCompletionHandler).toHaveBeenCalledTimes(1)
				expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(PREVIOUS_REQUEST_STILL_RUNNING_MESSAGE)
				expect(mockRepo.inputBox.value).toBe("")
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not wait when the cancelled request already settled", async () => {
			const { cancel } = useCancellableProgress({ once: true })
			const cancelledRequest = deferred<string>()
			;(singleCompletionHandler as Mock)
				.mockImplementationOnce(() => cancelledRequest.promise)
				.mockResolvedValueOnce("feat: retry")

			const first = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalledTimes(1))
			cancel()
			await first
			cancelledRequest.resolve("feat: cancelled")
			await new Promise((resolve) => setTimeout(resolve, 0))

			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

			expect(singleCompletionHandler).toHaveBeenCalledTimes(2)
			expect(mockRepo.inputBox.value).toBe("feat: retry")
		})

		it("does not report a provider rejection that arrives after cancellation", async () => {
			const { cancel } = useCancellableProgress()
			let rejectCompletion: (error: Error) => void = () => {}
			;(singleCompletionHandler as Mock).mockImplementation(
				() =>
					new Promise((_resolve, reject) => {
						rejectCompletion = reject
					}),
			)

			const run = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalled())
			cancel()
			await run
			rejectCompletion(new Error("late provider failure"))
			await Promise.resolve()

			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("shows error if no valid API provider is configured", async () => {
			mockProvider.getState = vi.fn().mockResolvedValue({
				apiConfiguration: {},
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"No valid API provider configured. Please configure an API provider in Zoo Code settings.",
			)
		})

		it("generates commit message and assigns it to inputBox.value", async () => {
			;(singleCompletionHandler as Mock).mockResolvedValue("feat(core): implement git commit message")
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				}
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(singleCompletionHandler).toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("feat(core): implement git commit message")
		})

		it("does not update inputBox if cancelled", async () => {
			;(singleCompletionHandler as Mock).mockResolvedValue("feat: should be cancelled")
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				let cancellationHandler: () => void = () => {}
				let isCancelled = false
				const token = {
					get isCancellationRequested() {
						return isCancelled
					},
					onCancellationRequested: vi.fn((fn: () => void) => {
						cancellationHandler = fn
						return { dispose: vi.fn() }
					}),
				}
				cancellationHandler()
				isCancelled = true
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("")
		})

		it("skips provider and LLM call when cancelled while diff is pending", async () => {
			let isCancelled = false
			const cancellationHandlers: Array<() => void> = []
			// diff never resolves on its own — simulates a slow/stuck git process
			mockRepo.diff = vi.fn().mockImplementation(() => new Promise(() => {}))
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					get isCancellationRequested() {
						return isCancelled
					},
					onCancellationRequested: vi.fn((fn: () => void) => {
						cancellationHandlers.push(fn)
						return { dispose: vi.fn() }
					}),
				}
				// Trigger cancellation after the race has started (next microtask)
				void Promise.resolve().then(() => {
					isCancelled = true
					cancellationHandlers.forEach((fn) => fn())
				})
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockProvider.getState).not.toHaveBeenCalled()
			expect(singleCompletionHandler).not.toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("skips LLM call when cancelled after provider state resolves", async () => {
			let isCancelled = false
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					get isCancellationRequested() {
						return isCancelled
					},
					onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				}
				return callback(progress, token)
			})
			// Set cancelled = true inside getState so the guard after getState fires
			mockProvider.getState = vi.fn().mockImplementation(async () => {
				isCancelled = true
				return { apiConfiguration: { apiProvider: providerIdentifiers.openai, apiKey: "sk-test" } }
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(singleCompletionHandler).not.toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("aborts the in-flight provider request when cancellation is requested", async () => {
			// Collect ALL registered cancellation handlers so both abortController.abort()
			// and the cancelPromise resolver are called when the test triggers cancellation.
			const registeredHandlers: Array<() => void> = []
			let triggerCancellation: () => void = () => {}
			let capturedSignal: AbortSignal | undefined
			;(singleCompletionHandler as Mock).mockImplementation((_config, _prompt, options) => {
				capturedSignal = options.abortSignal as AbortSignal
				triggerCancellation()
				return Promise.resolve("feat: should be cancelled")
			})
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn((fn: () => void) => {
						registeredHandlers.push(fn)
						triggerCancellation = () => registeredHandlers.forEach((h) => h())
						return { dispose: vi.fn() }
					}),
				}
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(capturedSignal?.aborted).toBe(true)
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("does not update inputBox and shows warning if generated message is empty", async () => {
			mockRepo.inputBox.value = "preserved value"
			const mockDisposable = { dispose: vi.fn() }
			;(singleCompletionHandler as Mock).mockResolvedValue("   ")
			;(vscode.window.withProgress as Mock).mockImplementation((_opts, callback) => {
				const progress = { report: vi.fn() }
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: vi.fn().mockReturnValue(mockDisposable),
				}
				return callback(progress, token)
			})

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockRepo.inputBox.value).toBe("preserved value")
			expect(mockDisposable.dispose).toHaveBeenCalled()
			expect(vscode.window.showWarningMessage).toHaveBeenCalledWith("No commit message generated.")
		})

		it("stays quiet when the provider rejects synchronously on the user's cancel", async () => {
			const { cancel } = useCancellableProgress()
			;(singleCompletionHandler as Mock).mockImplementation(
				(_config, _prompt, options: { abortSignal: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						options.abortSignal.addEventListener("abort", () => {
							const abortError = new Error("This operation was aborted")
							abortError.name = "AbortError"
							reject(abortError)
						})
					}),
			)

			const run = generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })
			await vi.waitFor(() => expect(singleCompletionHandler).toHaveBeenCalled())
			cancel()
			await run

			expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
			expect(mockRepo.inputBox.value).toBe("")
		})

		it.each([
			["a message that mentions 'aborted'", "request aborted by server", "Error"],
			["a provider timeout", "The operation was aborted due to timeout", "TimeoutError"],
			["an AbortError the user did not cause", "This operation was aborted", "AbortError"],
		])("reports %s when the user did not cancel", async (_label, message, name) => {
			const error = new Error(message)
			error.name = name
			;(singleCompletionHandler as Mock).mockRejectedValue(error)

			await generateCommitMessage({ provider: mockProvider, outputChannel: mockOutputChannel })

			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Failed to generate commit message: ${message}`)
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(`[generateGitCommitMessage] failed: ${message}`)
			expect(mockRepo.inputBox.value).toBe("")
		})

		it("handles non-Error objects gracefully and shows error message", async () => {
			;(vscode.window.withProgress as Mock).mockRejectedValue("String-based error")

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[generateGitCommitMessage] failed: String-based error"),
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to generate commit message: String-based error",
			)
		})

		it("handles errors gracefully and shows error message", async () => {
			;(vscode.window.withProgress as Mock).mockRejectedValue(new Error("Network error"))

			await generateCommitMessage({
				provider: mockProvider,
				outputChannel: mockOutputChannel,
			})

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("[generateGitCommitMessage] failed: Network error"),
			)
			expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
				"Failed to generate commit message: Network error",
			)
		})
	})
})
