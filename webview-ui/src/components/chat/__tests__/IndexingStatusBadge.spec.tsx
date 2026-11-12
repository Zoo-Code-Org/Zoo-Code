import React from "react"
import type { IndexingStatus, IndexingStatusUpdateMessage } from "@roo-code/types"
import { render, screen, fireEvent, act } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"
import { CodeIndexPopover } from "../CodeIndexPopover"
import { IndexingStatusBadge } from "../IndexingStatusBadge"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ cwd: "/workspace" }),
	ExtensionStateContextProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))

vi.mock("../CodeIndexPopover", () => ({
	CodeIndexPopover: vi.fn(({ children }: React.PropsWithChildren<{ indexingStatus: IndexingStatus }>) => (
		<>{children}</>
	)),
}))

vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@src/components/ui")>()
	return {
		...actual,
		PopoverTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
		StandardTooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
	}
})

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, parameters?: Record<string, unknown>) => {
			const translations: Record<string, string> = {
				"chat:indexingStatus.ready": "Index ready",
				"chat:indexingStatus.indexing": `Indexing ${parameters?.percentage}%`,
				"chat:indexingStatus.indexed": "Indexed",
				"chat:indexingStatus.error": "Index error",
				"chat:indexingStatus.stopping": "Stopping indexing...",
				"chat:indexingStatus.status": "Index status",
				"settings:codeIndex.indexingFilesRetrying": `Retrying ${parameters?.count}: ${parameters?.path}: ${parameters?.reason}`,
				"settings:codeIndex.indexingFilesFailed": `Failed ${parameters?.count}: ${parameters?.path}: ${parameters?.reason}`,
				"settings:codeIndex.failedFileDetails": "Failed file details",
			}
			return translations[key] ?? key
		},
	}),
}))

const baseStatus: IndexingStatus = {
	systemStatus: "Standby",
	processedItems: 0,
	totalItems: 0,
	currentItemUnit: "files",
}

const failureStatus = (state: "retrying" | "exhausted"): IndexingStatus => {
	const failure = { path: "src/failed.ts", activity: "embed", reason: "Provider unavailable", state } as const
	return {
		...baseStatus,
		systemStatus: state === "retrying" ? "Indexing" : "Standby",
		processedItems: 25,
		totalItems: 100,
		workspacePath: "/workspace",
		workspaceEnabled: true,
		autoEnableDefault: false,
		message: "Backend status message",
		failedFiles: [failure],
		failedFileSummary: { ...failure, count: 1 },
	}
}

const publishStatus = (values: IndexingStatus) => {
	const data: IndexingStatusUpdateMessage = { type: "indexingStatusUpdate", values }
	act(() => window.dispatchEvent(new MessageEvent("message", { data })))
}

const statusDot = () => screen.getByRole("button").querySelector("span")

const lastPopoverStatus = () => vi.mocked(CodeIndexPopover).mock.calls.at(-1)?.[0].indexingStatus

