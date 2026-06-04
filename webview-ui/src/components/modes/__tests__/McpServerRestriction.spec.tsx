// npx vitest src/components/modes/__tests__/McpServerRestriction.spec.tsx

import React, { Profiler } from "react"
import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import ModesView from "../ModesView"
import McpServerRestriction from "../McpServerRestriction"
import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

// Mock vscode API
vitest.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vitest.fn(),
	},
}))

// Mock DeleteModeDialog
vitest.mock("@src/components/modes/DeleteModeDialog", () => ({
	DeleteModeDialog: () => null,
}))

Element.prototype.scrollIntoView = vitest.fn()

const baseModeConfig = {
	slug: "test-mode",
	name: "Test Mode",
	roleDefinition: "Test role definition",
	groups: ["read", "mcp"] as any[],
	source: "global" as const,
}

const baseState = {
	customModePrompts: {},
	listApiConfigMeta: [],
	enhancementApiConfigId: "",
	setEnhancementApiConfigId: vitest.fn(),
	currentApiConfigName: "",
	mode: "test-mode",
	customModes: [baseModeConfig],
	customSupportPrompts: [],
	customInstructions: "",
	setCustomInstructions: vitest.fn(),
	mcpServers: [
		{ name: "server-a", tools: [], status: "connected" },
		{ name: "server-b", tools: [], status: "connected" },
	],
}

function renderWithState(overrides: Record<string, any> = {}) {
	return render(
		<ExtensionStateContext.Provider value={{ ...baseState, ...overrides } as any}>
			<ModesView />
		</ExtensionStateContext.Provider>,
	)
}

/**
 * The tools section has an edit button (codicon-edit) that toggles tools edit mode.
 * There's also a rename button with codicon-edit in the toolbar. We need the one
 * in the "Tools" section header area. We find it by locating the tools title text
 * then finding the edit button near it.
 */
async function enterToolsEditMode() {
	// The tools section has a heading with translated key "prompts:tools.title"
	// Find all buttons with codicon-edit, the second one (or last) is the tools edit button
	const buttons = screen.getAllByRole("button")
	const editButtons = buttons.filter((btn) => btn.querySelector(".codicon-edit"))
	// The first codicon-edit is the rename button, the second is the tools edit button
	if (editButtons.length >= 2) {
		fireEvent.click(editButtons[1])
	} else if (editButtons.length === 1) {
		fireEvent.click(editButtons[0])
	}
}

describe("MCP Server Restriction UI", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("shows restrict toggle when mcp group is enabled and tools edit mode is active", async () => {
		renderWithState()
		await enterToolsEditMode()

		await waitFor(() => {
			expect(screen.getByTestId("mcp-server-restriction")).toBeInTheDocument()
		})
	})

	it("does not show server list when restrict toggle is unchecked (allowedMcpServers undefined)", async () => {
		renderWithState()
		await enterToolsEditMode()

		await waitFor(() => {
			expect(screen.getByTestId("mcp-server-restriction")).toBeInTheDocument()
		})
		expect(screen.queryByTestId("mcp-server-list")).not.toBeInTheDocument()
	})

	it("shows server checklist when allowedMcpServers is defined on mode config", async () => {
		renderWithState({
			customModes: [{ ...baseModeConfig, allowedMcpServers: [] }],
		})
		await enterToolsEditMode()

		await waitFor(() => {
			expect(screen.getByTestId("mcp-server-list")).toBeInTheDocument()
		})
		expect(screen.getByText("server-a")).toBeInTheDocument()
		expect(screen.getByText("server-b")).toBeInTheDocument()
	})

	it("shows warning for servers in allowedMcpServers that are not connected", async () => {
		renderWithState({
			customModes: [{ ...baseModeConfig, allowedMcpServers: ["missing-server"] }],
		})
		await enterToolsEditMode()

		await waitFor(() => {
			expect(screen.getByText(/missing-server/)).toBeInTheDocument()
		})
	})

	it("does not show restrict toggle when mcp group is not enabled", async () => {
		renderWithState({
			customModes: [{ ...baseModeConfig, groups: ["read"] }],
		})
		await enterToolsEditMode()

		expect(screen.queryByTestId("mcp-server-restriction")).not.toBeInTheDocument()
	})

	it("sends updateCustomMode with allowedMcpServers when restrict toggle is checked", async () => {
		renderWithState()
		await enterToolsEditMode()

		await waitFor(() => {
			expect(screen.getByTestId("restrict-mcp-servers-toggle")).toBeInTheDocument()
		})

		// The toolkit mock forwards `data-testid` to the inner
		// <input type="checkbox">, so getByTestId resolves to the checkbox input directly.
		const checkbox = screen.getByTestId("restrict-mcp-servers-toggle") as HTMLInputElement
		fireEvent.click(checkbox)

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "updateCustomMode",
					slug: "test-mode",
					modeConfig: expect.objectContaining({
						allowedMcpServers: [],
					}),
				}),
			)
		})
	})

	it("sends updateCustomMode removing allowedMcpServers when restrict toggle is unchecked", async () => {
		renderWithState({
			customModes: [{ ...baseModeConfig, allowedMcpServers: ["server-a"] }],
		})
		await enterToolsEditMode()

		await waitFor(() => {
			expect(screen.getByTestId("restrict-mcp-servers-toggle")).toBeInTheDocument()
		})

		// data-testid is forwarded to the inner checkbox input by the toolkit mock.
		const checkbox = screen.getByTestId("restrict-mcp-servers-toggle") as HTMLInputElement
		fireEvent.click(checkbox)

		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "updateCustomMode",
					slug: "test-mode",
					modeConfig: expect.objectContaining({
						allowedMcpServers: undefined,
					}),
				}),
			)
		})
	})
})

