import { render, screen, act } from "@/utils/test-utils"
import React from "react"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

const postMessageMock = vi.fn()

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => postMessageMock(msg),
	},
}))

// Captures a broad slice of context state so each dispatched message branch can
// assert on the specific field it mutates.
const Probe = () => {
	const ctx = useExtensionState() as any
	return (
		<div>
			<div data-testid="alwaysAllowFollowupQuestions">{String(ctx.alwaysAllowFollowupQuestions)}</div>
			<div data-testid="followupAutoApproveTimeoutMs">{String(ctx.followupAutoApproveTimeoutMs)}</div>
			<div data-testid="includeTaskHistoryInEnhance">{String(ctx.includeTaskHistoryInEnhance)}</div>
			<div data-testid="includeCurrentTime">{String(ctx.includeCurrentTime)}</div>
			<div data-testid="includeCurrentCost">{String(ctx.includeCurrentCost)}</div>
			<div data-testid="marketplaceItems">{JSON.stringify(ctx.marketplaceItems)}</div>
			<div data-testid="marketplaceInstalledMetadata">{JSON.stringify(ctx.marketplaceInstalledMetadata)}</div>
			<div data-testid="autoApprovalEnabled">{String(ctx.autoApprovalEnabled)}</div>
			<div data-testid="theme">{ctx.theme ? "set" : "unset"}</div>
			<div data-testid="filePaths">{JSON.stringify(ctx.filePaths)}</div>
			<div data-testid="openedTabs">{JSON.stringify(ctx.openedTabs)}</div>
			<div data-testid="commands">{JSON.stringify(ctx.commands)}</div>
			<div data-testid="clineMessages">{JSON.stringify(ctx.clineMessages)}</div>
			<div data-testid="skills">{JSON.stringify(ctx.skills)}</div>
			<div data-testid="rules">{JSON.stringify(ctx.rules)}</div>
			<div data-testid="mcpServers">{JSON.stringify(ctx.mcpServers)}</div>
			<div data-testid="currentCheckpoint">{String(ctx.currentCheckpoint)}</div>
			<div data-testid="listApiConfigMeta">{JSON.stringify(ctx.listApiConfigMeta)}</div>
			<div data-testid="routerModels">{JSON.stringify(ctx.routerModels)}</div>
			<div data-testid="taskHistory">{JSON.stringify(ctx.taskHistory)}</div>
		</div>
	)
}

const renderProvider = () =>
	render(
		<ExtensionStateContextProvider>
			<Probe />
		</ExtensionStateContextProvider>,
	)

const dispatch = (data: unknown) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data }))
	})

const text = (id: string) => screen.getByTestId(id).textContent

