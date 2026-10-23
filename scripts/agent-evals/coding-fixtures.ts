import type { RooCodeSettings } from "@roo-code/types"
import type { AgentFixture, AgentFixtureWorkspaceFile } from "./contract.ts"
import type { GraderResources } from "./coding-grader.ts"
import { GRADER_IMAGE } from "./container-runtime.ts"

// Suite provider. Mirrors the smoke fixture provider endpoint so a coding run
// uses the same trusted, preconfigured provider as the smoke run.
export const CODING_BASE_URL = "https://api.solheim.ai/v1"
export const CODING_MODEL_ID = "qwen3.8-27b"

const CODING_ROLE_DEFINITION = "Complete one bounded coding task in this workspace. Work only inside the workspace."
const CODING_DISABLED_TOOLS = [
	"ask_followup_question",
	"new_task",
	"switch_mode",
	"update_todo_list",
	"skill",
	"run_slash_command",
] as const

export const CODING_GRADER_RESOURCES: GraderResources = {
	timeoutMs: 30_000,
	memoryMb: 512,
	cpus: 1,
	pidsLimit: 128,
	image: GRADER_IMAGE,
}

function buildCodingConfiguration(apiKey: string): RooCodeSettings {
	return {
		apiProvider: "openai",
		openAiBaseUrl: CODING_BASE_URL,
		openAiApiKey: apiKey,
		openAiModelId: CODING_MODEL_ID,
		openAiR1FormatEnabled: true,
		openAiExtraBody: JSON.stringify({ chat_template_kwargs: { enable_thinking: false } }),
		modelMaxTokens: 8192,
		autoCondenseContext: false,
		mode: "coding-eval",
		customModes: [
			{
				slug: "coding-eval",
				name: "Coding eval",
				roleDefinition: CODING_ROLE_DEFINITION,
				groups: ["read", "edit", "command"],
			},
		],
		disabledTools: [...CODING_DISABLED_TOOLS],
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: true,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowExecute: true,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowFollowupQuestions: false,
	}
}

// Explicit nonsecret mirror of the built configuration. Must stay in step
// with buildCodingConfiguration; the registry checks the builder against the
// tool policy and the trace digests the projection.
const codingSettingsProjection: Record<string, unknown> = {
	apiProvider: "openai",
	openAiBaseUrl: CODING_BASE_URL,
	openAiModelId: CODING_MODEL_ID,
	openAiR1FormatEnabled: true,
	openAiExtraBody: { chat_template_kwargs: { enable_thinking: false } },
	modelMaxTokens: 8192,
	autoCondenseContext: false,
	mode: "coding-eval",
	customModes: [
		{
			slug: "coding-eval",
			name: "Coding eval",
			roleDefinition: CODING_ROLE_DEFINITION,
			groups: ["read", "edit", "command"],
		},
	],
	disabledTools: [...CODING_DISABLED_TOOLS],
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	alwaysAllowWrite: true,
	alwaysAllowWriteOutsideWorkspace: false,
	alwaysAllowWriteProtected: false,
	alwaysAllowExecute: true,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowFollowupQuestions: false,
}

export interface CodingFixtureBundle {
	fixture: AgentFixture
	grading: {
		// Hidden acceptance tests. Copied into a fresh grading copy after the
		// run. Never part of the workspace the agent sees.
		hiddenTests: readonly AgentFixtureWorkspaceFile[]
		// Reference solutions, each an overlay over the workspace files. The
		// known-correct solution must pass the grader; the deliberately
		// incorrect solution must fail it while passing the visible tests.
		correctSolution: readonly AgentFixtureWorkspaceFile[]
		incorrectSolution: readonly AgentFixtureWorkspaceFile[]
		resources: GraderResources
	}
}

const workspacePackageJson = (name: string): AgentFixtureWorkspaceFile => ({
	path: "package.json",
	content: `${JSON.stringify(
		{
			name: `${name}-workspace`,
			private: true,
			version: "1.0.0",
			scripts: { test: "node --test test/" },
		},
		null,
		2,
	)}\n`,
})

