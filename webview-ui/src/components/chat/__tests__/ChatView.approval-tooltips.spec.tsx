// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.approval-tooltips.spec.tsx

import React from "react"
import { renderWithExtensionState, screen, waitFor, act } from "@/utils/test-utils"

import i18next from "@src/i18n/setup"

import ChatView, { ChatViewProps } from "../ChatView"

interface ClineMessage {
	type: "say" | "ask"
	say?: string
	ask?: string
	ts: number
	text?: string
	partial?: boolean
}

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => [vi.fn()]),
}))

vi.mock("../ChatRow", () => ({
	default: () => null,
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

vi.mock("react-virtuoso", () => ({
	Virtuoso: () => null,
}))

vi.mock("../../common/VersionIndicator", () => ({
	default: vi.fn(() => null),
}))

vi.mock("@src/components/welcome/RooTips", () => ({
	default: () => null,
}))

vi.mock("@src/components/welcome/RooHero", () => ({
	default: () => null,
}))

vi.mock("../../common/TelemetryBanner", () => ({
	default: () => null,
}))

// Expose tooltip content on a wrapper so the key-to-tooltip mapping is observable without hover.
vi.mock("@src/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@src/components/ui")>()),
	StandardTooltip: ({ children, content }: { children: React.ReactNode; content?: React.ReactNode }) => (
		<span data-tooltip={typeof content === "string" ? content : undefined}>{children}</span>
	),
}))

const postState = (state: Record<string, unknown>) =>
	act(async () => {
		window.postMessage(
			{
				type: "state",
				state: {
					version: "1.0.0",
					taskHistory: [],
					shouldShowAnnouncement: false,
					allowedCommands: [],
					alwaysAllowExecute: false,
					cloudIsAuthenticated: false,
					telemetrySetting: "enabled",
					...state,
				},
			},
			"*",
		)
	})

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const tooltipOf = (name: string) =>
	screen.getByRole("button", { name }).closest("[data-tooltip]")?.getAttribute("data-tooltip")

const askMessages = (ask: string, text?: string): ClineMessage[] => [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{ type: "ask", ask, ts: 2, text, partial: false },
]

describe("ChatView approval button tooltips", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it.each([
		{
			ask: "api_req_failed",
			primary: ["Retry", "Try the operation again"],
			secondary: ["Start New Task", "Begin a new task"],
		},
		{
			ask: "mistake_limit_reached",
			primary: ["Proceed Anyways", "Continue while command executes"],
			secondary: ["Start New Task", "Begin a new task"],
		},
		{
			ask: "tool",
			text: JSON.stringify({ tool: "editedExistingFile", path: "a.ts" }),
			primary: ["Save", "Save the message changes"],
			secondary: ["Deny", "Prevent this action from occurring"],
		},
		{
			ask: "tool",
			text: JSON.stringify({ tool: "editedExistingFile", batchDiffs: [] }),
			primary: ["Save All", "Save All"],
			secondary: ["Deny All", "Deny All"],
		},
		{
			ask: "tool",
			text: JSON.stringify({ tool: "readFile", path: "a.ts" }),
			primary: ["Approve", "Allow this action to happen"],
			secondary: ["Deny", "Prevent this action from occurring"],
		},
		{
			ask: "command",
			text: "echo hi",
			primary: ["Run", "Execute this command"],
			secondary: ["Deny", "Prevent this action from occurring"],
		},
		{
			ask: "command_output",
			primary: ["Continue While Running", "Keep going despite warnings"],
			secondary: ["Kill Command", "Kill the current command"],
		},
		{
			ask: "resume_task",
			primary: ["Continue", "Resume the current task"],
			secondary: ["New task", "Start a new task"],
		},
		{
			ask: "completion_result",
			primary: ["Start New Task", "Begin a new task"],
		},
	])("maps the $ask $primary.0 prompt to its tooltips", async ({ ask, text, primary, secondary }) => {
		renderWithExtensionState(<ChatView {...defaultProps} />)

		await postState({ clineMessages: askMessages(ask, text) })

		await waitFor(() => expect(tooltipOf(primary[0])).toBe(primary[1]))
		if (secondary) {
			expect(tooltipOf(secondary[0])).toBe(secondary[1])
		}
	})
})
