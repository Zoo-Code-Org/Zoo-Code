import { act, fireEvent, screen } from "@testing-library/react"

// Only the recorded calls are read, so any `vi.fn()` or `vi.mocked(fn)` works.
interface PostMessage {
	mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> }
}

/** The request id of the most recent `updateSettings` the component posted. */
export const lastSaveRequestId = (postMessage: PostMessage): string | undefined => {
	const saves = postMessage.mock.calls
		.map((call) => call[0] as { type?: string; requestId?: string })
		.filter((message) => message?.type === "updateSettings")
	return saves.at(-1)?.requestId
}

/** Plays the extension host's answer to a save. */
export const answerSave = (requestId: string | undefined, result: { success: boolean; error?: string }) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "settingsSaveResult", requestId, ...result } }),
		)
	})

/** Clicks Save, then reports the host's success, so the follow-up messages (API config, telemetry) go out. */
export const saveAndConfirm = (postMessage: PostMessage) => {
	fireEvent.click(screen.getByTestId("save-button"))
	answerSave(lastSaveRequestId(postMessage), { success: true })
}