const codingLimits = {
	activationTimeoutMs: 120_000,
	taskStartTimeoutMs: 35_000,
	taskRunTimeoutMs: 300_000,
	usageDrainMs: 10_000,
	teardownStepMs: 10_000,
}

const bundle = (
	name: string,
	version: string,
	description: string,
	prompt: string,
	files: readonly AgentFixtureWorkspaceFile[],
	hiddenTests: readonly AgentFixtureWorkspaceFile[],
	correctSolution: readonly AgentFixtureWorkspaceFile[],
	incorrectSolution: readonly AgentFixtureWorkspaceFile[],
): CodingFixtureBundle => ({
	fixture: {
		identity: { name, version, description },
		prompt,
		workspace: { files },
		toolPolicy: {
			mode: "coding-eval",
			roleDefinition: CODING_ROLE_DEFINITION,
			groups: ["read", "edit", "command"],
			disabledTools: [...CODING_DISABLED_TOOLS],
			allow: {
				readOnly: true,
				readOnlyOutsideWorkspace: false,
				write: true,
				writeOutsideWorkspace: false,
				writeProtected: false,
				execute: true,
				mcp: false,
				modeSwitch: false,
				subtasks: false,
				followupQuestions: false,
			},
		},
		limits: codingLimits,
		settingsProjection: codingSettingsProjection,
		buildConfiguration: buildCodingConfiguration,
	},
	grading: { hiddenTests, correctSolution, incorrectSolution, resources: CODING_GRADER_RESOURCES },
})

// ---------------------------------------------------------------------------
// Fixture 1: clamp-range
// ---------------------------------------------------------------------------

const clampStub = `// Clamp a number into a closed range.
//
// clamp(value, min, max) returns value when min <= value <= max. A value
// below min returns min. A value above max returns max. When min is greater
// than max the range is empty and clamp returns min for every value. A NaN
// value returns NaN.

function clamp(value, min, max) {
	throw new Error("TODO: implement clamp")
}

module.exports = { clamp }
`

const clampVisibleTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { clamp } = require("../src/clamp.js")

test("keeps in-range values unchanged", () => {
	assert.strictEqual(clamp(5, 0, 10), 5)
})

test("pulls values below the range down to min", () => {
	assert.strictEqual(clamp(-1, 0, 10), 0)
})

test("pulls values above the range up to max", () => {
	assert.strictEqual(clamp(11, 0, 10), 10)
})
`

const clampHiddenTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { clamp } = require("../src/clamp.js")

test("returns min for an empty range", () => {
	assert.strictEqual(clamp(5, 10, 2), 10)
})

test("returns min for an empty range at the min boundary", () => {
	assert.strictEqual(clamp(10, 10, 2), 10)
})

test("returns max for an empty range at the max boundary", () => {
	assert.strictEqual(clamp(2, 10, 2), 10)
})
`

const clampCorrect = `// Clamp a number into a closed range.
function clamp(value, min, max) {
	if (min > max) return min
	if (value < min) return min
	if (value > max) return max
	return value
}

module.exports = { clamp }
`

const clampIncorrect = `function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max)
}

module.exports = { clamp }
`

// ---------------------------------------------------------------------------
// Fixture 2: slugify-text
// ---------------------------------------------------------------------------

const slugifyStub = `// Convert text into a URL slug.
//
// slugify(text) lowercases the text, keeps latin letters and digits, and
// replaces every run of all other characters with exactly one dash. Leading
// and trailing runs produce no dashes. An empty result for empty input is a
// valid slug.

function slugify(text) {
	throw new Error("TODO: implement slugify")
}

module.exports = { slugify }
`

const slugifyVisibleTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { slugify } = require("../src/slugify.js")

test("joins words with one dash", () => {
	assert.strictEqual(slugify("Hello World"), "hello-world")
})

test("collapses runs of separators", () => {
	assert.strictEqual(slugify("A  B"), "a-b")
})

