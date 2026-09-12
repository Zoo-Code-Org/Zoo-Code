// npx vitest src/core/webview/__tests__/generateSystemPrompt.spec.ts
//
// Preview parity: generateSystemPrompt (the webview preview path) must produce
// the same CAPABILITIES / RULES / SYSTEM INFORMATION sections as a direct
// SYSTEM_PROMPT call built from the *same* inputs — including a full ModelInfo,
// so model-level excludedTools/includedTools are honored in the preview exactly
// like the runtime path. The old `{ isStealthModel }`-only typing silently
// allowed the preview to ignore them.

vi.mock("os", () => ({
	default: {
		homedir: () => "/home/user",
		platform: () => "linux",
		arch: () => "x64",
		type: () => "Linux",
		release: () => "5.4.0",
		hostname: () => "test-host",
		tmpdir: () => "/tmp",
		endianness: () => "LE",
		loadavg: () => [0, 0, 0],
		totalmem: () => 8589934592,
		freemem: () => 4294967296,
		cpus: () => [],
		networkInterfaces: () => ({}),
		userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
	},
	homedir: () => "/home/user",
	platform: () => "linux",
	arch: () => "x64",
	type: () => "Linux",
	release: () => "5.4.0",
	hostname: () => "test-host",
	tmpdir: () => "/tmp",
	endianness: () => "LE",
	loadavg: () => [0, 0, 0],
	totalmem: () => 8589934592,
	freemem: () => 4294967296,
	cpus: () => [],
	networkInterfaces: () => ({}),
	userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
}))

vi.mock("os-name", () => ({
	default: () => "Linux",
}))

vi.mock("fs/promises")

import * as vscode from "vscode"

import type { ModelInfo } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { SYSTEM_PROMPT } from "../../prompts/system"
import { getCapabilitiesSection } from "../../prompts/sections/capabilities"
import { getRulesSection } from "../../prompts/sections/rules"
import type { EffectiveToolPolicy } from "../../prompts/tools/effective-tool-policy"
import { generateSystemPrompt } from "../generateSystemPrompt"
import type { ClineProvider } from "../ClineProvider"
import "../../../utils/path"

// Mock vscode — generateSystemPrompt reads env.language and workspace config.
vi.mock("vscode", () => ({
	env: {
		language: "en",
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/test/path" } }],
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(undefined),
		}),
		getWorkspaceFolder: vi.fn().mockReturnValue({ uri: { fsPath: "/test/path" } }),
	},
	window: {
		activeTextEditor: undefined,
	},
	EventEmitter: vi.fn().mockImplementation(function () {
		return {
			event: vi.fn(),
			fire: vi.fn(),
			dispose: vi.fn(),
		}
	}),
}))

// getShell feeds the command-chaining text in RULES; stub it so the real
// implementation never touches the environment. vi.hoisted keeps the double
// initialized before the hoisted module-factory mock evaluates it.
const shellMock = vi.hoisted(() => ({ shell: "/bin/zsh" }))

vi.mock("../../../utils/shell", () => ({
	getShell: () => shellMock.shell,
}))

// Mock the section builders that touch the filesystem / extension context so the
// parity comparison is stable and independent of workspace state.
vi.mock("../../prompts/sections/modes", () => ({
	getModesSection: vi.fn().mockImplementation(async () => `====\n\nMODES\n\n- Test modes section`),
}))

vi.mock("../../prompts/sections/custom-instructions", () => ({
	addCustomInstructions: vi.fn().mockImplementation(async () => ""),
}))

// The preview must consume a *complete* ModelInfo from the API handler. This
// locks in that contract: if generateSystemPrompt ever narrows the local
// modelInfo back down, the excludedTools sub-assertion below fails.
const fullModelInfo: ModelInfo = {
	contextWindow: 100_000,
	supportsPromptCache: true,
	excludedTools: ["read_file"],
}

