// npx vitest run packages/core/src/secret-redaction/__tests__/redactSensitiveInformation.spec.ts

import { redactSensitiveInformation } from "../redactSensitiveInformation.js"

// A fake npm token: "npm_" followed by 36 letters and digits.
const FAKE_NPM_TOKEN = `npm_${"a1B2c3D4e5".repeat(3)}f6G7h8`

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
		const content = "+Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature\n+other: value"
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
		["a double-quoted value with a semicolon", '+password: "pass;word123"', '+password: "[REDACTED]"', "word123"],
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
			"closing-tag text inside CDATA",
			"+<password><![CDATA[</password>hunter2]]></password>",
			"+<password>[REDACTED]</password>",
		],
		[
			"closing-tag text inside an XML comment",
			"+<secret><!-- </secret> -->hunter2</secret>",
			"+<secret>[REDACTED]</secret>",
		],
		[
			"a nested element with the same name",
			"+<password><password>a</password>hunter2</password>",
			"+<password>[REDACTED]</password>",
		],
		[
			"an opening tag that spans lines",
			'+<password\n+  encoding="plain">hunter2</password>',
			'+<password\n+  encoding="plain">[REDACTED]</password>',
		],
		[
			"an opening tag with very long attributes",
			`+<password note="${"a".repeat(600)}">hunter2</password>`,
			`+<password note="${"a".repeat(600)}">[REDACTED]</password>`,
		],
		[
			"a YAML block header with a comment",
			"+password: | # deployment secret\n+  hunter2\n+user: admin",
			"+password: [REDACTED]\n+  [REDACTED]\n+user: admin",
		],
		[
			"a Kubernetes env value under a credential name",
			"+  - name: DB_PASSWORD\n+    value: hunter2\n+  - name: LOG_LEVEL\n+    value: debug",
			"+  - name: DB_PASSWORD\n+    value: [REDACTED]\n+  - name: LOG_LEVEL\n+    value: debug",
		],
		[
			"a .NET appSettings value",
			'+<add key="DbPassword" value="hunter2" />',
			'+<add key="DbPassword" value="[REDACTED]" />',
		],
		[
			"a JSON name/value pair",
			'+{"name": "API_TOKEN", "value": "hunter2"}',
			'+{"name": "API_TOKEN", "value": "[REDACTED]"}',
		],
		[
			"an XML value in an XML file of a multi-file diff",
			"diff --git a/app.ts b/app.ts\n+let x = 1\ndiff --git a/pom.xml b/pom.xml\n@@ -1 +1 @@\n+<password>hunter2</password>",
			"diff --git a/app.ts b/app.ts\n+let x = 1\ndiff --git a/pom.xml b/pom.xml\n@@ -1 +1 @@\n+<password>[REDACTED]</password>",
		],
		[
			"a JSON pair with the value first",
			'+{"value":"hunter2","name":"API_TOKEN"}',
			'+{"value":"[REDACTED]","name":"API_TOKEN"}',
		],
		[
			"a YAML pair with the value first",
			"+  - value: hunter2\n+    name: DB_PASSWORD",
			"+  - value: [REDACTED]\n+    name: DB_PASSWORD",
		],
		[
			"a YAML block value under a credential name",
			"+  - name: DB_PASSWORD\n+    value: |-\n+      hunter2\n+  - name: LOG_LEVEL",
			"+  - name: DB_PASSWORD\n+    value: [REDACTED]\n+      [REDACTED]\n+  - name: LOG_LEVEL",
		],
		[
			"a YAML credential value after a comment",
			"+  - name: DB_PASSWORD\n+    # Deployment credential\n+    value: hunter2",
			"+  - name: DB_PASSWORD\n+    # Deployment credential\n+    value: [REDACTED]",
		],
		[
			"a quoted /> inside an XML attribute",
			'+<password note="/>">hunter2</password>',
			'+<password note="/>">[REDACTED]</password>',
		],
		[
			"a reversed YAML pair with a block value",
			"+  - value: |-\n+      hunter2\n+    name: API_TOKEN",
			"+  - value: [REDACTED]\n+      [REDACTED]\n+    name: API_TOKEN",
		],
		[
			"a comment-like line inside a credential block",
			"+  - name: DB_PASSWORD\n+    value: |-\n+      #hunter2",
			"+  - name: DB_PASSWORD\n+    value: [REDACTED]\n+      [REDACTED]",
		],
		[
			"a credential value on the next line",
			"+  - name: DB_PASSWORD\n+    value:\n+      hunter2",
			"+  - name: DB_PASSWORD\n+    value:\n+      [REDACTED]",
		],
		[
			"a credential key with a plain scalar on the next line",
			"+password:\n+  hunter2\n+user: admin",
			"+password:\n+  [REDACTED]\n+user: admin",
		],
		[
			"a multi-line XML element with a credential key attribute",
			'+<add\n+  key="DbPassword"\n+  value="hunter2" />',
			'+<add\n+  key="DbPassword"\n+  value="[REDACTED]" />',
		],
		[
			"an unclosed XML credential element up to the next hunk",
			" <secret>\n s3cr3t\n@@ -1 +1 @@\n+next",
			" <secret>\n [REDACTED]\n@@ -1 +1 @@\n+next",
		],
		[
			"a JSON pair around a nested object",
			'+{"value":"hunter2","options":{},"name":"API_TOKEN"}',
			'+{"value":"[REDACTED]","options":{},"name":"API_TOKEN"}',
		],
		[
			"a JSON pair with a brace inside another string",
			'+{"name":"API_TOKEN","note":"a}b","value":"hunter2"}',
			'+{"name":"API_TOKEN","note":"a}b","value":"[REDACTED]"}',
		],
		[
			"a JSON value that contains a brace",
			'+{"name":"API_TOKEN","value":"hunter}2"}',
			'+{"name":"API_TOKEN","value":"[REDACTED]"}',
		],
		[
			"only the credential pair of a nested record",
			'+{"name":"app","options":{"name":"API_TOKEN","value":"hunter2"},"value":"shown"}',
			'+{"name":"app","options":{"name":"API_TOKEN","value":"[REDACTED]"},"value":"shown"}',
		],
		[
			"a value attribute of a self-closing credential element",
			'+<password value="hunter2"/>',
			'+<password value="[REDACTED]"/>',
		],
		[
			"a value attribute of an HTML credential input",
			'+<input name="password" value="hunter2">',
			'+<input name="password" value="[REDACTED]">',
		],
		[
			"a nested YAML value under a credential key",
			"+password:\n+  value: hunter2\n+  description: shown",
			"+password:\n+  value: [REDACTED]\n+  description: shown",
		],
		[
			"a record value after an unquoted comparison",
			"+{name: API_TOKEN, check: a<b, value: hunter2}",
			"+{name: API_TOKEN, check: a<b, value: [REDACTED]}",
		],
		[
			"an unquoted record value with spaces",
			"+{ name: 'API_TOKEN', value: correct horse }",
			"+{ name: 'API_TOKEN', value: [REDACTED]}",
		],
		[
			"an unclosed XML value after a code file and a quoted path",
			'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+let a = 1\ndiff --git "a/my file.xml" "b/my file.xml"\n@@ -0,0 +1 @@\n+<password>hunter2',
			'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+let a = 1\ndiff --git "a/my file.xml" "b/my file.xml"\n@@ -0,0 +1 @@\n+<password>[REDACTED]',
		],
		[
			"an unclosed XML value after a code file without diff path prefixes",
			"diff --git a.ts a.ts\n@@ -0,0 +1 @@\n+let a = 1\ndiff --git app.config app.config\n@@ -0,0 +1 @@\n+<password>hunter2",
			"diff --git a.ts a.ts\n@@ -0,0 +1 @@\n+let a = 1\ndiff --git app.config app.config\n@@ -0,0 +1 @@\n+<password>[REDACTED]",
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
		[
			"TypeScript generics named like credentials",
			"diff --git a/auth.ts b/auth.ts\n@@ -1,2 +1,2 @@\n+const a: Promise<Credentials> = load()\n+const keys: Array<ApiKey> = []\n+export function f() {}",
		],
		["Kubernetes values under ordinary names", "+  - name: LOG_LEVEL\n+    value: debug"],
		["Kubernetes secret references", "+  - name: DB_PASSWORD\n+    valueFrom:\n+      secretKeyRef:"],
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
		["non-credential fields under a credential key", "+password:\n+  description: shown"],
		["comparisons and arrows in a record", "+if (a<b && c > d) { value = 1 }"],
		[
			"generic types before a record in a code file",
			"diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+const tokens: Array<Token> = [{ value: 1 }]",
		],
		["records with ordinary names", '+{"name":"LOG_LEVEL","options":{},"value":"debug"}'],
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

	it("redacts many XML credential elements in linear time", () => {
		const startedAt = performance.now()
		expect(redactSensitiveInformation("+<password>s</password>\n".repeat(10_000))).toBe(
			"+<password>[REDACTED]</password>\n".repeat(10_000),
		)
		expect(performance.now() - startedAt).toBeLessThan(1000)
	})

	it("redacts a JSON value whose credential name comes far after it", () => {
		const record = `+{"value":"hunter2","description":"${"x".repeat(400)}","name":"API_TOKEN"}`
		expect(redactSensitiveInformation(record)).toBe(record.replace("hunter2", "[REDACTED]"))
	})

	it("matches a credential name and value only within one record", () => {
		const records = '+[{"name":"API_TOKEN","value":"hunter2"},{"name":"LOG_LEVEL","value":"debug"}]'
		expect(redactSensitiveInformation(records)).toBe(records.replace("hunter2", "[REDACTED]"))
	})

	it("redacts the value of a pretty-printed JSON credential pair", () => {
		const redacted = redactSensitiveInformation('+{\n+  "value": "hunter2",\n+  "name": "API_TOKEN"\n+}')
		expect(redacted).not.toContain("hunter2")
		expect(redacted).toContain('"name": "API_TOKEN"')
	})

	it("redacts a closed XML element after an unclosed generic with the same name in code files", () => {
		const diff = [
			"diff --git a/auth.ts b/auth.ts",
			"@@ -0,0 +1,2 @@",
			"+type Loader = Promise<Credentials>",
			'+const xml = "<Credentials>hunter2</Credentials>"',
		].join("\n")
		expect(redactSensitiveInformation(diff)).toBe(diff.replace("hunter2", "[REDACTED]"))
	})

	it("redacts many XML credential values on one line in linear time", () => {
		const startedAt = performance.now()
		expect(redactSensitiveInformation(`+${"<password>s</password>".repeat(8_000)}`)).toBe(
			`+${"<password>[REDACTED]</password>".repeat(8_000)}`,
		)
		expect(performance.now() - startedAt).toBeLessThan(1000)
	})

	it("redacts an XML value on both diff sides when the sides share context lines", () => {
		const diff = [
			"diff --git a/settings.xml b/settings.xml",
			"@@ -1,5 +1,5 @@",
			"-<secret>",
			"+<config>",
			"   <password>",
			"-    oldvalue",
			"+    hunter2",
			"   </password>",
			"-</secret>",
			"+</config>",
		].join("\n")
		const redacted = redactSensitiveInformation(diff)
		expect(redacted).not.toContain("hunter2")
		expect(redacted).not.toContain("oldvalue")
		expect(redacted).toContain("+<config>")
	})

	it("redacts only closed XML credential elements in code files", () => {
		const diff = [
			"diff --git a/auth.ts b/auth.ts",
			"@@ -1 +1,2 @@",
			"+type Loader = Promise<Credentials>",
			'+const xml = "<password>hunter2</password>"',
		].join("\n")
		expect(redactSensitiveInformation(diff)).toBe(
			diff.replace("<password>hunter2</password>", "<password>[REDACTED]</password>"),
		)
	})

	it.each([
		["settings.xml.template", "+<password><![CDATA[</password>hunter2]]></password>"],
		["diagram.svg", '+<password encoding="plain">hunter2</password>'],
		["app.config.dist", "+<apiKey>\n+  hunter2\n+</apiKey>"],
	])("redacts XML credential values in %s", (file, body) => {
		const redacted = redactSensitiveInformation(`diff --git a/${file} b/${file}\n@@ -0,0 +1 @@\n${body}`)
		expect(redacted).not.toContain("hunter2")
		expect(redacted).toContain("[REDACTED]")
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
		["many unfinished tags", "<a".repeat(100_000)],
		["many unterminated comments", "<!-".repeat(60_000)],
		["many name lines without a value", "+- name: DB_PASSWORD\n".repeat(9_000)],
		["many lines with a closed XML element", "<a>x</a>\n".repeat(20_000)],
		["many URL schemes without a password", "://:".repeat(50_000)],
		["a long snake_case name without a token suffix", "a_".repeat(100_000)],
		["deeply nested records", "{".repeat(100_000)],
		["many closed records", "{}".repeat(100_000)],
		["many record fields outside a record", 'value: "x", '.repeat(20_000)],
		["many unterminated strings", "'a\n".repeat(60_000)],
		["many records after long keys", `${"k".repeat(120)}: {}\n`.repeat(2_000)],
		["many unclosed tags with values", "<a value=x ".repeat(20_000)],
	])("redacts %s in linear time", (_label, content) => {
		// A quadratic scan of 200k characters takes far longer than this budget.
		const startedAt = performance.now()
		expect(redactSensitiveInformation(content)).toBe(content)
		expect(performance.now() - startedAt).toBeLessThan(1000)
	})
})
