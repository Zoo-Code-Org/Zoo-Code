import React from "react"
import { createInstance } from "i18next"
import englishSettings from "@/i18n/locales/en/settings.json"
import germanSettings from "@/i18n/locales/de/settings.json"

import type {
	EmbedderProvider,
	ExtensionState,
	FailedFileStatus,
	IndexingStatus,
	IndexingStatusUpdateMessage,
} from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types"

import { act, fireEvent, renderWithExtensionState, screen, within } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"
import { useOpenRouterModelProviders } from "@src/components/ui/hooks/useOpenRouterModelProviders"

import { CodeIndexPopover, createValidationSchema } from "../CodeIndexPopover"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, parameters?: Record<string, unknown>) =>
			key === "settings:codeIndex.indexingFilesRetrying" || key === "settings:codeIndex.indexingFilesFailed"
				? `${key}: ${parameters?.count} / ${parameters?.path} / ${parameters?.reason}`
				: key.startsWith("settings:codeIndex.provider")
					? translation.t(key, parameters)
					: key,
	}),
}))

vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	OPENROUTER_DEFAULT_PROVIDER_NAME: "Auto",
	useOpenRouterModelProviders: vi.fn(() => ({ data: undefined })),
}))

vi.mock("@src/components/ui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@src/components/ui")>()
	return {
		...actual,
		Popover: ({ children, onOpenChange }: React.PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>) => {
			React.useEffect(() => onOpenChange?.(true), [onOpenChange])
			return <>{children}</>
		},
		PopoverContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
		Select: ({
			children,
			value,
			onValueChange,
		}: React.PropsWithChildren<{
			value?: string
			onValueChange?: (value: string) => void
		}>) => (
			<select value={value} onChange={(event) => onValueChange?.(event.target.value)}>
				{children}
			</select>
		),
		SelectTrigger: () => null,
		SelectValue: () => null,
		SelectContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
		SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => (
			<option value={value}>{children}</option>
		),
	}
})

const indexingStatus: IndexingStatus = {
	systemStatus: "Standby",
	message: "",
	processedItems: 0,
	totalItems: 0,
	currentItemUnit: "items",
}

const baseSettings = {
	codebaseIndexEnabled: true,
	codebaseIndexQdrantUrl: "http://localhost:6333",
	codebaseIndexEmbedderModelId: "embedding-model",
}

const translate = (key: string) => key
const translation = createInstance()

beforeAll(async () => {
	await translation.init({
		lng: "en",
		resources: { en: { settings: englishSettings }, de: { settings: germanSettings } },
		interpolation: { escapeValue: false },
	})
})

describe("CodeIndexPopover validation", () => {
	it.each([
		{
			provider: providerIdentifiers.openai,
			requiredField: "codeIndexOpenAiKey",
			settings: { codeIndexOpenAiKey: "openai-key" },
		},
		{
			provider: providerIdentifiers.ollama,
			requiredField: "codebaseIndexEmbedderBaseUrl",
			settings: { codebaseIndexEmbedderBaseUrl: "http://localhost:11434" },
		},
		{
			provider: providerIdentifiers.gemini,
			requiredField: "codebaseIndexGeminiApiKey",
			settings: { codebaseIndexGeminiApiKey: "gemini-key" },
		},
		{
			provider: providerIdentifiers.mistral,
			requiredField: "codebaseIndexMistralApiKey",
			settings: { codebaseIndexMistralApiKey: "mistral-key" },
		},
		{
			provider: providerIdentifiers.vercelAiGateway,
			requiredField: "codebaseIndexVercelAiGatewayApiKey",
			settings: { codebaseIndexVercelAiGatewayApiKey: "gateway-key" },
		},
		{
			provider: providerIdentifiers.bedrock,
			requiredField: "codebaseIndexBedrockRegion",
			settings: { codebaseIndexBedrockRegion: "us-east-1" },
		},
		{
			provider: providerIdentifiers.openrouter,
			requiredField: "codebaseIndexOpenRouterApiKey",
			settings: { codebaseIndexOpenRouterApiKey: "openrouter-key" },
		},
	])("requires provider-specific configuration for $provider", ({ provider, requiredField, settings }) => {
		const schema = createValidationSchema(provider, translate)
		const validSettings = { ...baseSettings, ...settings }

		expect(schema.safeParse(validSettings).success).toBe(true)

		const invalidSettings = { ...validSettings, [requiredField]: "" }
		const result = schema.safeParse(invalidSettings)
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues).toEqual(
				expect.arrayContaining([expect.objectContaining({ path: [requiredField] })]),
			)
		}
	})
})