test("keeps letters and digits", () => {
	assert.strictEqual(slugify("abc123"), "abc123")
})
`

const slugifyHiddenTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { slugify } = require("../src/slugify.js")

test("treats punctuation as separators", () => {
	assert.strictEqual(slugify("Hello,  World!!"), "hello-world")
})

test("trims leading and trailing separators", () => {
	assert.strictEqual(slugify(" --A-- "), "a")
})

test("returns an empty slug for empty input", () => {
	assert.strictEqual(slugify(""), "")
})
`

const slugifyCorrect = `// Convert text into a URL slug.
function slugify(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

module.exports = { slugify }
`

const slugifyIncorrect = `function slugify(text) {
	return text.toLowerCase().trim().replace(/\\s+/g, "-")
}

module.exports = { slugify }
`

// ---------------------------------------------------------------------------
// Fixture 3: parse-csv-line
// ---------------------------------------------------------------------------

const csvStub = `// Parse one single-line CSV record.
//
// parseCsvLine(line) splits the line on commas. A field that starts with a
// double quote is quoted: it may contain commas and ends at the next double
// quote. Inside a quoted field, a doubled double-quote (\"\") stands for one
// literal double quote. Unquoted fields stay exactly as written, with no
// trimming.

function parseCsvLine(line) {
	throw new Error("TODO: implement parseCsvLine")
}

module.exports = { parseCsvLine }
`

const csvVisibleTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { parseCsvLine } = require("../src/parse-csv-line.js")

test("splits plain fields on commas", () => {
	assert.deepStrictEqual(parseCsvLine("a,b,c"), ["a", "b", "c"])
})

test("keeps commas inside quoted fields", () => {
	assert.deepStrictEqual(parseCsvLine('"x,y",z'), ["x,y", "z"])
})

test("returns a single field for a bare line", () => {
	assert.deepStrictEqual(parseCsvLine("plain"), ["plain"])
})
`

const csvHiddenTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { parseCsvLine } = require("../src/parse-csv-line.js")

test("unescapes doubled quotes inside quoted fields", () => {
	assert.deepStrictEqual(parseCsvLine('"he said ""hi""",ok'), ['he said "hi"', "ok"])
})

test("keeps a trailing empty field", () => {
	assert.deepStrictEqual(parseCsvLine("a,"), ["a", ""])
})

test("parses a quoted empty string", () => {
	assert.deepStrictEqual(parseCsvLine('""'), [""])
})
`

const csvCorrect = `function parseCsvLine(line) {
	const fields = []
	let current = ""
	let inQuotes = false
	for (let index = 0; index < line.length; index++) {
		const ch = line[index]
		if (inQuotes) {
			if (ch === '"') {
				if (line[index + 1] === '"') {
					current += '"'
					index++
				} else {
					inQuotes = false
				}
			} else {
				current += ch
			}
			continue
		}
		if (ch === '"' && current.length === 0) {
			inQuotes = true
			continue
		}
		if (ch === ",") {
			fields.push(current)
			current = ""
			continue
		}
		current += ch
	}
	fields.push(current)
	return fields
}

module.exports = { parseCsvLine }
`

// Plausible but wrong: quote-aware, without doubled-quote unescaping.
const csvIncorrect = `function parseCsvLine(line) {
	const fields = []
	let current = ""
	let inQuotes = false
	for (const ch of line) {
		if (inQuotes) {
			if (ch === '"') {
				inQuotes = false
				continue
			}
			current += ch
			continue
		}
		if (ch === '"') {
			inQuotes = true
			continue
		}
		if (ch === ",") {
			fields.push(current)
			current = ""
			continue
		}
		current += ch
	}
	fields.push(current)
	return fields
}

module.exports = { parseCsvLine }
`

// ---------------------------------------------------------------------------
// Fixture 4: format-bytes
// ---------------------------------------------------------------------------

const bytesStub = `// Format a byte count with SI decimal units.
//
// formatBytes(bytes) returns "0 B" for zero. Counts below 1000 return the
// integer with the unit "B". From 1000 upward it uses the units kB, MB, GB,
// and TB, dividing by 1000 at each step, always with exactly one decimal.

function formatBytes(bytes) {
	throw new Error("TODO: implement formatBytes")
}

module.exports = { formatBytes }
`

const bytesVisibleTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { formatBytes } = require("../src/format-bytes.js")

test("formats small counts in bytes", () => {
	assert.strictEqual(formatBytes(500), "500 B")
})

test("formats one decimal kilobytes", () => {
	assert.strictEqual(formatBytes(1500), "1.5 kB")
})

test("formats exact byte counts without decimals", () => {
	assert.strictEqual(formatBytes(123), "123 B")
})
`

const bytesHiddenTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { formatBytes } = require("../src/format-bytes.js")

test("formats zero bytes", () => {
	assert.strictEqual(formatBytes(0), "0 B")
})

test("uses decimal megabytes, not binary", () => {
	assert.strictEqual(formatBytes(2500000), "2.5 MB")
})

test("uses decimal gigabytes, not binary", () => {
	assert.strictEqual(formatBytes(1000000000), "1.0 GB")
})

test("keeps the last byte below the kilobyte boundary", () => {
	assert.strictEqual(formatBytes(999), "999 B")
})
`

const bytesCorrect = `function formatBytes(bytes) {
	if (bytes === 0) return "0 B"
	if (bytes < 1000) return \`\${bytes} B\`
	const units = ["kB", "MB", "GB", "TB"]
	let value = bytes
	let unit = -1
	do {
		value /= 1000
		unit++
	} while (value >= 1000 && unit < units.length - 1)
	return \`\${value.toFixed(1)} \${units[unit]}\`
}

module.exports = { formatBytes }
`

// Plausible but wrong: binary divisors and boundaries.
const bytesIncorrect = `function formatBytes(bytes) {
	if (bytes === 0) return "0 B"
	const units = ["B", "kB", "MB", "GB", "TB"]
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit++
	}
	return unit === 0 ? \`\${value} B\` : \`\${value.toFixed(1)} \${units[unit]}\`
}

module.exports = { formatBytes }
`

// ---------------------------------------------------------------------------
// Fixture 5: deep-get
// ---------------------------------------------------------------------------

const deepGetStub = `// Read a value from an object by dot path.
//
// get(object, path) splits the path on dots and walks the object. Numeric
// segments index arrays. A missing key, a missing intermediate object, or a
// null intermediate returns undefined. get never throws on missing data.

function get(object, path) {
	throw new Error("TODO: implement get")
}

module.exports = { get }
`

const deepGetVisibleTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { get } = require("../src/deep-get.js")

test("reads nested objects", () => {
	assert.strictEqual(get({ a: { b: 1 } }, "a.b"), 1)
})

test("indexes arrays with numeric segments", () => {
	assert.strictEqual(get({ a: [10, 20] }, "a.1"), 20)
})
`

const deepGetHiddenTest = `const { test } = require("node:test")
const assert = require("node:assert")
const { get } = require("../src/deep-get.js")

test("returns undefined for a missing path on an empty object", () => {
	assert.strictEqual(get({}, "a.b"), undefined)
})

test("returns undefined past a non-object intermediate", () => {
	assert.strictEqual(get({ a: 1 }, "a.b.c"), undefined)
})

test("walks through arrays and objects", () => {
	assert.strictEqual(get({ a: [{ b: 3 }] }, "a.0.b"), 3)
})

test("returns undefined for an absent root key", () => {
	assert.strictEqual(get({ a: { b: 2 } }, "x.y"), undefined)
})
`

const deepGetCorrect = `function get(object, path) {
	let current = object
	for (const segment of path.split(".")) {
		if (current === null || current === undefined) return undefined
		current = current[segment]
	}
	return current
}

module.exports = { get }
`

// Plausible but wrong: throws on missing intermediates.
const deepGetIncorrect = `function get(object, path) {
	return path.split(".").reduce((value, key) => value[key], object)
}