describe("ExtensionStateContext handleMessage branches", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	it("applies followup/marketplace/include fields from a state message", () => {
		renderProvider()
		dispatch({
			type: "state",
			state: {
				alwaysAllowFollowupQuestions: true,
				followupAutoApproveTimeoutMs: 1234,
				includeTaskHistoryInEnhance: false,
				includeCurrentTime: false,
				includeCurrentCost: false,
				marketplaceItems: [{ name: "mcp-1" }],
				marketplaceInstalledMetadata: { project: { a: 1 }, global: {} },
			},
		})

		expect(text("alwaysAllowFollowupQuestions")).toBe("true")
		expect(text("followupAutoApproveTimeoutMs")).toBe("1234")
		expect(text("includeTaskHistoryInEnhance")).toBe("false")
		expect(text("includeCurrentTime")).toBe("false")
		expect(text("includeCurrentCost")).toBe("false")
		expect(text("marketplaceItems")).toBe('[{"name":"mcp-1"}]')
		expect(text("marketplaceInstalledMetadata")).toBe('{"project":{"a":1},"global":{}}')
	})

	it("toggles autoApprovalEnabled on the toggleAutoApprove action and posts the update", () => {
		renderProvider()
		expect(text("autoApprovalEnabled")).toBe("false")

		dispatch({ type: "action", action: "toggleAutoApprove" })
		expect(text("autoApprovalEnabled")).toBe("true")
		expect(postMessageMock).toHaveBeenCalledWith({ type: "autoApprovalEnabled", bool: true })
	})

	it("sets the theme from a theme message", () => {
		renderProvider()
		expect(text("theme")).toBe("unset")
		dispatch({ type: "theme", text: JSON.stringify({ "editor.background": "#000000" }) })
		expect(text("theme")).toBe("set")
	})

	it("updates file paths and opened tabs on workspaceUpdated", () => {
		renderProvider()
		dispatch({
			type: "workspaceUpdated",
			filePaths: ["/a", "/b"],
			openedTabs: [{ label: "a.ts", isActive: true, path: "/a" }],
		})
		expect(text("filePaths")).toBe('["/a","/b"]')
		expect(text("openedTabs")).toBe('[{"label":"a.ts","isActive":true,"path":"/a"}]')
	})

	it("sets commands on a commands message", () => {
		renderProvider()
		dispatch({ type: "commands", commands: [{ name: "build" }] })
		expect(text("commands")).toBe('[{"name":"build"}]')
	})

	it("updates an existing clineMessage on messageUpdated", () => {
		renderProvider()
		const original = { ts: 100, type: "say", say: "text", text: "hello" }
		dispatch({ type: "state", state: { clineMessages: [original] } })
		expect(text("clineMessages")).toBe(JSON.stringify([original]))

		const updated = { ...original, text: "updated" }
		dispatch({ type: "messageUpdated", clineMessage: updated })
		expect(text("clineMessages")).toBe(JSON.stringify([updated]))
	})

	it("drops messageUpdated for an unknown ts and warns", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		renderProvider()
		dispatch({ type: "state", state: { clineMessages: [{ ts: 1, type: "say", text: "keep" }] } })

		dispatch({ type: "messageUpdated", clineMessage: { ts: 999, type: "say", text: "ghost" } })

		expect(warnSpy).toHaveBeenCalled()
		expect(text("clineMessages")).toBe(JSON.stringify([{ ts: 1, type: "say", text: "keep" }]))
		warnSpy.mockRestore()
	})

	it("sets skills on a skills message", () => {
		renderProvider()
		dispatch({ type: "skills", skills: [{ name: "skill-a", path: "/s", description: "d" }] })
		expect(text("skills")).toBe('[{"name":"skill-a","path":"/s","description":"d"}]')
	})

	it("sets rules on a rules message", () => {
		renderProvider()
		dispatch({ type: "rules", rules: [{ name: "rule-1" }] })
		expect(text("rules")).toBe('[{"name":"rule-1"}]')
	})

	it("sets mcpServers on an mcpServers message", () => {
		renderProvider()
		dispatch({ type: "mcpServers", mcpServers: [{ name: "server-1" }] })
		expect(text("mcpServers")).toBe('[{"name":"server-1"}]')
	})

	it("sets the current checkpoint on currentCheckpointUpdated", () => {
		renderProvider()
		dispatch({ type: "currentCheckpointUpdated", text: "abc123" })
		expect(text("currentCheckpoint")).toBe("abc123")
	})

	it("sets listApiConfigMeta on a listApiConfig message", () => {
		renderProvider()
		dispatch({ type: "listApiConfig", listApiConfig: [{ id: "1", name: "cfg" }] })
		expect(text("listApiConfigMeta")).toBe('[{"id":"1","name":"cfg"}]')
	})

	it("replaces routerModels when no provider is given", () => {
		renderProvider()
		dispatch({ type: "routerModels", routerModels: { openrouter: { "m/1": { id: "m/1" } } } })
		expect(text("routerModels")).toBe('{"openrouter":{"m/1":{"id":"m/1"}}}')
	})

	it("merges routerModels into existing state when a provider is given", () => {
		renderProvider()
		// Seed existing routerModels via a state message.
		dispatch({ type: "state", state: { routerModels: { openrouter: { "m/old": { id: "m/old" } } } } })
		dispatch({
			type: "routerModels",
			values: { provider: "openrouter" },
			routerModels: { openrouter: { "m/new": { id: "m/new" } } },
		})
		expect(text("routerModels")).toBe('{"openrouter":{"m/new":{"id":"m/new"}}}')
	})

	it("sets marketplace data from a marketplaceData message", () => {
		renderProvider()
		dispatch({
			type: "marketplaceData",
			marketplaceItems: [{ name: "item-1" }],
			marketplaceInstalledMetadata: { project: { x: 2 }, global: { y: 3 } },
		})
		expect(text("marketplaceItems")).toBe('[{"name":"item-1"}]')
		expect(text("marketplaceInstalledMetadata")).toBe('{"project":{"x":2},"global":{"y":3}}')
	})

	it("replaces taskHistory on taskHistoryUpdated", () => {
		renderProvider()
		const history = [{ id: "t1", task: "one", ts: 10 }]
		dispatch({ type: "taskHistoryUpdated", taskHistory: history })
		expect(text("taskHistory")).toBe(JSON.stringify(history))
	})

	it("inserts a new task history item at the head and sorts newest-first", () => {
		renderProvider()
		dispatch({ type: "state", state: { taskHistory: [{ id: "old", task: "old", ts: 5 }] } })

		dispatch({ type: "taskHistoryItemUpdated", taskHistoryItem: { id: "new", task: "new", ts: 20 } })

		const parsed = JSON.parse(text("taskHistory")!)
		expect(parsed.map((h: any) => h.id)).toEqual(["new", "old"])
	})

	it("updates an existing task history item in place", () => {
		renderProvider()
		dispatch({ type: "state", state: { taskHistory: [{ id: "t1", task: "before", ts: 10 }] } })

		dispatch({ type: "taskHistoryItemUpdated", taskHistoryItem: { id: "t1", task: "after", ts: 10 } })

		const parsed = JSON.parse(text("taskHistory")!)
		expect(parsed[0].task).toBe("after")
	})

	it("ignores taskHistoryItemUpdated when no item is provided", () => {
		renderProvider()
		dispatch({ type: "state", state: { taskHistory: [{ id: "t1", task: "keep", ts: 10 }] } })
		dispatch({ type: "taskHistoryItemUpdated" })
		expect(text("taskHistory")).toBe(JSON.stringify([{ id: "t1", task: "keep", ts: 10 }]))
	})

	it("exposes setFollowupAutoApproveTimeoutMs setter", () => {
		renderProvider()
		dispatch({ type: "state", state: { followupAutoApproveTimeoutMs: 5000 } })
		expect(text("followupAutoApproveTimeoutMs")).toBe("5000")
	})
})