describe("CodeIndexPopover OpenRouter provider lookup", () => {
	const mockedUseOpenRouterModelProviders = vi.mocked(useOpenRouterModelProviders)

	const renderPopover = (
		provider: EmbedderProvider,
		modelId: string,
		apiProvider?: ExtensionState["apiConfiguration"],
	) =>
		renderWithExtensionState(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<button>Open code index settings</button>
			</CodeIndexPopover>,
			{
				state: {
					codebaseIndexConfig: {
						...baseSettings,
						codebaseIndexEmbedderProvider: provider,
						codebaseIndexEmbedderModelId: modelId,
					},
					codebaseIndexModels: {},
					apiConfiguration: apiProvider,
					platform: "darwin",
					arch: "arm64",
				} as Partial<ExtensionState>,
			},
		)

	beforeEach(() => {
		mockedUseOpenRouterModelProviders.mockClear()
	})

	it("disables provider lookup for a non-OpenRouter embedder", () => {
		renderPopover(providerIdentifiers.openai, "text-embedding-3-small")

		expect(mockedUseOpenRouterModelProviders).toHaveBeenLastCalledWith(undefined, undefined, { enabled: false })
	})

	it("waits for an OpenRouter model selection before enabling lookup", () => {
		renderPopover(providerIdentifiers.openrouter, "")

		expect(mockedUseOpenRouterModelProviders).toHaveBeenLastCalledWith("", undefined, { enabled: false })
	})

	it("loads providers for the selected OpenRouter embedding model", () => {
		renderPopover(providerIdentifiers.openrouter, "openai/text-embedding-3-small")

		expect(mockedUseOpenRouterModelProviders).toHaveBeenLastCalledWith("openai/text-embedding-3-small", undefined, {
			enabled: true,
		})
	})

	it.each([
		{ provider: providerIdentifiers.openai, label: "settings:codeIndex.openAiKeyLabel" },
		{ provider: providerIdentifiers.ollama, label: "settings:codeIndex.ollamaBaseUrlLabel" },
		{ provider: providerIdentifiers.gemini, label: "settings:codeIndex.geminiApiKeyLabel" },
		{ provider: providerIdentifiers.mistral, label: "settings:codeIndex.mistralApiKeyLabel" },
		{
			provider: providerIdentifiers.vercelAiGateway,
			label: "settings:codeIndex.vercelAiGatewayApiKeyLabel",
		},
		{ provider: providerIdentifiers.bedrock, label: "settings:codeIndex.bedrockRegionLabel" },
		{ provider: providerIdentifiers.openrouter, label: "settings:codeIndex.openRouterApiKeyLabel" },
	] as const)("renders the $provider provider settings when the setup section opens", ({ provider, label }) => {
		renderPopover(provider, "embedding-model")
		fireEvent.click(screen.getByText("settings:codeIndex.setupConfigLabel"))

		expect(screen.getByText(label)).toBeInTheDocument()
	})

	it.each([
		{
			name: "matching Bedrock API provider",
			apiConfiguration: {
				apiProvider: providerIdentifiers.bedrock,
				awsRegion: "us-west-2",
				awsProfile: "development",
			},
			expectedRegion: "us-west-2",
			expectedProfile: "development",
		},
		{
			name: "mismatched API provider",
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				awsRegion: "us-west-2",
				awsProfile: "development",
			},
			expectedRegion: "",
			expectedProfile: "",
		},
		{
			name: "unset API provider",
			apiConfiguration: {},
			expectedRegion: "",
			expectedProfile: "",
		},
	] as const)("populates Bedrock fields for $name", ({ apiConfiguration, expectedRegion, expectedProfile }) => {
		renderPopover(providerIdentifiers.openai, "embedding-model", apiConfiguration)
		fireEvent.click(screen.getByText("settings:codeIndex.setupConfigLabel"))

		fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: providerIdentifiers.bedrock } })

		expect(screen.getByPlaceholderText("settings:codeIndex.bedrockRegionPlaceholder")).toHaveValue(expectedRegion)
		expect(screen.getByPlaceholderText("settings:codeIndex.bedrockProfilePlaceholder")).toHaveValue(expectedProfile)
	})

	it("shows a field error when saving a changed provider without its required key", () => {
		renderPopover(providerIdentifiers.openai, "embedding-model")
		fireEvent.click(screen.getByText("settings:codeIndex.setupConfigLabel"))
		fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: providerIdentifiers.gemini } })
		fireEvent.click(screen.getByText("settings:codeIndex.saveSettings"))

		expect(screen.getByText("settings:codeIndex.validation.geminiApiKeyRequired")).toBeInTheDocument()
	})
})

