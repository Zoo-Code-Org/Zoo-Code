vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

import { vscode } from "@src/utils/vscode"

import { requestLmStudioModels } from "../useLmStudioModels"

describe("requestLmStudioModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("includes the current unsaved base URL when requesting models", () => {
		requestLmStudioModels("http://127.0.0.1:1234")

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "requestLmStudioModels",
			values: { baseUrl: "http://127.0.0.1:1234" },
		})
	})

	it("preserves an empty base URL so the extension can fall back to the default", () => {
		requestLmStudioModels("")

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "requestLmStudioModels",
			values: { baseUrl: "" },
		})
	})
})
