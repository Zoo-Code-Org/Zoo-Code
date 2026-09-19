import React from "react"

import { render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: {
			exists: () => false,
		},
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

const queryClient = new QueryClient()

function renderChatRow(message: any) {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
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
				/>
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ChatRow - mcp_server_response", () => {
	it("renders images attached to the MCP server response", () => {
		const message: any = {
			type: "say",
			say: "mcp_server_response",
			ts: Date.now(),
			partial: false,
			text: "Screenshot captured: 1152x648",
			images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"],
		}

		renderChatRow(message)

		const img = screen.getByRole("img")
		expect(img).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ")
	})

	it("renders multiple images attached to the MCP server response", () => {
		const message: any = {
			type: "say",
			say: "mcp_server_response",
			ts: Date.now(),
			partial: false,
			text: "[2 image(s) received]",
			images: ["data:image/png;base64,image1data", "data:image/png;base64,image2data"],
		}

		renderChatRow(message)

		const imgs = screen.getAllByRole("img")
		expect(imgs).toHaveLength(2)
		expect(imgs[0]).toHaveAttribute("src", "data:image/png;base64,image1data")
		expect(imgs[1]).toHaveAttribute("src", "data:image/png;base64,image2data")
	})

	it("renders only the text when the MCP server response has no images", () => {
		const message: any = {
			type: "say",
			say: "mcp_server_response",
			ts: Date.now(),
			partial: false,
			text: "Plain text result",
		}

		renderChatRow(message)

		expect(screen.queryByRole("img")).toBeNull()
	})

	it("renders attached images for say types that use the default renderer", () => {
		const message: any = {
			type: "say",
			say: "command_output",
			ts: Date.now(),
			partial: false,
			text: "Some output",
			images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"],
		}

		renderChatRow(message)

		const img = screen.getByRole("img")
		expect(img).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ")
	})
})
