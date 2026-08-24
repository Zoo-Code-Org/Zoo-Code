import React from "react"
import { render, screen } from "@/utils/test-utils"
import { ChatRowContent } from "../ChatRow"
import type { ClineMessage, ClineSayTool } from "@roo-code/types"

/** The thinkingEffort say-tool payload shape emitted by SetThinkingEffortTool. */
type ThinkingEffortSayTool = Pick<ClineSayTool, "tool" | "effort" | "reason" | "refusal" | "source"> & {
	tool: "thinkingEffort"
}

/** A non-thinkingEffort say-tool payload (arbitrary tool name) for negative tests. */
type OtherSayTool = Pick<ClineSayTool, "effort" | "reason" | "refusal"> & {
	tool: string
}

// Mock vscode API
const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => mockPostMessage(msg),
	},
}))

// Mock i18n (value-substituting Trans for the one-line display)
const tMap: Record<string, string> = {
	"chat:thinkingEffort.applied": "🧠 Thinking effort: {{effort}} (Zoo) — {{reason}}",
	"chat:thinkingEffort.escalationCapRefused":
		"🧠 Thinking effort unchanged: escalation limit of 3 upward changes per task reached",
	"chat:thinkingEffort.oscillationRefused": "🧠 Thinking effort unchanged: oscillation between levels detected",
}
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => tMap[key] ?? key,
		i18n: { exists: () => true },
	}),
	Trans: ({ i18nKey, values }: { i18nKey?: string; values?: Record<string, unknown> }) => {
		const raw = (i18nKey && (tMap[i18nKey] ?? i18nKey)) || ""
		return <>{String(raw).replace(/{{(\w+)}}/g, (_, k: string) => String(values?.[k] ?? ""))}</>
	},
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// Mock extension state context
let mockClineMessages: ClineMessage[] = []
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: null,
		mode: "code",
		apiConfiguration: {},
		clineMessages: mockClineMessages,
		currentTaskItem: undefined,
	}),
}))

// Mock useSelectedModel hook
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

function renderChatRow(message: ClineMessage) {
	mockClineMessages = [message]
	return render(
		<ChatRowContent
			message={message}
			isExpanded={false}
			isLast={false}
			isStreaming={false}
			onToggleExpand={() => {}}
			onSuggestionClick={() => {}}
			onBatchFileResponse={() => {}}
			onFollowUpUnmount={() => {}}
			isFollowUpAnswered={false}
		/>,
	)
}

function sayToolMessage(text: ThinkingEffortSayTool | OtherSayTool): ClineMessage {
	return {
		ts: Date.now(),
		type: "say" as const,
		say: "tool" as const,
		text: JSON.stringify(text),
	}
}

describe("ChatRow - thinkingEffort display (DTE series 3/5)", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
	})

	it("renders the one-line applied display with effort and reason", () => {
		renderChatRow(sayToolMessage({ tool: "thinkingEffort", effort: "high", reason: "deep analysis ahead" }))

		expect(screen.getByText("🧠 Thinking effort: high (Zoo) — deep analysis ahead")).toBeInTheDocument()
	})

	it("renders the oscillation refusal line", () => {
		renderChatRow(sayToolMessage({ tool: "thinkingEffort", refusal: "oscillation" }))

		expect(
			screen.getByText("🧠 Thinking effort unchanged: oscillation between levels detected"),
		).toBeInTheDocument()
	})

	it("renders the escalation-cap refusal line", () => {
		renderChatRow(sayToolMessage({ tool: "thinkingEffort", refusal: "escalation_cap" }))

		expect(
			screen.getByText("🧠 Thinking effort unchanged: escalation limit of 3 upward changes per task reached"),
		).toBeInTheDocument()
	})

	it("renders nothing for unknown say-tool payloads", () => {
		const { container } = renderChatRow(sayToolMessage({ tool: "someOtherTool" }))

		expect(container.textContent).toBe("")
	})
})
