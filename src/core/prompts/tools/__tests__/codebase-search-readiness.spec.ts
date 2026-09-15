import type OpenAI from "openai"
import type { ModeConfig } from "@roo-code/types"
import type { CodeIndexManager } from "../../../../services/code-index/manager"
import { filterNativeToolsForMode, getAvailableToolsInGroup, isToolAllowedInMode } from "../filter-tools-for-mode"

type Readiness = Pick<CodeIndexManager, "isFeatureEnabled" | "isFeatureConfigured" | "isInitialized">

function makeManager(flags: Readiness): CodeIndexManager {
	// These filters only read the three public readiness getters; no manager services are needed.
	return flags as CodeIndexManager
}

const ready = { isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }
const nativeTools: OpenAI.Chat.ChatCompletionTool[] = [
	"codebase_search",
	"read_file",
	"list_files",
	"search_files",
].map((name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } }))
const noReadMode: ModeConfig = { slug: "no-read", name: "No read", roleDefinition: "No reading", groups: ["command"] }

function checkAvailability(
	manager: CodeIndexManager | undefined,
	expected: boolean,
	mode = "code",
	settings: { disabledTools?: string[] } = {},
) {
	const names = filterNativeToolsForMode(nativeTools, mode, [noReadMode], {}, manager, settings).flatMap((tool) =>
		"function" in tool ? [tool.function.name] : [],
	)
	const group = getAvailableToolsInGroup("read", mode, [noReadMode], {}, manager, settings)
	expect(names.includes("codebase_search")).toBe(expected)
	expect(isToolAllowedInMode("codebase_search", mode, [noReadMode], {}, manager, settings)).toBe(expected)
	expect(group.includes("codebase_search")).toBe(expected)
	for (const tool of ["read_file", "list_files", "search_files"] as const) {
		expect(names.includes(tool)).toBe(mode === "code")
		expect(isToolAllowedInMode(tool, mode, [noReadMode], {}, manager, settings)).toBe(mode === "code")
		expect(group.includes(tool)).toBe(mode === "code")
	}
}

describe("codebase_search readiness across mode filtering APIs", () => {
	it("excludes search without a manager while retaining ordinary read tools", () => {
		checkAvailability(undefined, false)
	})

	for (const isFeatureEnabled of [false, true]) {
		for (const isFeatureConfigured of [false, true]) {
			for (const isInitialized of [false, true]) {
				it(`agrees for enabled=${isFeatureEnabled}, configured=${isFeatureConfigured}, initialized=${isInitialized}`, () => {
					checkAvailability(
						makeManager({ isFeatureEnabled, isFeatureConfigured, isInitialized }),
						isFeatureEnabled && isFeatureConfigured && isInitialized,
					)
				})
			}
		}
	}

	it.each(["isFeatureEnabled", "isFeatureConfigured", "isInitialized"] as const)(
		"rereads live %s changes",
		(flag) => {
			const flags = { ...ready }
			const manager = makeManager(flags)
			checkAvailability(manager, true)
			flags[flag] = false
			checkAvailability(manager, false)
			flags[flag] = true
			checkAvailability(manager, true)
		},
	)

	it("keeps alternating managers isolated", () => {
		const enabled = makeManager({ ...ready })
		const disabled = makeManager({ ...ready, isFeatureEnabled: false })
		checkAvailability(enabled, true)
		checkAvailability(disabled, false)
		checkAvailability(undefined, false)
		checkAvailability(enabled, true)
	})

	it("does not bypass a mode without the read group", () => {
		checkAvailability(makeManager({ ...ready }), false, "no-read")
	})

	it("does not bypass disabledTools with a ready manager", () => {
		checkAvailability(makeManager({ ...ready }), false, "code", { disabledTools: ["codebase_search"] })
	})
})
