// npx vitest src/components/modes/__tests__/ModesView.agentsConfig.spec.tsx

import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"
import ModesView from "../ModesView"
import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

vitest.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vitest.fn(),
	},
}))

const mockExtensionState = {
	customModePrompts: {},
	listApiConfigMeta: [],
	enhancementApiConfigId: "",
	setEnhancementApiConfigId: vitest.fn(),
	mode: "interview",
	customModes: [],
	customSupportPrompts: [],
	currentApiConfigName: "",
	customInstructions: "",
	setCustomInstructions: vitest.fn(),
}

const renderModesView = () =>
	render(
		<ExtensionStateContext.Provider value={{ ...mockExtensionState } as any}>
			<ModesView />
		</ExtensionStateContext.Provider>,
	)

Element.prototype.scrollIntoView = vitest.fn()

const openConfigMenu = async () => {
	const configButton = document.querySelector(".codicon-json")?.closest("button")
	expect(configButton).toBeTruthy()
	fireEvent.click(configButton!)
}

describe("ModesView - agents config menu", () => {
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("asks the extension host to resolve the project modes file rather than hardcoding .roomodes", async () => {
		renderModesView()
		await openConfigMenu()

		const editProjectModes = await waitFor(() => screen.getByText("prompts:modes.editProjectModes"))
		fireEvent.mouseDown(editProjectModes)

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openProjectModesFile" })
	})

	it("sends a validateAgents message when Validate agents is clicked", async () => {
		renderModesView()
		await openConfigMenu()

		const validateButton = await waitFor(() => screen.getByText("prompts:modes.validateAgents"))
		fireEvent.mouseDown(validateButton)

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "validateAgents" })
	})

	it("shows the validation result in a dialog when the response arrives", async () => {
		renderModesView()

		fireEvent(
			window,
			new MessageEvent("message", {
				data: {
					type: "agentsValidationResult",
					agentsValidation: {
						filePath: "/workspace/.boo/agents.yaml",
						errors: [],
						warnings: ["common:customModes.validate.missingWhenToUse"],
					},
				},
			}),
		)

		await waitFor(() => {
			expect(screen.getByText("prompts:agentsValidation.title")).toBeInTheDocument()
		})
		expect(screen.getByText(/agents.yaml/)).toBeInTheDocument()
	})
})