module.exports = { get }
`

// ---------------------------------------------------------------------------
// Frozen suite definition. Fixture data is frozen: editing any prompt, file,
// test, or solution changes the suite digest and invalidates comparisons.
// ---------------------------------------------------------------------------

export const CODING_FIXTURE_BUNDLES: readonly CodingFixtureBundle[] = [
	bundle(
		"clamp-range",
		"1.0.0",
		"Implement clamp(value, min, max) with empty-range semantics; visible tests miss the empty-range case.",
		"Implement the clamp function in src/clamp.js so the test suite passes. The header comment in src/clamp.js defines the exact behavior, including the empty range rule. Check your work with npm test. Do not modify the test files or package.json.",
		[
			workspacePackageJson("clamp-range"),
			{ path: "src/clamp.js", content: clampStub },
			{ path: "test/clamp.test.js", content: clampVisibleTest },
		],
		[{ path: "test/clamp.acceptance.test.js", content: clampHiddenTest }],
		[{ path: "src/clamp.js", content: clampCorrect }],
		[{ path: "src/clamp.js", content: clampIncorrect }],
	),
	bundle(
		"slugify-text",
		"1.0.0",
		"Implement slugify(text) with punctuation-as-separator semantics; visible tests miss punctuation runs.",
		"Implement the slugify function in src/slugify.js so the test suite passes. The header comment in src/slugify.js defines the exact behavior. Check your work with npm test. Do not modify the test files or package.json.",
		[
			workspacePackageJson("slugify-text"),
			{ path: "src/slugify.js", content: slugifyStub },
			{ path: "test/slugify.test.js", content: slugifyVisibleTest },
		],
		[{ path: "test/slugify.acceptance.test.js", content: slugifyHiddenTest }],
		[{ path: "src/slugify.js", content: slugifyCorrect }],
		[{ path: "src/slugify.js", content: slugifyIncorrect }],
	),
	bundle(
		"parse-csv-line",
		"1.0.0",
		"Implement parseCsvLine(line) with doubled-quote unescaping; visible tests miss escaped quotes.",
		"Implement the parseCsvLine function in src/parse-csv-line.js so the test suite passes. The header comment in src/parse-csv-line.js defines the quoting rules, including doubled quotes. Check your work with npm test. Do not modify the test files or package.json.",
		[
			workspacePackageJson("parse-csv-line"),
			{ path: "src/parse-csv-line.js", content: csvStub },
			{ path: "test/parse-csv-line.test.js", content: csvVisibleTest },
		],
		[{ path: "test/parse-csv-line.acceptance.test.js", content: csvHiddenTest }],
		[{ path: "src/parse-csv-line.js", content: csvCorrect }],
		[{ path: "src/parse-csv-line.js", content: csvIncorrect }],
	),
	bundle(
		"format-bytes",
		"1.0.0",
		"Implement formatBytes(bytes) with SI decimal units; visible tests miss zero and the MB and GB boundaries.",
		"Implement the formatBytes function in src/format-bytes.js so the test suite passes. The header comment in src/format-bytes.js defines the exact units and rounding. Check your work with npm test. Do not modify the test files or package.json.",
		[
			workspacePackageJson("format-bytes"),
			{ path: "src/format-bytes.js", content: bytesStub },
			{ path: "test/format-bytes.test.js", content: bytesVisibleTest },
		],
		[{ path: "test/format-bytes.acceptance.test.js", content: bytesHiddenTest }],
		[{ path: "src/format-bytes.js", content: bytesCorrect }],
		[{ path: "src/format-bytes.js", content: bytesIncorrect }],
	),
	bundle(
		"deep-get",
		"1.0.0",
		"Implement get(object, path) that never throws on missing data; visible tests miss the missing-data paths.",
		"Implement the get function in src/deep-get.js so the test suite passes. The header comment in src/deep-get.js defines the missing-data rules. Check your work with npm test. Do not modify the test files or package.json.",
		[
			workspacePackageJson("deep-get"),
			{ path: "src/deep-get.js", content: deepGetStub },
			{ path: "test/deep-get.test.js", content: deepGetVisibleTest },
		],
		[{ path: "test/deep-get.acceptance.test.js", content: deepGetHiddenTest }],
		[{ path: "src/deep-get.js", content: deepGetCorrect }],
		[{ path: "src/deep-get.js", content: deepGetIncorrect }],
	),
]