const failedStatus = (
	state: FailedFileStatus["state"],
	systemStatus = state === "retrying" ? "Indexing" : "Standby",
): IndexingStatus => {
	const failure: FailedFileStatus = {
		path: "src/failed.ts",
		activity: "embed",
		reason: "Provider unavailable",
		state,
	}
	return {
		...indexingStatus,
		systemStatus,
		workspacePath: "/workspace",
		workspaceEnabled: true,
		autoEnableDefault: false,
		processedItems: 2,
		totalItems: 8,
		failedFiles: [failure],
		failedFileSummary: { ...failure, count: 1 },
	}
}

const renderStatusPopover = (status: IndexingStatus, language: ExtensionState["language"] = "en") =>
	renderWithExtensionState(
		<CodeIndexPopover indexingStatus={status}>
			<button>Open code index settings</button>
		</CodeIndexPopover>,
		{
			state: {
				language,
				cwd: "/workspace",
				codebaseIndexConfig: { ...baseSettings, codebaseIndexEmbedderProvider: providerIdentifiers.openai },
				codebaseIndexModels: {},
				platform: "win32",
				arch: "x64",
			},
		},
	)

const publishStatus = (values: IndexingStatus) => {
	const data: IndexingStatusUpdateMessage = { type: "indexingStatusUpdate", values }
	act(() => window.dispatchEvent(new MessageEvent("message", { data })))
}

