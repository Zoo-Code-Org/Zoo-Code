import type { ComponentProps } from "react"
import { act, fireEvent, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type ExtensionState, type WebviewMessage } from "@roo-code/types"

import { experimentDefault } from "@roo/experiments"

import { renderWithExtensionState } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import type { About } from "../About"
import type { ApiOptionsProps } from "../ApiOptions"
import type { ExperimentalSettings } from "../ExperimentalSettings"
import type PromptsSettings from "../PromptsSettings"
import SettingsView from "../SettingsView"

type AboutProps = ComponentProps<typeof About>
type ExperimentalProps = ComponentProps<typeof ExperimentalSettings>
type PromptsProps = ComponentProps<typeof PromptsSettings>
type SectionProps = AboutProps & ExperimentalProps & PromptsProps & ApiOptionsProps

// Each stub section records the props that SettingsView passes to it, so a test can call a setter directly.
const section = vi.hoisted(() => ({ props: undefined as unknown }))
const sectionProps = () => section.props as SectionProps

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))
vi.mock("../About", () => ({
	About: (props: AboutProps) => {
		section.props = props
		return null
	},
}))
vi.mock("../ApiOptions", () => ({
	default: (props: ApiOptionsProps) => {
		section.props = props
		return null
	},
}))
vi.mock("../ExperimentalSettings", () => ({
	ExperimentalSettings: (props: ExperimentalProps) => {
		section.props = props
		return null
	},
}))
vi.mock("../PromptsSettings", () => ({
	default: (props: PromptsProps) => {
		section.props = props
		return null
	},
}))

const renderTab = (targetSection: string, state: Partial<ExtensionState>) =>
	renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection={targetSection} />, {
		state,
		queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	})

const pushHostState = (state: Partial<ExtensionState>) =>
	act(() => {
		const message = { type: "state", state: { version: "1.0.0", clineMessages: [], taskHistory: [], ...state } }
		window.dispatchEvent(new MessageEvent("message", { data: message }))
	})

const saveButton = () => screen.getByTestId("save-button")

const lastPosted = (type: WebviewMessage["type"]) =>
	vi
		.mocked(vscode.postMessage)
		.mock.calls.map(([message]) => message)
		.filter((message) => message.type === type)
		.at(-1)

const settings = (updatedSettings: WebviewMessage["updatedSettings"]): WebviewMessage => ({
	type: "updateSettings",
	updatedSettings: expect.objectContaining(updatedSettings),
})

type SetterCase = {
	name: string
	tab: string
	/** The stored state, equal to what `setSame` writes. */
	state: Partial<ExtensionState>
	/** The stored state before `setNew`, when it differs from `state`. */
	stateBeforeNew?: Partial<ExtensionState>
	setSame: (props: SectionProps) => void
	setNew: (props: SectionProps) => void
	saved: WebviewMessage
}

const cases: SetterCase[] = [
	{
		name: "setExperimentEnabled",
		tab: "experimental",
		state: { experiments: { ...experimentDefault, imageGeneration: false, customTools: true } },
		setSame: (props) => props.setExperimentEnabled("imageGeneration", false),
		setNew: (props) => props.setExperimentEnabled("imageGeneration", true),
		saved: settings({ experiments: { ...experimentDefault, imageGeneration: true, customTools: true } }),
	},
	{
		name: "setImageGenerationProvider",
		tab: "experimental",
		// There is only one provider, so the new value is tested from an unset state.
		state: { imageGenerationProvider: providerIdentifiers.openrouter },
		stateBeforeNew: {},
		setSame: (props) => props.setImageGenerationProvider?.(providerIdentifiers.openrouter),
		setNew: (props) => props.setImageGenerationProvider?.(providerIdentifiers.openrouter),
		saved: settings({ imageGenerationProvider: providerIdentifiers.openrouter }),
	},
	{
		name: "setOpenRouterImageApiKey",
		tab: "experimental",
		state: { openRouterImageApiKey: "old-key" },
		setSame: (props) => props.setOpenRouterImageApiKey?.("old-key"),
		setNew: (props) => props.setOpenRouterImageApiKey?.("new-key"),
		saved: settings({ openRouterImageApiKey: "new-key" }),
	},
	{
		name: "setImageGenerationSelectedModel",
		tab: "experimental",
		state: { openRouterImageGenerationSelectedModel: "old-model" },
		setSame: (props) => props.setImageGenerationSelectedModel?.("old-model"),
		setNew: (props) => props.setImageGenerationSelectedModel?.("new-model"),
		saved: settings({ openRouterImageGenerationSelectedModel: "new-model" }),
	},
	{
		name: "setCustomSupportPrompts",
		tab: "prompts",
		state: { customSupportPrompts: { ENHANCE: "old" } },
		setSame: (props) => props.setCustomSupportPrompts({ ENHANCE: "old" }),
		setNew: (props) => props.setCustomSupportPrompts({ ENHANCE: "new" }),
		saved: settings({ customSupportPrompts: { ENHANCE: "new" } }),
	},
	{
		name: "setTelemetrySetting",
		tab: "about",
		state: { telemetrySetting: "enabled" },
		setSame: (props) => props.setTelemetrySetting("enabled"),
		setNew: (props) => props.setTelemetrySetting("disabled"),
		saved: { type: "telemetrySetting", text: "disabled" },
	},
	{
		name: "setDebug",
		tab: "about",
		state: { debug: false },
		setSame: (props) => props.setDebug?.(false),
		setNew: (props) => props.setDebug?.(true),
		saved: { type: "debugSetting", bool: true },
	},
]

