import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { BedrockModelsMessageType, type ProviderSettings } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { BedrockCatalog } from "../BedrockCatalog"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
// Radix Select needs pointer APIs JSDOM lacks; a native select keeps the value wiring testable.
vi.mock("@src/components/ui", () => ({
	Select: ({
		children,
		value,
		onValueChange,
		disabled,
	}: {
		children: React.ReactNode
		value: string
		onValueChange: (value: string) => void
		disabled?: boolean
	}) => (
		<select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
		<option value={value}>{children}</option>
	),
	SelectTrigger: ({ children }: { children: React.ReactNode }) => <option value="">{children}</option>,
	SelectValue: ({ placeholder }: { placeholder: string }) => <>{placeholder}</>,
}))

beforeEach(() => vi.clearAllMocks())

it.each([{}, { awsRegion: "eu-west-3", awsUseApiKey: true }])(
	"does not request discovery for unavailable authentication or region: %j",
	(apiConfiguration) => {
		render(<BedrockCatalog apiConfiguration={apiConfiguration} onSelect={vi.fn()} />)
		expect(screen.getByRole("button")).toBeDisabled()
		fireEvent.click(screen.getByRole("button"))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	},
)

it("disables refresh while loading and renders an unselectable empty successful result", () => {
	const { unmount } = render(<BedrockCatalog apiConfiguration={{ awsRegion: "eu-west-3" }} onSelect={vi.fn()} />)
	fireEvent.click(screen.getByRole("button"))
	const request = vi.mocked(vscode.postMessage).mock.calls[0][0]
	expect(screen.getByRole("button")).toBeDisabled()
	expect(screen.getByRole("button")).toHaveTextContent("settings:providers.awsCatalogLoading")
	fireEvent.click(screen.getByRole("button"))
	expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: BedrockModelsMessageType.bedrockModels, requestId: request.requestId, bedrockModels: [] },
			}),
		),
	)
	expect(screen.getByRole("button")).toBeEnabled()
	expect(screen.getByRole("combobox")).toBeDisabled()
	expect(screen.getByRole("combobox")).toHaveTextContent("settings:providers.awsCatalogEmpty")
	expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	unmount()
	expect(vscode.postMessage).toHaveBeenCalledTimes(1)
})

it("cancels pending discovery on unmount", () => {
	const { unmount } = render(<BedrockCatalog apiConfiguration={{ awsRegion: "eu-west-3" }} onSelect={vi.fn()} />)
	fireEvent.click(screen.getByRole("button"))
	const request = vi.mocked(vscode.postMessage).mock.calls[0][0]
	unmount()
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: BedrockModelsMessageType.cancelBedrockModels,
		requestId: request.requestId,
	})
})

it.each([undefined, "", "  "])("disables incomplete profile discovery (%j)", (awsProfile) => {
	render(
		<BedrockCatalog
			apiConfiguration={{
				awsRegion: "eu-west-3",
				awsUseProfile: true,
				awsProfile,
				awsAccessKey: "retained-key",
				awsSecretKey: "retained-secret",
			}}
			onSelect={vi.fn()}
		/>,
	)
	expect(screen.getByRole("button")).toBeDisabled()
	fireEvent.click(screen.getByRole("button"))
	expect(vscode.postMessage).not.toHaveBeenCalled()
})

it.each([true, false])("sends only credentials for the selected mode (profile=%s)", (awsUseProfile) => {
	render(
		<BedrockCatalog
			apiConfiguration={{
				awsRegion: "eu-west-3",
				awsUseProfile,
				awsProfile: "work",
				awsAccessKey: "key",
				awsSecretKey: "secret",
				awsSessionToken: "session",
			}}
			onSelect={vi.fn()}
		/>,
	)
	fireEvent.click(screen.getByRole("button"))
	expect(vi.mocked(vscode.postMessage).mock.calls[0][0].apiConfiguration).toEqual({
		awsRegion: "eu-west-3",
		awsUseProfile,
		...(awsUseProfile
			? { awsProfile: "work" }
			: { awsAccessKey: "key", awsSecretKey: "secret", awsSessionToken: "session" }),
	})
})

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
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: BedrockModelsMessageType.cancelBedrockModels,
			requestId: first.requestId,
		})
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
		const second = vi.mocked(vscode.postMessage).mock.calls[2][0]
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
		expect(vscode.postMessage).toHaveBeenCalledTimes(3)
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
