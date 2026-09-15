// npx vitest run src/components/dashboard/__tests__/SessionDetail.spec.tsx

import React from "react"
import { render } from "@/utils/test-utils"

import { providerIdentifiers, type SessionDetail as SessionDetailType, type APICallRecord } from "@roo-code/types"

import SessionDetail from "../SessionDetail"

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

function makeApiCall(overrides: Partial<APICallRecord> = {}): APICallRecord {
	return {
		index: 1,
		mode: "code",
		timestamp: Date.now(),
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUsd: 0.05,
		status: "completed",
		model: "gpt-4",
		...overrides,
	}
}

function makeDetail(overrides: Partial<SessionDetailType> = {}): SessionDetailType {
	return {
		taskId: "task-001",
		title: "Test session",
		timestamp: Date.now(),
		model: "gpt-4",
		provider: providerIdentifiers.openai,
		mode: "code",
		models: ["gpt-4"],
		modes: ["code"],
		totalTokens: 150,
		totalCost: 0.05,
		callCount: 1,
		apiCalls: [makeApiCall()],
		...overrides,
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SessionDetail", () => {
	it("renders the session detail container", () => {
		const { container } = render(<SessionDetail detail={makeDetail()} />)
		const detail = container.querySelector('[data-testid="dashboard-session-detail"]')
		expect(detail).toBeTruthy()
	})

	it("renders the summary header label", () => {
		const { container } = render(<SessionDetail detail={makeDetail()} />)
		expect(container.textContent).toContain("dashboard:sessionDetail.summary")
	})

	it("renders formatted cost in summary header", () => {
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					totalCost: 0.15,
				})}
			/>,
		)
		expect(container.textContent).toContain("$0.15")
	})

	it("renders input/output token totals from apiCalls", () => {
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					apiCalls: [
						makeApiCall({ index: 1, inputTokens: 1000, outputTokens: 500 }),
						makeApiCall({ index: 2, inputTokens: 500, outputTokens: 1000 }),
					],
				})}
			/>,
		)
		// 1000 + 500 = 1500 -> "1.5K"
		expect(container.textContent).toContain("1.5K")
	})

	it("renders the API call table when apiCalls exist", () => {
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					apiCalls: [
						makeApiCall({ index: 1, mode: "code", inputTokens: 100, outputTokens: 50 }),
						makeApiCall({ index: 2, mode: "architect", inputTokens: 200, outputTokens: 100 }),
					],
				})}
			/>,
		)
		const callsTable = container.querySelector('[data-testid="dashboard-session-detail-calls"]')
		expect(callsTable).toBeTruthy()
		expect(container.textContent).toContain("code")
		expect(container.textContent).toContain("architect")
	})

	it("renders no-calls message when apiCalls is empty", () => {
		const { container } = render(<SessionDetail detail={makeDetail({ apiCalls: [] })} />)
		const noCalls = container.querySelector('[data-testid="dashboard-session-detail-no-calls"]')
		expect(noCalls).toBeTruthy()
		expect(noCalls?.textContent).toContain("dashboard:sessionDetail.noApiCalls")
	})

	it("renders status icons for completed, failed, and cancelled calls", () => {
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					apiCalls: [
						makeApiCall({ index: 1, status: "completed" }),
						makeApiCall({ index: 2, status: "failed" }),
						makeApiCall({ index: 3, status: "cancelled" }),
					],
				})}
			/>,
		)
		// Check that status icons are rendered (role="img")
		const statusIcons = container.querySelectorAll('[role="img"]')
		expect(statusIcons.length).toBe(3)
		expect(statusIcons[0].textContent).toContain("✅")
		expect(statusIcons[1].textContent).toContain("❌")
		expect(statusIcons[2].textContent).toContain("🔄")
	})

	it("renders formatted cost per API call", () => {
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					apiCalls: [makeApiCall({ index: 1, costUsd: 1.23 })],
				})}
			/>,
		)
		expect(container.textContent).toContain("$1.23")
	})

	it("renders model name per API call", () => {
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					apiCalls: [makeApiCall({ index: 1, model: "claude-3-opus" })],
				})}
			/>,
		)
		expect(container.textContent).toContain("claude-3-opus")
	})

	it("renders dash for empty mode", () => {
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					apiCalls: [makeApiCall({ index: 1, mode: "" })],
				})}
			/>,
		)
		expect(container.textContent).toContain("—")
	})

	it("renders multiple models in summary header", () => {
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					models: ["gpt-4", "claude-3"],
				})}
			/>,
		)
		expect(container.textContent).toContain("gpt-4")
		expect(container.textContent).toContain("claude-3")
	})

	it("falls back to --:-- when a timestamp cannot be formatted", () => {
		const badTimestamp = {
			toString: () => {
				throw new Error("bad date")
			},
		} as unknown as number
		const { container } = render(
			<SessionDetail
				detail={makeDetail({
					apiCalls: [makeApiCall({ index: 1, timestamp: badTimestamp })],
				})}
			/>,
		)
		expect(container.textContent).toContain("--:--")
	})
})