// Fallback metadata a lazily loaded router model exposes BEFORE its network
// fetch resolves. Deliberately distinct from fullModelInfo on the OUTPUT axis:
// it excludes list_files (fullModelInfo excludes read_file), so the three
// states — fallback / fetched / undefined — render three different CAPABILITIES
// sections. The parity tests only pass if generateSystemPrompt awaits
// ensureModelFetched() before reading getModel().info, and the rejection test
// below only passes if a failed fetch degrades to THIS fixture (not undefined).
const fallbackModelInfo: ModelInfo = {
	contextWindow: 32_000,
	supportsPromptCache: false,
	excludedTools: ["list_files"],
}

const modelMock = vi.hoisted(() => {
	const state = { fetched: false }
	const ensureModelFetched = vi.fn(async () => {
		state.fetched = true
	})
	return { state, ensureModelFetched }
})

// Note: the module under test imports `../../api` from src/core/webview, which
// resolves to src/api — from this spec's directory (one level deeper) that is
// `../../../api`.
vi.mock("../../../api", () => ({
	buildApiHandler: () => ({
		ensureModelFetched: modelMock.ensureModelFetched,
		// The handler only knows its full metadata (incl. excludedTools) after
		// ensureModelFetched() resolves, mirroring router providers.
		getModel: () => ({ id: "m", info: modelMock.state.fetched ? fullModelInfo : fallbackModelInfo }),
	}),
}))

// Minimal mock ExtensionContext, mirroring the pattern in system-prompt.spec.ts.
const mockContext = {
	extensionPath: "/mock/extension/path",
	globalStoragePath: "/mock/storage/path",
	storagePath: "/mock/storage/path",
	logPath: "/mock/log/path",
	subscriptions: [],
	workspaceState: {
		get: () => undefined,
		update: () => Promise.resolve(),
	},
	globalState: {
		get: () => undefined,
		update: () => Promise.resolve(),
		setKeysForSync: () => {},
	},
	extensionUri: { fsPath: "/mock/extension/path" },
	globalStorageUri: { fsPath: "/mock/settings/path" },
	asAbsolutePath: (relativePath: string) => `/mock/extension/path/${relativePath}`,
	extension: {
		packageJSON: {
			version: "1.0.0",
		},
	},
} as unknown as vscode.ExtensionContext

const fullSettings = {
	todoListEnabled: true,
	useAgentRules: true,
	newTaskRequireTodos: false,
}

