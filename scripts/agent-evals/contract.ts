import type { RooCodeSettings } from "@roo-code/types"

export interface AgentFixtureWorkspaceFile {
	path: string
	content: string
}

export interface AgentFixtureToolAllow {
	readOnly: boolean
	readOnlyOutsideWorkspace: boolean
	write: boolean
	writeOutsideWorkspace: boolean
	writeProtected: boolean
	execute: boolean
	mcp: boolean
	modeSwitch: boolean
	subtasks: boolean
	followupQuestions: boolean
}

export interface AgentFixtureLimits {
	activationTimeoutMs: number
	taskStartTimeoutMs: number
	taskRunTimeoutMs: number
	usageDrainMs: number
	teardownStepMs: number
}

// A fixture is trusted, in-repo data. The contract deliberately carries no
// executable hooks, no URLs to fetch, and no file paths outside the declared
// workspace files. The only function is the settings builder, which maps a
// credential to extension settings and never receives anything else.
export interface AgentFixture {
	identity: {
		name: string
		version: string
		description: string
	}
	prompt: string
	workspace: {
		files: readonly AgentFixtureWorkspaceFile[]
	}
	toolPolicy: {
		mode: string
		roleDefinition: string
		groups: readonly string[]
		disabledTools: readonly string[]
		allow: AgentFixtureToolAllow
	}
	limits: AgentFixtureLimits
	// Explicit nonsecret mirror of the built configuration. The trace digests
	// this projection; it must never contain the credential.
	settingsProjection: Record<string, unknown>
	buildConfiguration(credential: string): RooCodeSettings
}

export class FixtureValidationError extends Error {}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const MAX_DESCRIPTION_CHARS = 300
const MAX_PROMPT_CHARS = 8_000
const MAX_MODE_CHARS = 64
const MAX_ROLE_CHARS = 2_000
const MAX_PATH_CHARS = 256
const MAX_FILES = 64
const MAX_FILE_CHARS = 16_384
const MAX_TOTAL_FILE_CHARS = 262_144
const MAX_PROJECTION_CHARS = 16_384
const MAX_LIMIT_MS = 600_000
const MAX_DRAIN_MS = 60_000

const ALLOW_KEYS = [
	"readOnly",
	"readOnlyOutsideWorkspace",
	"write",
	"writeOutsideWorkspace",
	"writeProtected",
	"execute",
	"mcp",
	"modeSwitch",
	"subtasks",
	"followupQuestions",
] as const satisfies readonly (keyof AgentFixtureToolAllow)[]

const LIMIT_KEYS = [
	"activationTimeoutMs",
	"taskStartTimeoutMs",
	"taskRunTimeoutMs",
	"usageDrainMs",
	"teardownStepMs",
] as const satisfies readonly (keyof AgentFixtureLimits)[]

const fail = (message: string): never => {
	throw new FixtureValidationError(message)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const boundedString = (value: unknown, max: number, label: string): string => {
	if (typeof value !== "string" || value.length === 0 || value.length > max)
		return fail(`${label} missing or out of bounds`)
	return value
}

// Trust-boundary check. The launcher repeats the containment check at write
// time; this check rejects malformed fixture data at registration.
export function validateWorkspaceFilePath(pathValue: string): void {
	if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.length > MAX_PATH_CHARS)
		fail("workspace file path missing or out of bounds")
	if (pathValue.includes("\\")) fail("workspace file path must use forward slashes")
	if (pathValue.includes("\0")) fail("workspace file path must not contain a NUL byte")
	if (pathValue.startsWith("/")) fail("workspace file path must be relative")
	if (/^[a-zA-Z]:/.test(pathValue)) fail("workspace file path must not carry a drive letter")
	for (const segment of pathValue.split("/"))
		if (segment === "" || segment === "." || segment === "..")
			fail("workspace file path segments must be plain names")
}

const serializeProjection = (projection: Record<string, unknown>): string | undefined => {
	try {
		return JSON.stringify(projection)
	} catch {
		return undefined
	}
}