describe("CodeIndexPopover indexing reliability", () => {
	beforeEach(async () => {
		vi.clearAllMocks()
		await translation.changeLanguage("en")
	})

	it.each(["Indexing", "Indexed", "Standby", "Stopping", "Error"])(
		"localizes timed and untimed waits without false resume promises in %s",
		async (systemStatus) => {
			await translation.changeLanguage("de")
			const resumeAt = Date.parse("2026-11-11T12:02:00Z")
			renderStatusPopover(
				{
					...indexingStatus,
					systemStatus,
					providerWaits: [
						{ service: "openai", resumeAt, waitingFiles: ["waiting.ts"] },
						{ service: "qdrant", waitingFiles: [] },
					],
				},
				"de",
			)
			const active = systemStatus === "Indexing"
			const timed = active ? "providerWaitingUntil" : "providerPausedUntil"
			const untimed = active ? "providerWaiting" : "providerPaused"
			expect(
				screen.getByText(
					translation.t(`settings:codeIndex.${timed}`, {
						service: "openai",
						time: new Date(resumeAt).toLocaleString("de"),
					}),
				),
			).toBeVisible()
			expect(
				screen.getByText(translation.t(`settings:codeIndex.${untimed}`, { service: "qdrant" })),
			).toBeVisible()
			expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument()
			if (!active) expect(screen.queryByText(/automatisch fortgesetzt/)).not.toBeInTheDocument()
		},
	)

	it("keeps two provider waits separate from genuine failures and Stop enabled", () => {
		renderStatusPopover({
			...failedStatus("retrying"),
			providerWaits: [
				{ service: "openai", resumeAt: Date.now() + 120_000, waitingFiles: ["src/waiting-embed.ts"] },
				{ service: "qdrant", waitingFiles: ["src/waiting-store.ts"] },
			],
		})
		expect(screen.getByText(/Waiting for openai; indexing resumes automatically at/)).toBeVisible()
		expect(screen.getByText("Waiting for qdrant; indexing resumes automatically")).toBeVisible()
		for (const path of ["src/waiting-embed.ts", "src/waiting-store.ts"]) {
			expect(screen.getByText(path)).toBeVisible()
			expect(screen.getByRole("status")).not.toHaveTextContent(path)
		}
		expect(screen.getByRole("status")).toHaveTextContent("1 / src/failed.ts")
		const stop = screen.getByRole("button", { name: "settings:codeIndex.stopIndexingButton" })
		expect(stop).toBeEnabled()
		fireEvent.click(stop)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "stopIndexing" })
		publishStatus({ ...indexingStatus, providerWaits: [], failedFiles: [] })
		expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument()
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
	})

	it.each(["empty", "omitted"])("clears waiting-only snapshots when waits are %s", (snapshot) => {
		renderStatusPopover({
			...indexingStatus,
			systemStatus: "Indexing",
			providerWaits: [{ service: "openai", waitingFiles: ["waiting.ts"] }],
		})
		expect(screen.getByText("waiting.ts")).toBeVisible()
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
		expect(screen.queryByText(/settings:codeIndex.failedFileDetails/)).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "settings:codeIndex.startIndexingButton" })).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "settings:codeIndex.stopIndexingButton" })).toBeEnabled()
		publishStatus({ ...indexingStatus, providerWaits: snapshot === "empty" ? [] : undefined })
		expect(screen.queryByText("waiting.ts")).not.toBeInTheDocument()
		expect(screen.queryByText(/Waiting for/)).not.toBeInTheDocument()
		expect(screen.queryByRole("status")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "settings:codeIndex.startIndexingButton" })).toBeEnabled()
	})

	it("replaces waits from parent snapshots and ignores waits for other workspaces", () => {
		const view = renderStatusPopover({
			...indexingStatus,
			providerWaits: [{ service: "openai", waitingFiles: ["waiting.ts"] }],
		})
		publishStatus({ ...indexingStatus, workspacePath: "/other", providerWaits: [] })
		expect(screen.getByText("waiting.ts")).toBeVisible()
		view.rerender(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<button>Open code index settings</button>
			</CodeIndexPopover>,
		)
		expect(screen.queryByText("waiting.ts")).not.toBeInTheDocument()
	})

	it.each(["retrying", "exhausted"] as const)("shows %s summary and expandable file details", (state) => {
		renderStatusPopover(failedStatus(state))
		const summaryKey = state === "retrying" ? "indexingFilesRetrying" : "indexingFilesFailed"
		expect(screen.getByRole("status")).toHaveTextContent(
			`settings:codeIndex.${summaryKey}: 1 / src/failed.ts / Provider unavailable`,
		)
		const summary = screen.getByText("settings:codeIndex.failedFileDetails (1)")
		const details = summary.closest("details")!
		expect(details).not.toHaveAttribute("open")
		fireEvent.click(summary)
		expect(within(details).getByText("src/failed.ts")).toBeInTheDocument()
		expect(within(details).getByText("settings:codeIndex.failedFileActivities.embed")).toBeInTheDocument()
		expect(within(details).getByText(`settings:codeIndex.failedFileStates.${state}`)).toBeInTheDocument()
		expect(
			within(details).getByText("settings:codeIndex.failedFileReason: Provider unavailable"),
		).toBeInTheDocument()
	})

	it("renders all five failure activities and both retry states", () => {
		const activities: FailedFileStatus["activity"][] = ["read", "parse", "embed", "upsert", "delete"]
		const failedFiles: FailedFileStatus[] = activities.map((activity, index) => ({
			path: `src/${activity}.ts`,
			activity,
			reason: `${activity} failed`,
			state: index % 2 === 0 ? "retrying" : "exhausted",
		}))
		renderStatusPopover({ ...failedStatus("retrying"), failedFiles, failedFileSummary: undefined })
		const details = screen.getByText("settings:codeIndex.failedFileDetails (5)").closest("details")!
		fireEvent.click(within(details).getByText("settings:codeIndex.failedFileDetails (5)"))
		for (const failure of failedFiles) {
			const entry = within(details).getByText(failure.path).closest("li")!
			expect(
				within(entry).getByText(`settings:codeIndex.failedFileActivities.${failure.activity}`),
			).toBeInTheDocument()
			expect(within(entry).getByText(`settings:codeIndex.failedFileStates.${failure.state}`)).toBeInTheDocument()
			expect(
				within(entry).getByText(`settings:codeIndex.failedFileReason: ${failure.reason}`),
			).toBeInTheDocument()
		}
	})

	it("allows explicit Start for idle partial Standby", () => {
		renderStatusPopover(failedStatus("exhausted"))
		const start = screen.getByRole("button", { name: "settings:codeIndex.startIndexingButton" })
		expect(start).toBeEnabled()
		fireEvent.click(start)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "startIndexing" })
	})

	it.each(["Indexing", "Stopping"])("keeps Start discoverable but disabled during %s", (systemStatus) => {
		renderStatusPopover(failedStatus("retrying", systemStatus))
		const start = screen.getByRole("button", { name: "settings:codeIndex.startIndexingButton" })
		expect(start).toBeDisabled()
		fireEvent.click(start)
		expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "startIndexing" })
		if (systemStatus === "Stopping") {
			expect(screen.getByRole("button", { name: "settings:codeIndex.stoppingButton" })).toBeDisabled()
		} else {
			fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.stopIndexingButton" }))
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "stopIndexing" })
		}
	})

	it.each([
		["Indexing", "Embedding batch 2 of 8"],
		["Error", "Parser timeout at src/hung.ts. Start indexing to retry or disable indexing. Not a provider error."],
		["Stopping", "Stopping parser and pending retries"],
		["Standby", "Indexing stopped. Partial index data preserved."],
	])("preserves the backend %s message alongside failures", (systemStatus, message) => {
		renderStatusPopover({ ...failedStatus("exhausted", systemStatus), message })
		expect(
			screen.getByText(`settings:codeIndex.indexingStatuses.${systemStatus.toLowerCase()} - ${message}`),
		).toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("settings:codeIndex.indexingFilesFailed")
		if (systemStatus === "Indexing") {
			expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25")
		}
	})

	it.each([{ failedFiles: undefined }, { failedFiles: [] }])(
		"omits failure UI for zero failures: %s",
		({ failedFiles }) => {
			renderStatusPopover({
				...failedStatus("exhausted", "Indexed"),
				failedFiles,
				failedFileSummary: { ...failedStatus("exhausted").failedFileSummary!, count: 0 },
			})
			expect(screen.queryByRole("status")).not.toBeInTheDocument()
			expect(screen.queryByText(/settings:codeIndex.failedFileDetails/)).not.toBeInTheDocument()
			expect(
				screen.queryByRole("button", { name: "settings:codeIndex.startIndexingButton" }),
			).not.toBeInTheDocument()
		},
	)

	it("preserves whole status messages and filters other workspaces", () => {
		renderStatusPopover(indexingStatus)
		const status = { ...failedStatus("exhausted"), message: "Partial index available", autoEnableDefault: true }
		publishStatus(status)
		expect(screen.getByText("settings:codeIndex.failedFileDetails (1)")).toBeInTheDocument()
		expect(screen.getByRole("checkbox", { name: "settings:codeIndex.workspaceToggleLabel" })).toBeChecked()
		expect(screen.getByRole("checkbox", { name: "settings:codeIndex.autoEnableDefaultLabel" })).toBeChecked()
		publishStatus({ ...indexingStatus, systemStatus: "Error", message: "Wrong workspace", workspacePath: "/other" })
		expect(screen.queryByText(/Wrong workspace/)).not.toBeInTheDocument()
		expect(screen.getByText(/Partial index available/)).toBeInTheDocument()
		publishStatus({ ...indexingStatus, systemStatus: "Indexed" })
		expect(screen.queryByText(/settings:codeIndex.failedFileDetails/)).not.toBeInTheDocument()
		expect(screen.getByText("settings:codeIndex.indexingStatuses.indexed")).toBeInTheDocument()
		expect(screen.getByRole("checkbox", { name: "settings:codeIndex.workspaceToggleLabel" })).not.toBeChecked()
	})

	it("accepts whole status updates from the badge prop", () => {
		const view = renderStatusPopover(indexingStatus)
		view.rerender(
			<CodeIndexPopover indexingStatus={failedStatus("retrying")}>
				<button>Open code index settings</button>
			</CodeIndexPopover>,
		)
		expect(screen.getByRole("status")).toHaveTextContent("settings:codeIndex.indexingFilesRetrying")
		expect(screen.getByRole("checkbox", { name: "settings:codeIndex.workspaceToggleLabel" })).toBeChecked()
		expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25")
	})
})
