// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.language-switch.spec.tsx

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

const commandAsk: ClineMessage[] = [
	{ type: "say", say: "task", ts: 1, text: "Initial task" },
	{ type: "ask", ask: "command", ts: 2, text: "echo hi", partial: false },
]

const postState = (state: Record<string, unknown>) =>
	act(async () => {
		window.postMessage(
			{
				type: "state",
				state: {
					version: "1.0.0",
					clineMessages: commandAsk,
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

describe("ChatView approval buttons on language change", () => {
	beforeEach(async () => {
		await i18next.changeLanguage("en")
	})

	it("relabels an open prompt's buttons in the new language", async () => {
		renderWithExtensionState(<ChatView {...defaultProps} />)

		await postState({ language: "en" })
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument()
			expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument()
		})

		// Same messages, so only the language changes; the approval-label effect does not rerun.
		await postState({ language: "es" })
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Comando" })).toBeInTheDocument()
			expect(screen.getByRole("button", { name: "Rechazar" })).toBeInTheDocument()
		})
		expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument()
	})
})
