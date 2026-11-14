import type { ExperimentId } from "@roo-code/types"
import { EXPERIMENT_IDS } from "@roo/experiments"
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithExtensionState } from "@/utils/test-utils"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import SettingsView from "../SettingsView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/utils/TelemetryClient", () => ({ telemetryClient: { capture: vi.fn() } }))

const postMessage = vi.mocked(vscode.postMessage)

const posted = (type: string) =>
	postMessage.mock.calls
		.map((call) => call[0] as { type: string; updatedSettings?: { experiments?: Record<string, boolean> } })
		.filter((message) => message.type === type)

type HostApi = {
	setExperimentEnabled: (id: ExperimentId, enabled: boolean) => void
	setCurrentApiConfigName: (name: string) => void
}

let hostApi: HostApi | undefined

function HostProbe() {
	const state = useExtensionState()
	hostApi = {
		setExperimentEnabled: state.setExperimentEnabled,
		setCurrentApiConfigName: state.setCurrentApiConfigName,
	}
	return null
}

const IMAGE_LABEL = "settings:experimental.IMAGE_GENERATION.name"
const FOCUS_LABEL = "settings:experimental.PREVENT_FOCUS_DISRUPTION.name"
const IMAGE_ID = EXPERIMENT_IDS.IMAGE_GENERATION as ExperimentId
const FOCUS_ID = EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION as ExperimentId

const renderExperimentalTab = () =>
	renderWithExtensionState(
		<>
			<HostProbe />
			<SettingsView onDone={vi.fn()} targetSection="experimental" />
		</>,
		{
			queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
			state: { experiments: { [IMAGE_ID]: false } },
		},
	)

/** The checkbox of the setting whose own label carries the given translation key. */
const settingCheckbox = (labelKey: string) =>
	Array.from(document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).find((element) => {
		const label = element.closest("label")
		return !!label && String(label.textContent || "").includes(labelKey)
	})

const requireCheckbox = (labelKey: string) => {
	const checkbox = settingCheckbox(labelKey)
	if (!checkbox) {
		throw new Error("no checkbox rendered for " + labelKey)
	}
	return checkbox
}

const toggleExperiment = async (labelKey: string) => {
	await act(async () => {
		fireEvent.click(requireCheckbox(labelKey))
	})
}

const clickSave = async () => {
	await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
	fireEvent.click(screen.getByTestId("save-button"))
}

const openExperimentalTab = async () => {
	renderExperimentalTab()
	await waitFor(() => expect(screen.getByTestId("tab-experimental")).toBeInTheDocument())
	fireEvent.click(screen.getByTestId("tab-experimental"))
	await waitFor(() => expect(settingCheckbox(IMAGE_LABEL)).toBeTruthy())
}

