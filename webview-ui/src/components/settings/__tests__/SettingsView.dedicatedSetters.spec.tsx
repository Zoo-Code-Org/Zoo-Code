import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { providerIdentifiers } from "@roo-code/types"

import { renderWithExtensionState } from "@/utils/test-utils"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

// The sections are replaced by a button for each dedicated setter that SettingsView hands them, and a read-out of the
// value that they are given back.
vi.mock("../About", () => ({
	About: (props: {
		telemetrySetting: string
		debug?: boolean
		setTelemetrySetting: (value: string) => void
		setDebug?: (value: boolean) => void
	}) => (
		<div>
			<span data-testid="telemetry-value">{String(props.telemetrySetting)}</span>
			<span data-testid="debug-value">{String(props.debug)}</span>
			<button data-testid="edit-telemetry" onClick={() => props.setTelemetrySetting("disabled")} />
			<button data-testid="edit-debug" onClick={() => props.setDebug?.(true)} />
		</div>
	),
}))
vi.mock("../ExperimentalSettings", () => ({
	ExperimentalSettings: (props: {
		experiments: Record<string, boolean>
		imageGenerationProvider?: string
		openRouterImageGenerationSelectedModel?: string
		setExperimentEnabled: (id: string, enabled: boolean) => void
		setImageGenerationProvider: (provider: string) => void
		setImageGenerationSelectedModel: (model: string) => void
	}) => (
		<div>
			<span data-testid="experiments-value">{String(props.experiments.runSlashCommand)}</span>
			<span data-testid="image-provider-value">{String(props.imageGenerationProvider)}</span>
			<span data-testid="image-model-value">{String(props.openRouterImageGenerationSelectedModel)}</span>
			<button data-testid="edit-experiment" onClick={() => props.setExperimentEnabled("runSlashCommand", true)} />
			<button data-testid="edit-image-provider" onClick={() => props.setImageGenerationProvider("mine")} />
			<button data-testid="edit-image-model" onClick={() => props.setImageGenerationSelectedModel("my-model")} />
		</div>
	),
}))
vi.mock("../PromptsSettings", () => ({
	default: (props: {
		customSupportPrompts: Record<string, string>
		setCustomSupportPrompts: (prompts: Record<string, string>) => void
	}) => (
		<div>
			<span data-testid="prompts-value">{JSON.stringify(props.customSupportPrompts)}</span>
			<button data-testid="edit-prompts" onClick={() => props.setCustomSupportPrompts({ ENHANCE: "mine" })} />
		</div>
	),
}))

const hostPosts = (state: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }))
	})

const render = (targetSection: string, state: Record<string, unknown>) =>
	renderWithExtensionState(<SettingsView onDone={vi.fn()} targetSection={targetSection} />, {
		queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		state,
	})

interface Case {
	name: string
	section: string
	key: string
	initial: Record<string, unknown>
	/** What the import answered with (the value that failed to be stored), and what the rollback stored later. */
	answered: unknown
	late: unknown
	edit: string
	read: string
	/** The read-out after the user's edit. */
	edited: string
	/** The read-out of the value the late refresh brings. */
	lateText: string
	answeredText: string
}

const cases: Case[] = [
	{
		name: "the telemetry setting",
		section: "about",
		key: "telemetrySetting",
		initial: { telemetrySetting: "enabled" },
		answered: "unset",
		late: "enabled",
		edit: "edit-telemetry",
		read: "telemetry-value",
		edited: "disabled",
		lateText: "enabled",
		answeredText: "unset",
	},
	{
		name: "the debug setting",
		section: "about",
		key: "debug",
		initial: { debug: false },
		answered: false,
		late: false,
		edit: "edit-debug",
		read: "debug-value",
		edited: "true",
		lateText: "false",
		answeredText: "false",
	},
	{
		name: "an experiment",
		section: "experimental",
		key: "experiments",
		initial: { experiments: { runSlashCommand: false } },
		answered: { runSlashCommand: false },
		late: { runSlashCommand: false },
		edit: "edit-experiment",
		read: "experiments-value",
		edited: "true",
		lateText: "false",
		answeredText: "false",
	},
	{
		name: "the image generation provider",
		section: "experimental",
		key: "imageGenerationProvider",
		initial: { imageGenerationProvider: providerIdentifiers.openrouter },
		answered: "failed",
		late: providerIdentifiers.openrouter,
		edit: "edit-image-provider",
		read: "image-provider-value",
		edited: "mine",
		lateText: providerIdentifiers.openrouter,
		answeredText: "failed",
	},
	{
		name: "the image generation model",
		section: "experimental",
		key: "openRouterImageGenerationSelectedModel",
		initial: { openRouterImageGenerationSelectedModel: "stored-model" },
		answered: "failed-model",
		late: "stored-model",
		edit: "edit-image-model",
		read: "image-model-value",
		edited: "my-model",
		lateText: "stored-model",
		answeredText: "failed-model",
	},
	{
		name: "the support prompts",
		section: "prompts",
		key: "customSupportPrompts",
		initial: { customSupportPrompts: { ENHANCE: "stored" } },
		answered: { ENHANCE: "failed" },
		late: { ENHANCE: "stored" },
		edit: "edit-prompts",
		read: "prompts-value",
		edited: '{"ENHANCE":"mine"}',
		lateText: '{"ENHANCE":"stored"}',
		answeredText: '{"ENHANCE":"failed"}',
	},
]

