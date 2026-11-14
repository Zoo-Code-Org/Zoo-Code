import type { McpResource } from "@roo-code/types"

import { render, screen } from "@/utils/test-utils"

import McpResourceRow from "../McpResourceRow"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => {
			const translations: Record<string, string> = {
				"mcp:tool.noDescription": "No description",
				"mcp:resource.returns": "Returns",
				"mcp:resource.unknownMimeType": "Unknown",
			}
			return translations[key] ?? (options ? `${key} ${JSON.stringify(options)}` : key)
		},
	}),
}))

describe("McpResourceRow", () => {
	it("renders the resource URI", () => {
		render(<McpResourceRow item={{ uri: "file:///tmp/example.txt", name: "Example", description: "An example" }} />)

		expect(screen.getByText("file:///tmp/example.txt")).toBeInTheDocument()
	})

	it("falls back to the translated no-description label when name and description are missing", () => {
		render(<McpResourceRow item={{ uri: "file:///tmp/example.txt", name: "" } as McpResource} />)

		expect(screen.getByText("No description")).toBeInTheDocument()
	})

	it("renders the translated returns label and unknown mime type fallback", () => {
		render(<McpResourceRow item={{ uri: "file:///tmp/example.txt", name: "Example" }} />)

		expect(screen.getByText("Returns")).toBeInTheDocument()
		expect(screen.getByText("Unknown")).toBeInTheDocument()
	})

	it("renders the mime type when provided", () => {
		render(<McpResourceRow item={{ uri: "file:///tmp/example.txt", name: "Example", mimeType: "text/plain" }} />)

		expect(screen.getByText("text/plain")).toBeInTheDocument()
		expect(screen.queryByText("Unknown")).not.toBeInTheDocument()
	})
})