describe("IndexingStatusBadge", () => {
	beforeEach(() => vi.clearAllMocks())

	it("renders an accessible, clickable standby control and requests initial status", () => {
		render(<IndexingStatusBadge />)
		fireEvent.click(screen.getByRole("button", { name: "Index ready" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestIndexingStatus" })
		expect(statusDot()).toHaveClass("bg-vscode-descriptionForeground/60")
	})

	it.each([
		["Standby", "Index ready", "bg-vscode-descriptionForeground/60"],
		["Indexed", "Indexed", "bg-green-500"],
		["Error", "Index error", "bg-red-500"],
		["Stopping", "Stopping indexing...", "bg-amber-500"],
		["Unknown", "Index status", "bg-vscode-descriptionForeground/60"],
	])("preserves %s status without failures", (systemStatus, label, color) => {
		render(<IndexingStatusBadge />)
		publishStatus({ ...baseStatus, systemStatus })
		expect(screen.getByRole("button")).toHaveAttribute("aria-label", label)
		expect(statusDot()).toHaveClass(color)
	})

	it.each([
		[0, 100, 0],
		[25, 100, 25],
		[1, 3, 33],
		[100, 100, 100],
		[0, 0, 0],
	])("keeps progress for %s/%s items", (processedItems, totalItems, percentage) => {
		render(<IndexingStatusBadge />)
		publishStatus({ ...baseStatus, systemStatus: "Indexing", processedItems, totalItems })
		expect(screen.getByRole("button")).toHaveAttribute("aria-label", `Indexing ${percentage}%`)
		expect(statusDot()).toHaveClass("bg-yellow-500", "animate-pulse")
	})

	it.each(["retrying", "exhausted"] as const)(
		"indicates %s failures and passes the whole status to the popover",
		(state) => {
			render(<IndexingStatusBadge />)
			const status = failureStatus(state)
			publishStatus(status)
			const prefix = state === "retrying" ? "Indexing 25% - Retrying" : "Index ready - Failed"
			expect(screen.getByRole("button")).toHaveAttribute(
				"aria-label",
				`${prefix} 1: src/failed.ts: Provider unavailable`,
			)
			expect(statusDot()).toHaveClass(state === "retrying" ? "bg-yellow-500" : "bg-amber-500")
			expect(lastPopoverStatus()).toEqual(status)
		},
	)

	it.each(["Error", "Stopping"])("does not replace %s with a failure summary", (systemStatus) => {
		render(<IndexingStatusBadge />)
		const status = { ...failureStatus("retrying"), systemStatus, message: "Fatal or stopping message" }
		publishStatus(status)
		expect(screen.getByRole("button")).toHaveAttribute(
			"aria-label",
			systemStatus === "Error" ? "Index error" : "Stopping indexing...",
		)
		expect(statusDot()).toHaveClass(systemStatus === "Error" ? "bg-red-500" : "bg-amber-500")
		expect(lastPopoverStatus()).toEqual(status)
	})

	it("indicates list-only failures without inventing a retry state", () => {
		render(<IndexingStatusBadge />)
		publishStatus({ ...failureStatus("exhausted"), failedFileSummary: undefined })
		expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Index ready - Failed file details (1)")
		expect(statusDot()).toHaveClass("bg-amber-500")
	})

	it.each([{ failedFiles: undefined }, { failedFiles: [] }])(
		"keeps zero-failure compatibility: %s",
		({ failedFiles }) => {
			render(<IndexingStatusBadge />)
			publishStatus({
				...failureStatus("exhausted"),
				systemStatus: "Indexed",
				failedFiles,
				failedFileSummary: { ...failureStatus("exhausted").failedFileSummary!, count: 0 },
			})
			expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Indexed")
			expect(statusDot()).toHaveClass("bg-green-500")
		},
	)

	it.each(["empty", "omitted"])("forwards waits and clears them when %s in a new snapshot", (snapshot) => {
		render(<IndexingStatusBadge />)
		const waiting = {
			...baseStatus,
			systemStatus: "Indexing",
			providerWaits: [{ service: "openai", resumeAt: 123_000, waitingFiles: ["waiting.ts"] }],
		}
		publishStatus(waiting)
		expect(lastPopoverStatus()).toEqual(waiting)
		expect(statusDot()).toHaveClass("bg-yellow-500")
		const recovered = {
			...baseStatus,
			systemStatus: "Indexed",
			providerWaits: snapshot === "empty" ? [] : undefined,
		}
		publishStatus(recovered)
		expect(lastPopoverStatus()).toEqual(recovered)
		expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Indexed")
		expect(statusDot()).toHaveClass("bg-green-500")
	})

	it("preserves Indexed for a search-only pause without file work", () => {
		render(<IndexingStatusBadge />)
		const status = {
			...baseStatus,
			systemStatus: "Indexed",
			providerWaits: [{ service: "openai", waitingFiles: [] }],
		}
		publishStatus(status)
		expect(lastPopoverStatus()).toEqual(status)
		expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Indexed")
		expect(statusDot()).toHaveClass("bg-green-500")
	})

	it("replaces failure fields when recovery arrives", () => {
		render(<IndexingStatusBadge />)
		publishStatus(failureStatus("retrying"))
		const recovered = { ...baseStatus, systemStatus: "Indexed", failedFiles: [] }
		publishStatus(recovered)
		expect(lastPopoverStatus()).toEqual(recovered)
		expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Indexed")
	})

	it("accepts this workspace and unscoped updates but ignores other workspaces", () => {
		render(<IndexingStatusBadge />)
		const status = failureStatus("exhausted")
		publishStatus(status)
		publishStatus({ ...baseStatus, systemStatus: "Error", workspacePath: "/other" })
		expect(lastPopoverStatus()).toEqual(status)
		publishStatus({ ...baseStatus, systemStatus: "Indexed" })
		expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Indexed")
	})

	it("ignores unrelated messages", () => {
		render(<IndexingStatusBadge />)
		act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "workspaceUpdated" } })))
		expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Index ready")
	})

	it("cleans up its event listener on unmount", () => {
		const addListener = vi.spyOn(window, "addEventListener")
		const { unmount } = render(<IndexingStatusBadge />)
		const registered = addListener.mock.calls.find(([type]) => type === "message")?.[1]
		expect(registered).toBeDefined()
		const removeListener = vi.spyOn(window, "removeEventListener")
		unmount()
		expect(removeListener).toHaveBeenCalledWith("message", registered)
		addListener.mockRestore()
		removeListener.mockRestore()
	})
})