describe("SettingsView – a late import refresh and the settings that have a setter of their own", () => {
	const answerThenLate = (c: Case) => {
		hostPosts({ [c.key]: c.answered, settingsImportRefreshedAt: 1_000, settingsImportStoredKeys: [c.key] })
		return () =>
			hostPosts({
				[c.key]: c.late,
				settingsImportRefreshedAt: 2_000,
				settingsImportStoredKeys: [c.key],
				settingsImportRefreshIsLate: true,
			})
	}

	it.each(cases)("keeps an edit of $name made after the import was answered", async (c) => {
		render(c.section, c.initial)
		const late = answerThenLate(c)
		await waitFor(() => expect(screen.getByTestId(c.read).textContent).toBe(c.answeredText))

		fireEvent.click(screen.getByTestId(c.edit))
		await waitFor(() => expect(screen.getByTestId(c.read).textContent).toBe(c.edited))
		late()

		expect(screen.getByTestId(c.read).textContent).toBe(c.edited) // not replaced with what the rollback stored
		expect(screen.getByTestId("save-button")).toBeEnabled()
	})

	it.each(cases)("takes the stored value of $name when it was not edited", async (c) => {
		render(c.section, c.initial)
		const late = answerThenLate(c)
		await waitFor(() => expect(screen.getByTestId(c.read).textContent).toBe(c.answeredText))

		late()

		await waitFor(() => expect(screen.getByTestId(c.read).textContent).toBe(c.lateText))
	})

	it.each(cases)(
		"keeps an unsaved edit of $name that the import did not store, though the value changed",
		async (c) => {
			render(c.section, c.initial)
			await screen.findByTestId(c.read)

			fireEvent.click(screen.getByTestId(c.edit))
			await waitFor(() => expect(screen.getByTestId(c.read).textContent).toBe(c.edited))
			// Another provider changed it, and an import that stored something else is refreshed together with that change.
			hostPosts({
				[c.key]: c.answered,
				settingsImportRefreshedAt: 1_000,
				settingsImportStoredKeys: ["somethingElse"],
			})

			expect(screen.getByTestId(c.read).textContent).toBe(c.edited) // the edit is not discarded for it
			expect(screen.getByTestId("save-button")).toBeEnabled()
		},
	)

	it.each(cases)(
		"keeps an unsaved edit of $name through two partial refreshes and a change by another provider",
		async (c) => {
			render(c.section, c.initial)
			await screen.findByTestId(c.read)
			fireEvent.click(screen.getByTestId(c.edit))
			await waitFor(() => expect(screen.getByTestId(c.read).textContent).toBe(c.edited))

			// A first import stored something else; then another provider changes the value; a second import stored something else.
			hostPosts({ settingsImportRefreshedAt: 1_000, settingsImportStoredKeys: ["somethingElse"] })
			hostPosts({ [c.key]: c.answered })
			hostPosts({ [c.key]: c.late, settingsImportRefreshedAt: 2_000, settingsImportStoredKeys: ["another"] })

			expect(screen.getByTestId(c.read).textContent).toBe(c.edited) // the edit is tracked across both
			expect(screen.getByTestId("save-button")).toBeEnabled()
		},
	)
})
