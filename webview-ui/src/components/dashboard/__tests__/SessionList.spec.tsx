// npx vitest run src/components/dashboard/__tests__/SessionList.spec.tsx

import React from "react"
import { render, fireEvent } from "@/utils/test-utils"

import type { SessionSummary, SessionDetail as SessionDetailType } from "@roo-code/types"

import SessionList from "../SessionList"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		taskId: "task-001",
		title: "Test session",
		timestamp: Date.now(),
		model: "gpt-4",
		provider: "openai",
		mode: "code",
		models: ["gpt-4"],
		modes: ["code"],
		totalTokens: 1500,
		totalCost: 0.05,
		callCount: 1,
		...overrides,
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SessionList", () => {
const defaultProps = {
	expandedTaskId: undefined,
	sessionDetails: {} as Record<string, SessionDetailType | null>,
	sessionDetailErrors: {} as Record<string, string | null>,
	sessionDetailLoading: new Set<string>(),
	onToggleSession: vi.fn(),
}

	it("renders the sessions container", () => {
		const { container } = render(
			<SessionList sessions={[]} {...defaultProps} />,
		)
		const sessions = container.querySelector('[data-testid="dashboard-sessions"]')
		expect(sessions).toBeTruthy()
	})

	it("renders empty state when no sessions", () => {
		const { container } = render(
			<SessionList sessions={[]} {...defaultProps} />,
		)
		const empty = container.querySelector('[data-testid="dashboard-sessions-empty"]')
		expect(empty).toBeTruthy()
		expect(empty?.textContent).toContain("dashboard:sessions.noSessions")
	})

	it("renders session rows for each session", () => {
		const sessions = [
			makeSession({ taskId: "task-A", title: "Session A" }),
			makeSession({ taskId: "task-B", title: "Session B" }),
		]
		const { container } = render(
			<SessionList sessions={sessions} {...defaultProps} />,
		)
		expect(container.textContent).toContain("Session A")
		expect(container.textContent).toContain("Session B")
	})

	it("renders the title header", () => {
		const { container } = render(
			<SessionList sessions={[]} {...defaultProps} />,
		)
		expect(container.textContent).toContain("dashboard:sessions.title")
	})

	it("does not render model filter dropdown", () => {
		const sessions = [
			makeSession({ taskId: "task-A", model: "gpt-4" }),
			makeSession({ taskId: "task-B", model: "claude-3" }),
		]
		const { container } = render(
			<SessionList sessions={sessions} {...defaultProps} />,
		)
		const modelFilter = container.querySelector('[data-testid="dashboard-session-filter-model"]')
		expect(modelFilter).toBeFalsy()
	})

	it("does not render provider filter dropdown", () => {
		const sessions = [
			makeSession({ taskId: "task-A", provider: "openai" }),
			makeSession({ taskId: "task-B", provider: "anthropic" }),
		]
		const { container } = render(
			<SessionList sessions={sessions} {...defaultProps} />,
		)
		const providerFilter = container.querySelector('[data-testid="dashboard-session-filter-provider"]')
		expect(providerFilter).toBeFalsy()
	})

	it("calls onToggleSession when a session row is clicked", () => {
		const onToggleSession = vi.fn()
		const sessions = [makeSession({ taskId: "task-A", title: "Click me" })]
		const { container } = render(
			<SessionList sessions={sessions} {...defaultProps} onToggleSession={onToggleSession} />,
		)
		// Find the session row button
		const row = container.querySelector('[data-testid="dashboard-session-row"]')
		expect(row).toBeTruthy()
		fireEvent.click(row!)
		expect(onToggleSession).toHaveBeenCalledWith("task-A")
	})

	it("shows loading state when session detail is loading", () => {
		const sessions = [makeSession({ taskId: "task-A" })]
		const { container } = render(
			<SessionList
				sessions={sessions}
				{...defaultProps}
				expandedTaskId="task-A"
				sessionDetailLoading={new Set(["task-A"])}
			/>,
		)
		expect(container.textContent).toContain("dashboard:states.loading")
	})

	it("shows error state when session detail fetch failed", () => {
		const sessions = [makeSession({ taskId: "task-A" })]
		const { container } = render(
			<SessionList
				sessions={sessions}
				{...defaultProps}
				expandedTaskId="task-A"
				sessionDetailErrors={{ "task-A": "Network error" }}
			/>,
		)
		expect(container.textContent).toContain("Network error")
	})

	it("shows session detail when expanded and loaded", () => {
		const sessions = [makeSession({ taskId: "task-A" })]
		const detail: SessionDetailType = {
			taskId: "task-A",
			title: "Test session",
			timestamp: Date.now(),
			model: "gpt-4",
			provider: "openai",
			mode: "code",
			models: ["gpt-4"],
			modes: ["code"],
			totalTokens: 1500,
			totalCost: 0.05,
			callCount: 1,
			apiCalls: [],
		}
		const { container } = render(
			<SessionList
				sessions={sessions}
				{...defaultProps}
				expandedTaskId="task-A"
				sessionDetails={{ "task-A": detail }}
			/>,
		)
		// The detail's no-calls message should be visible
		const noCalls = container.querySelector('[data-testid="dashboard-session-detail-no-calls"]')
		expect(noCalls).toBeTruthy()
	})

	it("displays formatted tokens and cost in session row", () => {
		const sessions = [makeSession({ taskId: "task-A", totalTokens: 1_500_000, totalCost: 1.23 })]
		const { container } = render(
			<SessionList sessions={sessions} {...defaultProps} />,
		)
		expect(container.textContent).toContain("1.50M")
		expect(container.textContent).toContain("$1.23")
	})
})