describe("SettingsView - experiment edits after the host confirms them", () => {
	beforeEach(() => {
		postMessage.mockClear()
		hostApi = undefined
	})

	it("does not write a confirmed experiment back over a newer value from elsewhere", async () => {
		await openExperimentalTab()

		// This view edits one experiment and saves it.
		await toggleExperiment(IMAGE_LABEL)
		await clickSave()
		const firstSave = posted("updateSettings").at(-1)
		expect(firstSave?.updatedSettings?.experiments).toEqual({ [IMAGE_ID]: true })

		// The host confirms that value, and afterwards a different webview turns the same
		// experiment off while this view is no longer editing it.
		await act(async () => {
			hostApi?.setExperimentEnabled(IMAGE_ID, true)
		})
		await act(async () => {
			hostApi?.setExperimentEnabled(IMAGE_ID, false)
		})

		// An unrelated save must not resurrect this view's copy of that experiment.
		await toggleExperiment(FOCUS_LABEL)
		await clickSave()
		const secondExperiments = posted("updateSettings").at(-1)?.updatedSettings?.experiments ?? {}
		expect(secondExperiments).not.toHaveProperty(String(IMAGE_ID))
		expect(secondExperiments).toEqual({ [FOCUS_ID]: false })
	}, 20000)

	it("keeps an experiment intent the host has not confirmed yet", async () => {
		await openExperimentalTab()

		// Save posts the intent while the host state still reports the old value, so neither the
		// submitted baseline nor the local copy may be dropped before that value arrives.
		await toggleExperiment(IMAGE_LABEL)
		await clickSave()
		const firstSave = posted("updateSettings").at(-1)
		expect(firstSave?.updatedSettings?.experiments).toEqual({ [IMAGE_ID]: true })
		expect(requireCheckbox(IMAGE_LABEL).checked).toBe(true)

		await toggleExperiment(FOCUS_LABEL)
		await clickSave()
		const secondExperiments = posted("updateSettings").at(-1)?.updatedSettings?.experiments ?? {}
		expect(secondExperiments).toEqual({ [FOCUS_ID]: false })
		expect(requireCheckbox(IMAGE_LABEL).checked).toBe(true)
	}, 20000)

	it("does not carry a pending experiment edit into another profile's save", async () => {
		await openExperimentalTab()

		// An experiment is edited but never saved, and then the settings view switches to a
		// different api configuration, which resets the edit session.
		await toggleExperiment(IMAGE_LABEL)
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeEnabled())
		await act(async () => {
			hostApi?.setCurrentApiConfigName("another-profile")
		})
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())

		// The next save belongs to the new session and posts only its own edit.
		await toggleExperiment(FOCUS_LABEL)
		await clickSave()
		const experiments = posted("updateSettings").at(-1)?.updatedSettings?.experiments ?? {}
		expect(experiments).not.toHaveProperty(String(IMAGE_ID))
		expect(experiments).toEqual({ [FOCUS_ID]: false })
	}, 20000)

	it("re-adopts a saved experiment when the host answer arrives after a profile change", async () => {
		await openExperimentalTab()

		// The save is posted, but a profile snapshot arrives before the host answer reaches this
		// view, so the cache reverts to the live value and the session resets.
		await toggleExperiment(IMAGE_LABEL)
		await clickSave()
		const firstSave = posted("updateSettings").at(-1)
		expect(firstSave?.updatedSettings?.experiments).toEqual({ [IMAGE_ID]: true })
		await act(async () => {
			hostApi?.setCurrentApiConfigName("another-profile")
		})
		await waitFor(() => expect(screen.getByTestId("save-button")).toBeDisabled())
		expect(requireCheckbox(IMAGE_LABEL).checked).toBe(false)

		// The answer to the earlier save then arrives: the persisted value is the saved one, so
		// the view has to show it and must not post the reverted value back on a later save.
		await act(async () => {
			hostApi?.setExperimentEnabled(IMAGE_ID, true)
		})
		await waitFor(() => expect(requireCheckbox(IMAGE_LABEL).checked).toBe(true))
		await toggleExperiment(FOCUS_LABEL)
		await clickSave()
		const experiments = posted("updateSettings").at(-1)?.updatedSettings?.experiments ?? {}
		expect(experiments).not.toHaveProperty(String(IMAGE_ID))
		expect(experiments).toEqual({ [FOCUS_ID]: false })
	}, 20000)

	it("keeps a toggle made after the save when the host confirms the earlier value", async () => {
		await openExperimentalTab()

		// Save posts the experiment on, and the user toggles it back off before the host answers.
		await toggleExperiment(IMAGE_LABEL)
		await clickSave()
		const firstSave = posted("updateSettings").at(-1)
		expect(firstSave?.updatedSettings?.experiments).toEqual({ [IMAGE_ID]: true })
		await toggleExperiment(IMAGE_LABEL)
		expect(requireCheckbox(IMAGE_LABEL).checked).toBe(false)

		// The answer to the earlier save arrives: it confirms the value that was submitted, not the
		// value the user wants now, so it may neither flip the checkbox nor retire the edit.
		await act(async () => {
			hostApi?.setExperimentEnabled(IMAGE_ID, true)
		})
		await waitFor(() => expect(requireCheckbox(IMAGE_LABEL).checked).toBe(false))

		// The newer intent is still an edit this view owes the host, so the next save posts it.
		await clickSave()
		const secondSave = posted("updateSettings").at(-1)
		expect(secondSave?.updatedSettings?.experiments).toEqual({ [IMAGE_ID]: false })

		// Once the host confirms that value, the session is retired and a later save leaves the
		// experiment out of the payload entirely.
		await act(async () => {
			hostApi?.setExperimentEnabled(IMAGE_ID, false)
		})
		await toggleExperiment(FOCUS_LABEL)
		await clickSave()
		const thirdExperiments = posted("updateSettings").at(-1)?.updatedSettings?.experiments ?? {}
		expect(thirdExperiments).not.toHaveProperty(String(IMAGE_ID))
		expect(thirdExperiments).toEqual({ [FOCUS_ID]: false })
	}, 20000)
})