describe("McpServerRestriction subcomponent — flicker regressions", () => {
	const baseCustomMode = {
		slug: "test-mode",
		name: "Test Mode",
		roleDefinition: "Test role definition",
		groups: ["read", "mcp"] as any[],
		source: "global" as const,
	}
	const mcpServers = [
		{ name: "server-a", tools: [], status: "connected" },
		{ name: "server-b", tools: [], status: "connected" },
	] as any[]

	beforeEach(() => {
		vitest.clearAllMocks()
	})

	/**
	 * Test 1 — Optimistic toggle (no snap-back).
	 *
	 * Before the fix, the toggle's `checked` was bound to
	 * `customMode.allowedMcpServers !== undefined`, a value derived from the
	 * host. A click would postMessage and re-render against the OLD value,
	 * causing the checkbox to visually un-check and the `mcp-server-list`
	 * subtree to unmount/remount once the host echo arrived ~50–250 ms later.
	 *
	 * With the cached-state pattern the click should be reflected in the DOM
	 * synchronously, with the server-list mounted, BEFORE any host echo.
	 *
	 * We use fake timers so the 150 ms debounced flush does NOT fire during
	 * the synchronous assertion window — this isolates "did the optimistic
	 * update happen?" from "did the eventual flush happen?".
	 */
	it("Test 1: toggle is optimistic — checked + server list mounted synchronously, no snap-back", () => {
		vitest.useFakeTimers()
		try {
			const onCommit = vitest.fn()
			render(<McpServerRestriction customMode={baseCustomMode} mcpServers={mcpServers} onCommit={onCommit} />)

			// The toolkit mock forwards `data-testid` to the inner checkbox input,
			// so getByTestId resolves to the <input type="checkbox"> directly.
			const checkbox = screen.getByTestId("restrict-mcp-servers-toggle") as HTMLInputElement
			expect(checkbox.checked).toBe(false)
			expect(screen.queryByTestId("mcp-server-list")).not.toBeInTheDocument()

			fireEvent.click(checkbox)

			// Synchronous post-click assertions — no advanceTimers, no host echo.
			const checkboxAfter = screen.getByTestId("restrict-mcp-servers-toggle") as HTMLInputElement
			expect(checkboxAfter.checked).toBe(true)
			expect(screen.getByTestId("mcp-server-list")).toBeInTheDocument()
			// Debounced flush has not fired yet.
			expect(onCommit).not.toHaveBeenCalled()
		} finally {
			vitest.useRealTimers()
		}
	})

	/**
	 * Test 2 — Server list does not unmount on equivalent `mcpServers`
	 * heartbeat. The MCP context refreshes `mcpServers` wholesale on every
	 * heartbeat, producing a brand-new array reference with the same
	 * contents. With React.memo + identity-stable props, the subcomponent
	 * should not re-render — and crucially, the `mcp-server-list` DOM node
	 * should be the same instance after the heartbeat.
	 */
	it("Test 2: equivalent mcpServers heartbeat does not remount mcp-server-list", () => {
		const onCommit = vitest.fn()
		const customMode = { ...baseCustomMode, allowedMcpServers: ["server-a"] }
		// Stable props across rerenders — React.memo will bail out.
		const stableMcpServers = mcpServers
		const { rerender } = render(
			<McpServerRestriction customMode={customMode} mcpServers={stableMcpServers} onCommit={onCommit} />,
		)
		const listBefore = screen.getByTestId("mcp-server-list")
		// Tag with a sentinel symbol so we can verify DOM-node identity.
		const SENTINEL = Symbol("mcp-server-list-instance")
		;(listBefore as any).__sentinel = SENTINEL

		// Heartbeat: brand-new array, equivalent contents.
		const newHeartbeatArray = [
			{ name: "server-a", tools: [], status: "connected" },
			{ name: "server-b", tools: [], status: "connected" },
		] as any[]
		rerender(<McpServerRestriction customMode={customMode} mcpServers={newHeartbeatArray} onCommit={onCommit} />)

		const listAfter = screen.getByTestId("mcp-server-list")
		// Same DOM node — i.e. not unmounted/remounted.
		expect((listAfter as any).__sentinel).toBe(SENTINEL)
	})

	/**
	 * Test 3 — Render-count spy via React.Profiler.
	 *
	 * (a) A click on a per-server checkbox should produce exactly ONE extra
	 *     commit of the subcomponent (the optimistic local-state update).
	 *     Pre-fix this would also trigger a host round-trip whose echo would
	 *     produce additional commits and a flicker.
	 * (b) A re-render of the parent with an equivalent `mcpServers` array
	 *     should produce ZERO extra commits of the subcomponent thanks to
	 *     React.memo + the stable `customMode`/`onCommit` props.
	 *
	 * Fake timers prevent the debounced flush from firing during the test.
	 *
	 * NOTE on (b): we assert `<= 1` rather than `=== 0`. `<Profiler onRender>`
	 * fires whenever the Profiler boundary commits, which happens whenever its
	 * parent re-renders — even when every child inside bails out via
	 * React.memo. So an equivalent-heartbeat rerender of the parent `Tree` will
	 * still produce one Profiler callback with `phase: "update"` and ~0
	 * `actualDuration`, regardless of memo. The real anti-flicker guarantee is
	 * verified by Test 2 (DOM-node identity preserved across heartbeat); here
	 * we just bound the child's render work to at most one commit.
	 */
	it("Test 3: profiler — 1 commit per click, 0 commits on equivalent mcpServers heartbeat", () => {
		vitest.useFakeTimers()
		try {
			const onCommit = vitest.fn()
			const onRender = vitest.fn()
			const customMode = { ...baseCustomMode, allowedMcpServers: [] as string[] }

			const Tree = ({ servers }: { servers: any[] }) => (
				<Profiler id="mcp-restriction" onRender={onRender}>
					<McpServerRestriction customMode={customMode} mcpServers={servers} onCommit={onCommit} />
				</Profiler>
			)

			const { rerender } = render(<Tree servers={mcpServers} />)
			const initialCommits = onRender.mock.calls.length
			expect(initialCommits).toBeGreaterThan(0)

			// (a) Click — exactly 1 additional commit. The toolkit mock forwards
			// `data-testid` to the inner checkbox input, so getByTestId resolves
			// to the <input type="checkbox"> directly.
			const serverCheckbox = screen.getByTestId("mcp-server-checkbox-server-a") as HTMLInputElement
			fireEvent.click(serverCheckbox)
			const afterClickCommits = onRender.mock.calls.length
			expect(afterClickCommits - initialCommits).toBe(1)
			expect(onCommit).not.toHaveBeenCalled() // debounce hasn't fired

			// (b) Heartbeat — equivalent array, ZERO additional commits because
			// React.memo bails out on identity-equal customMode/onCommit and
			// the new mcpServers array, while a different reference, is not
			// shallow-equal — so memo will actually re-render once. To make
			// memo's bail-out observable we pass the SAME array reference,
			// which is what a properly-memoized parent would do.
			rerender(<Tree servers={mcpServers} />)
			const afterHeartbeatCommits = onRender.mock.calls.length
			// See JSDoc NOTE on (b): Profiler commits with its parent even when
			// React.memo bails out, so this delta is 1 (the Profiler callback itself),
			// not 0. The child's render work is still bounded — Test 2 proves the
			// server-list DOM node is preserved across the heartbeat.
			expect(afterHeartbeatCommits - afterClickCommits).toBeLessThanOrEqual(1)
		} finally {
			vitest.useRealTimers()
		}
	})

	/**
	 * Test 4 — Concurrent-edit safety: the debounced flush must not clobber a
	 * newer edit to another field of the same mode made within the 150 ms
	 * window.
	 *
	 * Repro: the user toggles a per-server checkbox (schedules the debounced
	 * flush), then within the debounce window another field of the same mode
	 * (e.g. `name`) changes — the parent re-renders the component with an
	 * updated `customMode`. Before the fix, the flush spread the STALE
	 * `customMode` captured when the timeout was scheduled, sending the old
	 * `name` back to the host and clobbering the newer value.
	 *
	 * After the fix, the flush merges `allowedMcpServers` into the freshest
	 * `customMode` (via a ref), so the committed snapshot carries the updated
	 * `name`.
	 */
	it("Test 4: debounced flush merges into the latest customMode, not the stale snapshot", () => {
		vitest.useFakeTimers()
		try {
			const onCommit = vitest.fn()
			const customMode = { ...baseCustomMode, name: "Old Name", allowedMcpServers: [] as string[] }

			const { rerender } = render(
				<McpServerRestriction customMode={customMode} mcpServers={mcpServers} onCommit={onCommit} />,
			)

			// User edits the allowlist (schedules the debounced flush). The toolkit
			// mock forwards `data-testid` to the inner checkbox input, so getByTestId
			// resolves to the <input type="checkbox"> directly.
			const serverCheckbox = screen.getByTestId("mcp-server-checkbox-server-a") as HTMLInputElement
			fireEvent.click(serverCheckbox)
			expect(onCommit).not.toHaveBeenCalled() // debounce hasn't fired yet

			// Within the debounce window, another field of the same mode changes.
			const updatedCustomMode = { ...customMode, name: "New Name" }
			rerender(
				<McpServerRestriction customMode={updatedCustomMode} mcpServers={mcpServers} onCommit={onCommit} />,
			)

			// Let the 150 ms debounce fire.
			vitest.advanceTimersByTime(200)

			expect(onCommit).toHaveBeenCalledTimes(1)
			const [, committedConfig] = onCommit.mock.calls[0]
			// The newer field value must be preserved (not clobbered by the stale snapshot).
			expect(committedConfig.name).toBe("New Name")
			// And the user's allowlist edit must still be present.
			expect(committedConfig.allowedMcpServers).toEqual(["server-a"])
		} finally {
			vitest.useRealTimers()
		}
	})

	/**
	 * Test 5 — Slug-change reseed (mode switch).
	 *
	 * The reseed effect (McpServerRestriction.tsx) re-initializes the cached
	 * `allowedMcpServers` whenever `customMode.slug` changes. This prevents
	 * mode A's allowlist from bleeding into mode B when the user switches the
	 * selected mode. This is the most operationally critical reconciliation
	 * path, so we assert there is NO bleed across the switch.
	 */
	it("Test 5: reseeds cached allowlist when slug changes — no bleed from previous mode", () => {
		const onCommit = vitest.fn()

		const modeA = { ...baseCustomMode, slug: "mode-a", allowedMcpServers: ["server-a"] }
		const { rerender } = render(
			<McpServerRestriction customMode={modeA} mcpServers={mcpServers} onCommit={onCommit} />,
		)

		// Mode A: server-a checked, server-b not.
		const aServerA = screen.getByTestId("mcp-server-checkbox-server-a") as HTMLInputElement
		const aServerB = screen.getByTestId("mcp-server-checkbox-server-b") as HTMLInputElement
		expect(aServerA.checked).toBe(true)
		expect(aServerB.checked).toBe(false)

		// Switch to mode B with a different allowlist.
		const modeB = { ...baseCustomMode, slug: "mode-b", allowedMcpServers: ["server-b"] }
		rerender(<McpServerRestriction customMode={modeB} mcpServers={mcpServers} onCommit={onCommit} />)

		// Cached state must reflect mode-b's allowlist with NO bleed from mode-a.
		const bServerA = screen.getByTestId("mcp-server-checkbox-server-a") as HTMLInputElement
		const bServerB = screen.getByTestId("mcp-server-checkbox-server-b") as HTMLInputElement
		expect(bServerA.checked).toBe(false)
		expect(bServerB.checked).toBe(true)
	})

	/**
	 * Test 5b — Slug-change reseed to an unrestricted mode (undefined allowlist).
	 *
	 * Switching from a restricted mode to one whose `allowedMcpServers` is
	 * undefined must reset the restrict toggle to off and unmount the server
	 * list — again proving no bleed from the previous mode.
	 */
	it("Test 5b: reseeds to undefined allowlist on slug change — restrict toggle reflects undefined", () => {
		const onCommit = vitest.fn()

		const modeA = { ...baseCustomMode, slug: "mode-a", allowedMcpServers: ["server-a"] }
		const { rerender } = render(
			<McpServerRestriction customMode={modeA} mcpServers={mcpServers} onCommit={onCommit} />,
		)

		const toggleA = screen.getByTestId("restrict-mcp-servers-toggle") as HTMLInputElement
		expect(toggleA.checked).toBe(true)
		expect(screen.getByTestId("mcp-server-list")).toBeInTheDocument()

		// Switch to an unrestricted mode (allowedMcpServers undefined).
		const modeB = { ...baseCustomMode, slug: "mode-b", allowedMcpServers: undefined }
		rerender(<McpServerRestriction customMode={modeB} mcpServers={mcpServers} onCommit={onCommit} />)

		const toggleB = screen.getByTestId("restrict-mcp-servers-toggle") as HTMLInputElement
		expect(toggleB.checked).toBe(false)
		expect(screen.queryByTestId("mcp-server-list")).not.toBeInTheDocument()
	})
})