describe("generateSystemPrompt preview parity", () => {
	// Spy lifecycle owned by the describe (mirrors Task.spec.ts's consoleErrorSpy
	// pattern): a failed assertion inside the rejection test must not leak a
	// stubbed console.error into later tests. afterEach restores only this spy;
	// the shared vi.fn() doubles (getStateMock, modelMock) are deliberately left
	// untouched so their defaults persist for the other tests in this file
	// (vi.resetAllMocks() would clobber them).
	let errorSpy: ReturnType<typeof vi.spyOn>

	// The temp handler starts every test in the lazy (pre-fetch) state so the
	// parity tests genuinely prove the fetch is awaited before getModel().info
	// is read.
	beforeEach(() => {
		modelMock.state.fetched = false
		modelMock.ensureModelFetched.mockClear()
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		errorSpy.mockRestore()
	})

	// Section-scoped extraction: capture the text between two "====" headers so
	// the comparison is limited to the sections the tool policy drives.
	function extractSection(prompt: string, header: string): string {
		const marker = `\n\n${header}\n\n`
		const idx = prompt.indexOf(marker)
		expect(idx).toBeGreaterThan(-1)
		const afterHeader = prompt.slice(idx + marker.length)
		const nextMarker = afterHeader.indexOf("\n\n====")
		return nextMarker === -1 ? afterHeader : afterHeader.slice(0, nextMarker)
	}

	/**
	 * ClineProvider is a heavy class; the preview only touches these members, so
	 * a minimal object literal stands in for it. This is the single double
	 * assertion in this spec.
	 */
	// The preview only destructures a handful of getState() fields, so the mock
	// returns that subset instead of a full ExtensionState; keeping the raw
	// vi.fn() (rather than vi.mocked) avoids casting the partial doubles.
	const getStateMock = vi.fn().mockResolvedValue({
		apiConfiguration: { apiProvider: providerIdentifiers.openai, apiModelId: "gpt-4o" },
		customModePrompts: undefined,
		customInstructions: undefined,
		mcpEnabled: false,
		experiments: {},
		language: undefined,
		enableSubfolderRules: false,
		disabledTools: undefined,
	})

	const fakeProvider = {
		context: mockContext,
		cwd: "/test/path",
		getState: getStateMock,
		getMcpHub: vi.fn(),
		getCurrentTask: vi.fn().mockReturnValue(undefined),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		customModesManager: {
			getCustomModes: vi.fn().mockResolvedValue([]),
		},
	} as unknown as ClineProvider

	it("produces identical CAPABILITIES, RULES, and SYSTEM INFORMATION sections for the same inputs", async () => {
		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

		// The direct SYSTEM_PROMPT call uses exactly the inputs the webview path
		// builds: same disabledTools (undefined), same full modelInfo, same
		// settings shape.
		const direct = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			"code",
			undefined, // customModePrompts
			undefined, // customModes
			undefined, // globalCustomInstructions
			{}, // experiments
			undefined, // language
			undefined, // rooIgnoreInstructions
			fullSettings, // settings
			undefined, // todoList
			undefined, // modelId
			undefined, // skillsManager
			undefined, // disabledTools
			fullModelInfo, // modelInfo
		)

		for (const header of ["CAPABILITIES", "RULES", "SYSTEM INFORMATION"]) {
			expect(extractSection(preview, header)).toEqual(extractSection(direct, header))
		}
	})

	it("honors the full modelInfo.excludedTools in the preview output", async () => {
		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })
		const capabilities = extractSection(preview, "CAPABILITIES")

		// read_file is excluded by the model info: no "read files" clause.
		expect(capabilities).not.toContain("read files")
		// Other clauses survive, proving the exclusion is scoped to that tool.
		expect(capabilities).toContain("execute CLI commands")
	})

	it("awaits ensureModelFetched before reading model info", async () => {
		// A lazily loaded router model exposes only fallback metadata until the
		// fetch resolves. The preview must await ensureModelFetched() first, or
		// it would build tool guidance from the fallback metadata (which excludes
		// list_files, not read_file) and diverge from the runtime path.
		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

		expect(modelMock.ensureModelFetched).toHaveBeenCalledTimes(1)
		// "read files" only appears with the fallback metadata; the preview must
		// reflect the fetched model info instead.
		const capabilities = extractSection(preview, "CAPABILITIES")
		expect(capabilities).not.toContain("read files")
		expect(capabilities).toContain("execute CLI commands")
	})

	it("falls back to handler model info when ensureModelFetched rejects", async () => {
		// A network failure must not drop model guidance entirely: the runtime
		// path (Task.safeEnsureModelFetched) degrades to getModel().info
		// fallback metadata, and the preview must do the same instead of
		// passing modelInfo = undefined to SYSTEM_PROMPT. The fixtures make
		// the three states distinguishable: fallbackModelInfo excludes
		// list_files, fullModelInfo excludes read_file, and undefined excludes
		// neither — so the assertion pair below pins the prompt to the
		// fallback fixture, and fails if the inner try/catch is removed: the
		// rejection would then skip getModel() and the prompt would be built
		// with modelInfo === undefined.
		modelMock.ensureModelFetched.mockRejectedValueOnce(new Error("network down"))

		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

		const capabilities = extractSection(preview, "CAPABILITIES")
		// Absent only when modelInfo === fallbackModelInfo (its exclusion).
		expect(capabilities).not.toContain("list files")
		// Present only when read_file was NOT excluded — rules out fullModelInfo.
		expect(capabilities).toContain("read files")
		expect(capabilities).toContain("execute CLI commands")
		expect(errorSpy).toHaveBeenCalled()
		// The context string is part of the contract: an empty or generic log
		// line would erase the only trace of a degraded preview.
		expect(errorSpy).toHaveBeenCalledWith(
			"Error fetching model metadata for system prompt preview:",
			expect.anything(),
		)
	})

	it("degrades to fallback metadata when ensureModelFetched hangs past the preview timeout", async () => {
		// A hung metadata endpoint (some fetchers issue unbounded GETs) must not
		// block the user-triggered preview: after PREVIEW_MODEL_FETCH_TIMEOUT_MS
		// (5s) the race resolves and the prompt is built from the fallback
		// metadata, identical to the rejected-fetch degradation.
		vi.useFakeTimers()
		try {
			modelMock.ensureModelFetched.mockImplementationOnce(() => new Promise<void>(() => {}))

			const previewPromise = generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })
			await vi.advanceTimersByTimeAsync(5_000)
			const preview = await previewPromise

			const capabilities = extractSection(preview, "CAPABILITIES")
			// Fallback fixture signature (see fallbackModelInfo): list_files
			// excluded, read_file still advertised — proves fallback metadata,
			// not undefined (which would advertise both) and not fullModelInfo
			// (which would drop "read files").
			expect(capabilities).not.toContain("list files")
			expect(capabilities).toContain("read files")
		} finally {
			vi.useRealTimers()
		}
	})

	it("omits command guidance from the preview when execute_command is disabled", async () => {
		// The preview must forward state.disabledTools to SYSTEM_PROMPT: with
		// execute_command disabled, the CAPABILITIES section drops every
		// command-related fragment. The once-value overrides the shared default
		// without mutating it for other tests.
		getStateMock.mockResolvedValueOnce({
			apiConfiguration: { apiProvider: providerIdentifiers.openai, apiModelId: "gpt-4o" },
			customModePrompts: undefined,
			customInstructions: undefined,
			mcpEnabled: false,
			experiments: {},
			language: undefined,
			enableSubfolderRules: false,
			disabledTools: ["execute_command"],
		})

		const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })
		const capabilities = extractSection(preview, "CAPABILITIES")

		expect(capabilities).not.toContain("execute CLI commands")
		expect(capabilities).not.toContain("You can use the execute_command tool")
		// Anchor: the section is still populated, proving only execute_command
		// guidance was removed.
		expect(capabilities).toContain("list files")
	})

	it("resolves when settings are omitted instead of dereferencing them", async () => {
		// generatePrompt reads `settings?.todoListEnabled`; without the optional
		// chain this call rejects with a TypeError on the undefined settings object.
		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			"code",
			undefined, // customModePrompts
			undefined, // customModes
			undefined, // globalCustomInstructions
			{}, // experiments
			undefined, // language
			undefined, // rooIgnoreInstructions
			undefined, // settings -> exercises the `settings?.` optional chain
		)

		expect(prompt).toContain("OBJECTIVE")
	})

	describe("preview metadata-fetch robustness", () => {
		it("skips the metadata fetch silently when the handler has no ensureModelFetched", async () => {
			// Providers without lazy model discovery legitimately lack
			// ensureModelFetched: the optional call must skip it and still build
			// the preview from the handler's current metadata, without logging.
			// The property is redefined to undefined on the shared double (then
			// restored) because the mocked factory reads it per buildApiHandler()
			// call, so a missing method reaches the code under test untyped.
			const descriptor = Object.getOwnPropertyDescriptor(modelMock, "ensureModelFetched")
			Object.defineProperty(modelMock, "ensureModelFetched", {
				value: undefined,
				configurable: true,
				writable: true,
			})
			try {
				const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

				expect(errorSpy).not.toHaveBeenCalled()
				const capabilities = extractSection(preview, "CAPABILITIES")
				// Fallback-fixture signature (see fallbackModelInfo): the preview is
				// still built from a complete ModelInfo, not from undefined.
				expect(capabilities).not.toContain("list files")
				expect(capabilities).toContain("read files")
			} finally {
				if (descriptor) {
					Object.defineProperty(modelMock, "ensureModelFetched", descriptor)
				}
			}
		})

		it("clears the pending preview timer once the fetch resolves first", async () => {
			vi.useFakeTimers()
			try {
				modelMock.ensureModelFetched.mockResolvedValueOnce(undefined)
				await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

				// The fetch won the race, so the still-pending timeout must have been
				// cancelled inside the same turn; a leftover timer means every fast
				// preview leaves a five-second handle behind.
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it("resolves the preview race exactly at the fetch timeout bound", async () => {
			// The race bound is an absolute wall: a hung endpoint must be released
			// precisely after 5000 ms, never a tick earlier, so a slow-but-alive
			// fetch still wins at 4999 ms.
			vi.useFakeTimers()
			try {
				modelMock.ensureModelFetched.mockImplementationOnce(() => new Promise<void>(() => {}))

				let settled = false
				const previewPromise = generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" }).then(
					(prompt) => {
						settled = true
						return prompt
					},
				)
				await vi.advanceTimersByTimeAsync(4_999)
				expect(settled).toBe(false)

				await vi.advanceTimersByTimeAsync(1)
				const preview = await previewPromise

				// Degradation at the bound mirrors the rejected-fetch path: fallback
				// metadata, and no error logged (a timeout is not a failure).
				const capabilities = extractSection(preview, "CAPABILITIES")
				expect(capabilities).not.toContain("list files")
				expect(capabilities).toContain("read files")
				expect(errorSpy).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it("logs and degrades when the model info cannot be read", async () => {
			// A throw while reading the model info escapes the fetch race and lands
			// in the outer handler: the preview must still resolve — without model
			// guidance — and log the outer-catch context string. The state double
			// is swapped for a throwing getter because the mocked factory reads it
			// inside getModel().info, which is the read the preview performs.
			const stateDescriptor = Object.getOwnPropertyDescriptor(modelMock, "state")
			Object.defineProperty(modelMock, "state", {
				value: {
					get fetched(): never {
						throw new Error("model info unavailable")
					},
				},
				configurable: true,
				writable: true,
			})
			try {
				const preview = await generateSystemPrompt(fakeProvider, { type: "mode", mode: "code" })

				expect(errorSpy).toHaveBeenCalledWith(
					"Error reading model info for system prompt preview:",
					expect.anything(),
				)
				const capabilities = extractSection(preview, "CAPABILITIES")
				// modelInfo === undefined excludes nothing: both clause families appear.
				expect(capabilities).toContain("read files")
				expect(capabilities).toContain("list files")
			} finally {
				if (stateDescriptor) {
					Object.defineProperty(modelMock, "state", stateDescriptor)
				}
			}
		})
	})
})

// ---------------------------------------------------------------------------
// Raw-policy fragment tests for the CAPABILITIES and RULES builders: drives the
// branch cells the resolver-backed specs in core/prompts/__tests__/sections.spec.ts
// cannot produce (policy objects are built directly, bypassing the resolver).
// ---------------------------------------------------------------------------
describe("getCapabilitiesSection / getRulesSection fragment gating", () => {
	const cwd = "/test/path"
	const settings = { ...fullSettings }

	/**
	 * Raw policy double: the section builders only read `tools` plus the MCP and
	 * edit-restriction fields, so a literal captures every branch the resolver
	 * could produce for these two sections.
	 */
	function sectionPolicy(
		tools: string[],
		extra: Partial<
			Pick<EffectiveToolPolicy, "hasMcpGroup" | "hasMcpTools" | "hasMcpResources" | "editRestriction">
		> = {},
	): EffectiveToolPolicy {
		return {
			tools: new Set(tools),
			hasMcpGroup: false,
			hasMcpTools: false,
			hasMcpResources: false,
			...extra,
		}
	}

	describe("getCapabilitiesSection", () => {
		it("emits every clause and paragraph when all capability tools are advertised", () => {
			const result = getCapabilitiesSection(
				sectionPolicy(
					[
						"execute_command",
						"list_files",
						"codebase_search",
						"search_files",
						"read_file",
						"write_to_file",
						"apply_diff",
					],
					{ hasMcpGroup: true, hasMcpTools: true },
				),
			)

			expect(result).toContain("====\n\nCAPABILITIES\n\n")
			expect(result).toContain(
				"You have access to tools that let you execute CLI commands on the user's computer, list files, view source code definitions, regex search, read files, write and edit files.",
			)
			expect(result).toContain("\n- These tools help you accomplish tasks.\n")
			expect(result).toContain("you can use the list_files tool")
			expect(result).toContain("You can use the execute_command tool to run commands on the user's computer")
			expect(result).toContain(
				"You have access to MCP servers that may provide additional tools and/or resources",
			)
			expect(result).not.toContain("Stryker was here")
			// The trailing newline is trimmed; the result must end with the last bullet.
			expect(result.endsWith("accomplish tasks more effectively.")).toBe(true)
		})

		it("falls back to the limited-tools sentence and omits every fragment when no capability tools are advertised", () => {
			const result = getCapabilitiesSection(sectionPolicy([]))

			expect(result).toContain(
				"You have access to a limited set of tools for this mode; only the tools you are provided may be called.",
			)
			expect(result).not.toContain("You have access to tools that let you")
			expect(result).not.toContain("execute CLI commands")
			expect(result).not.toContain("list files")
			expect(result).not.toContain("view source code definitions")
			expect(result).not.toContain("regex search")
			expect(result).not.toContain("read files")
			expect(result).not.toContain("write and edit files")
			expect(result).not.toContain("you can use the list_files tool")
			expect(result).not.toContain("You can use the execute_command tool")
			expect(result).not.toContain("MCP servers")
		})

		it("gates each clause on exactly its advertised tool", () => {
			expect(getCapabilitiesSection(sectionPolicy(["list_files"]))).toContain(
				"You have access to tools that let you list files.",
			)
			expect(getCapabilitiesSection(sectionPolicy(["codebase_search"]))).toContain(
				"You have access to tools that let you view source code definitions.",
			)
			expect(getCapabilitiesSection(sectionPolicy(["search_files"]))).toContain(
				"You have access to tools that let you regex search.",
			)
			expect(getCapabilitiesSection(sectionPolicy(["search_files"]))).not.toContain(
				"view source code definitions",
			)
			expect(getCapabilitiesSection(sectionPolicy(["read_file"]))).toContain(
				"You have access to tools that let you read files.",
			)
			expect(getCapabilitiesSection(sectionPolicy(["write_to_file"]))).toContain("write and edit files")
			expect(getCapabilitiesSection(sectionPolicy(["apply_diff"]))).toContain("write and edit files")
			expect(getCapabilitiesSection(sectionPolicy(["read_file"]))).not.toContain("write and edit files")
		})
	})

	describe("getRulesSection", () => {
		it("includes every tool-gated fragment when all relevant tools are advertised", () => {
			const result = getRulesSection(
				cwd,
				settings,
				sectionPolicy(
					[
						"execute_command",
						"ask_followup_question",
						"list_files",
						"read_file",
						"write_to_file",
						"attempt_completion",
					],
					{ editRestriction: { fileRegex: "\\.md$" } },
				),
			)

			expect(result).toContain("====\n\nRULES\n\n- ")
			expect(result).toContain("The project base directory is: /test/path")
			expect(result).toContain(
				"All file paths must be relative to this directory. However, commands may change directories in terminals, so respect working directory specified by the response to execute_command.",
			)
			expect(result).toContain("You are stuck operating from '/test/path'")
			expect(result).toContain("Do not use the ~ character or $HOME to refer to the home directory.")
			expect(result).toContain(
				"Before using the execute_command tool, you must first think about the SYSTEM INFORMATION context",
			)
			expect(result).toContain("Some modes have restrictions on which files they can edit")
			expect(result).toContain("Be sure to consider the type of project")
			expect(result).toContain("When making changes to code, always consider the context")
			expect(result).toContain("Do not ask for more information than necessary")
			expect(result).toContain(
				"You are only allowed to ask the user questions using the ask_followup_question tool",
			)
			expect(result).toContain("you should use the list_files tool to list the files in the Desktop")
			expect(result).not.toContain("Provide your best-effort result")
			expect(result).toContain("When executing commands, if you don't see the expected output")
			expect(result).toContain(
				"use the ask_followup_question tool to request the user to copy and paste it back to you",
			)
			expect(result).not.toContain("note what you expected and proceed with the task")
			expect(result).toContain("The user may provide a file's contents directly")
			expect(result).toContain(
				"Your goal is to try to accomplish the user's task, NOT engage in a back and forth conversation.",
			)
			expect(result).toContain("NEVER end attempt_completion result with a question")
			expect(result).toContain("STRICTLY FORBIDDEN from starting your messages")
			expect(result).toContain("When presented with images, utilize your vision capabilities")
			expect(result).toContain("you will automatically receive environment_details")
			expect(result).toContain('"Actively Running Terminals"')
			expect(result).toContain("It is critical you wait for the user's response after each tool use")
			expect(result).not.toContain("MCP operations should be used one at a time")
			expect(result).not.toContain("VENDOR CONFIDENTIALITY")
			// join separator: rules are bulleted one per line, not concatenated
			expect(result).toContain("/test/path\n- All file paths must be relative")
			expect(result).not.toContain("Stryker was here")
		})

		it("keeps the ask guidance but drops the list_files example when only ask_followup_question is advertised", () => {
			const result = getRulesSection(cwd, settings, sectionPolicy(["ask_followup_question"]))

			expect(result).toContain(
				"You are only allowed to ask the user questions using the ask_followup_question tool",
			)
			expect(result).not.toContain("the list_files tool")
			expect(result).not.toContain("Stryker was here!")
		})

		it("emits the MCP usage rule only when the mcp group is present and tools or resources are effective", () => {
			const mcpRule = "MCP operations should be used one at a time"

			expect(
				getRulesSection(cwd, settings, sectionPolicy([], { hasMcpGroup: true, hasMcpTools: true })),
			).toContain(mcpRule)
			expect(
				getRulesSection(cwd, settings, sectionPolicy([], { hasMcpGroup: true, hasMcpResources: true })),
			).toContain(mcpRule)
			expect(getRulesSection(cwd, settings, sectionPolicy([], { hasMcpGroup: true }))).not.toContain(mcpRule)
			expect(
				getRulesSection(cwd, settings, sectionPolicy([], { hasMcpTools: true, hasMcpResources: true })),
			).not.toContain(mcpRule)
		})

		it("tolerates undefined settings and emits vendor confidentiality only for stealth models", () => {
			const full = sectionPolicy(["execute_command", "ask_followup_question", "list_files", "read_file"])

			// The `settings?.isStealthModel` optional chain must survive an undefined settings
			// object; dropping the chain throws a TypeError inside getRulesSection.
			expect(() => getRulesSection(cwd, undefined, full)).not.toThrow()
			expect(getRulesSection(cwd, undefined, full)).not.toContain("VENDOR CONFIDENTIALITY")
			expect(getRulesSection(cwd, { ...settings, isStealthModel: true }, full)).toContain(
				"VENDOR CONFIDENTIALITY",
			)
		})
	})
})