// The built configuration is what the extension runs. It must carry exactly the
// declared tool policy, so a drifted builder cannot widen tool access.
export function configurationMatchesToolPolicy(
	config: Record<string, unknown>,
	policy: AgentFixture["toolPolicy"],
): boolean {
	const sameList = (a: unknown, b: readonly string[]) =>
		Array.isArray(a) && a.length === b.length && b.every((item) => a.includes(item))
	if (config["mode"] !== policy.mode || !sameList(config["disabledTools"], policy.disabledTools)) return false
	const modes = config["customModes"]
	const custom = Array.isArray(modes) ? modes.find((m) => isPlainObject(m) && m["slug"] === policy.mode) : undefined
	if (!isPlainObject(custom) || custom["roleDefinition"] !== policy.roleDefinition) return false
	if (!sameList(custom["groups"], policy.groups)) return false
	return ALLOW_KEYS.every((key) => config[`alwaysAllow${key[0]!.toUpperCase()}${key.slice(1)}`] === policy.allow[key])
}

export function validateFixture(fixture: AgentFixture): void {
	if (!isPlainObject(fixture)) fail("fixture must be an object")
	if (!isPlainObject(fixture.identity)) fail("fixture identity missing")
	boundedString(fixture.identity.name, 64, "fixture name")
	if (!NAME_PATTERN.test(fixture.identity.name)) fail("fixture name must be lowercase kebab case")
	if (typeof fixture.identity.version !== "string" || !VERSION_PATTERN.test(fixture.identity.version))
		fail("fixture version must be semver")
	boundedString(fixture.identity.description, MAX_DESCRIPTION_CHARS, "fixture description")
	boundedString(fixture.prompt, MAX_PROMPT_CHARS, "fixture prompt")

	if (!isPlainObject(fixture.workspace) || !Array.isArray(fixture.workspace.files)) fail("fixture workspace missing")
	if (fixture.workspace.files.length > MAX_FILES) fail("too many workspace files")
	let totalChars = 0
	for (const file of fixture.workspace.files) {
		if (!isPlainObject(file)) fail("workspace file must be an object")
		validateWorkspaceFilePath(file.path)
		if (typeof file.content !== "string" || file.content.length > MAX_FILE_CHARS)
			fail("workspace file content missing or too large")
		totalChars += file.content.length
		if (totalChars > MAX_TOTAL_FILE_CHARS) fail("workspace files exceed the total size budget")
	}

	if (!isPlainObject(fixture.toolPolicy)) fail("fixture tool policy missing")
	boundedString(fixture.toolPolicy.mode, MAX_MODE_CHARS, "tool policy mode")
	boundedString(fixture.toolPolicy.roleDefinition, MAX_ROLE_CHARS, "tool policy role definition")
	if (!Array.isArray(fixture.toolPolicy.groups)) fail("tool policy groups missing")
	if (!fixture.toolPolicy.groups.every((group) => typeof group === "string"))
		fail("tool policy groups must be strings")
	if (!Array.isArray(fixture.toolPolicy.disabledTools) || fixture.toolPolicy.disabledTools.length === 0)
		fail("tool policy must disable at least one tool")
	if (!fixture.toolPolicy.disabledTools.every((tool) => typeof tool === "string"))
		fail("disabled tools must be strings")
	if (!isPlainObject(fixture.toolPolicy.allow)) fail("tool policy allowances missing")
	for (const key of ALLOW_KEYS)
		if (typeof fixture.toolPolicy.allow[key] !== "boolean") fail(`tool policy allowance ${key} must be boolean`)

	if (!isPlainObject(fixture.limits)) fail("fixture limits missing")
	for (const key of LIMIT_KEYS) {
		const limit = fixture.limits[key]
		if (!Number.isInteger(limit) || (limit as number) <= 0 || (limit as number) > MAX_LIMIT_MS)
			fail(`fixture limit ${key} must be a positive integer within bounds`)
	}
	if ((fixture.limits.usageDrainMs as number) > MAX_DRAIN_MS) fail("usage drain bound exceeds its cap")

	if (!isPlainObject(fixture.settingsProjection)) fail("settings projection missing")
	const projectionJson = serializeProjection(fixture.settingsProjection)
	if (projectionJson === undefined || projectionJson.length > MAX_PROJECTION_CHARS)
		fail("settings projection out of bounds")

	if (typeof fixture.buildConfiguration !== "function") fail("fixture settings builder missing")
}
