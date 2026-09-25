import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { BedrockModelsMessageType, type ProviderSettings } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { BedrockCatalog } from "../BedrockCatalog"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

it.each([{ awsRegion: "us-east-1" }, { awsProfile: "other" }])(
	"ignores stale catalogue replies after connection settings change: %j",
	(change) => {
		const config: ProviderSettings = { awsRegion: "eu-west-3", awsUseProfile: true, awsProfile: "work" }
		const onSelect = vi.fn()
		const { rerender } = render(<BedrockCatalog apiConfiguration={config} onSelect={onSelect} />)
		fireEvent.click(screen.getByRole("button"))
		const first = vi.mocked(vscode.postMessage).mock.calls[0][0]
		expect(first.apiConfiguration).toEqual(expect.objectContaining(config))
		rerender(<BedrockCatalog apiConfiguration={{ ...config, ...change }} onSelect={onSelect} />)
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: BedrockModelsMessageType.bedrockModels,
						requestId: first.requestId,
						bedrockModels: [{ arn: "old", name: "Stale", kind: "global" }],
					},
				}),
			),
		)
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button"))
		const second = vi.mocked(vscode.postMessage).mock.calls[1][0]
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: BedrockModelsMessageType.bedrockModels,
						requestId: second.requestId,
						bedrockModels: [{ arn: "new", name: "Current", kind: "geographic" }],
					},
				}),
			),
		)
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "new" } })
		expect(onSelect).toHaveBeenCalledWith("new")
		expect(vscode.postMessage).toHaveBeenCalledTimes(2)
	},
)

it("shows discovery failures and allows retry without claiming availability", () => {
	render(<BedrockCatalog apiConfiguration={{ awsRegion: "eu-west-3" }} onSelect={vi.fn()} />)
	fireEvent.click(screen.getByRole("button"))
	const request = vi.mocked(vscode.postMessage).mock.calls[0][0]
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: BedrockModelsMessageType.bedrockModels, requestId: request.requestId, error: "denied" },
			}),
		),
	)
	expect(screen.getByRole("alert")).toBeInTheDocument()
	expect(screen.getByRole("button")).toBeEnabled()
	expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
})