describe("SettingsView - field setters", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		section.props = undefined
	})

	it.each(cases)(
		"$name enables Save, and Save sends the new value",
		({ tab, state, stateBeforeNew, setNew, saved }) => {
			renderTab(tab, stateBeforeNew ?? state)
			expect(saveButton()).toBeDisabled()

			act(() => setNew(sectionProps()))
			expect(saveButton()).toBeEnabled()
			fireEvent.click(saveButton())

			expect(lastPosted(saved.type)).toMatchObject(saved)
		},
	)

	it.each(cases)("$name leaves Save disabled when the value is the same", ({ tab, state, setSame }) => {
		renderTab(tab, state)

		act(() => setSame(sectionProps()))

		expect(saveButton()).toBeDisabled()
	})

	// An automatic write that repeats the stored content must not mark the form changed. A user write is compared by
	// identity, so only the very same value is a no-op.
	it.each<[string, { copy: boolean; isUserAction: boolean; dirty: boolean }]>([
		["the same value from the user", { copy: false, isUserAction: true, dirty: false }],
		["an equal copy from an automatic sync", { copy: true, isUserAction: false, dirty: false }],
		["an equal copy from the user", { copy: true, isUserAction: true, dirty: true }],
	])("setApiConfigurationField with %s", (_name, { copy, isUserAction, dirty }) => {
		const openAiHeaders = { "X-Header": "value" }
		renderTab("providers", { apiConfiguration: { openAiHeaders } })
		const stored = sectionProps().apiConfiguration.openAiHeaders
		expect(stored).toEqual(openAiHeaders)

		const value = copy ? { ...stored } : stored
		act(() => sectionProps().setApiConfigurationField("openAiHeaders", value, isUserAction))

		expect(saveButton().hasAttribute("disabled")).toBe(!dirty)
	})

	it("a save sends the edit over an earlier host change and does not revert it", () => {
		renderTab("prompts", { customSupportPrompts: { ENHANCE: "old" } })
		act(() => sectionProps().setCustomSupportPrompts({ ENHANCE: "edited" }))
		pushHostState({ customSupportPrompts: { ENHANCE: "from another view" } })
		fireEvent.click(saveButton())

		expect(lastPosted("updateSettings")).toMatchObject(settings({ customSupportPrompts: { ENHANCE: "edited" } }))
		expect(sectionProps().customSupportPrompts).toEqual({ ENHANCE: "edited" })
	})

	it("a field follows the host again after a save that does not wait for an answer", () => {
		renderTab("about", { telemetrySetting: "enabled" })
		act(() => sectionProps().setTelemetrySetting("disabled"))
		fireEvent.click(saveButton())
		expect(saveButton()).toBeDisabled()

		pushHostState({ telemetrySetting: "disabled" }) // the host stores the save
		pushHostState({ telemetrySetting: "enabled" }) // another view changes the setting

		expect(sectionProps().telemetrySetting).toBe("enabled")
	})
})
