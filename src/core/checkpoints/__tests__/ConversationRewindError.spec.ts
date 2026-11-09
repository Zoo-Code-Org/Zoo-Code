import { checkpointRestoreFailureMessage, ConversationRewindError } from "../ConversationRewindError"

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, options?: { error?: string }) => `${key}: ${options?.error}`),
}))

describe("ConversationRewindError", () => {
	it("is restarted unless the restart failed too", () => {
		expect(new ConversationRewindError(new Error("x")).restarted).toBe(true)
		const failed = new ConversationRewindError(new Error("x"), { error: new Error("y") })
		expect(failed.restarted).toBe(false)
		expect(failed.restartFailure).toEqual({ error: new Error("y") })
	})
})

describe("checkpointRestoreFailureMessage", () => {
	it.each([
		["an Error", new Error("Missing commit"), "Missing commit"],
		["a plain value", "Invalid reference", "Invalid reference"],
	])("says a failed restore as such, for %s", (_name, error, reason) => {
		expect(checkpointRestoreFailureMessage(error)).toBe(`common:errors.checkpoint_restore_failed: ${reason}`)
	})

	it.each([
		["an Error", new Error("Failed to save the messages"), "Failed to save the messages"],
		["a plain value", "disk full", "disk full"],
	])(
		"says that the files were restored, and the conversation was not rewound, when the cause is %s",
		(_name, cause, reason) => {
			expect(checkpointRestoreFailureMessage(new ConversationRewindError(cause))).toBe(
				`common:errors.checkpoint_rewind_failed: ${reason}`,
			)
		},
	)

	it("says that the task has to be started by the user too when it could not be started again", () => {
		const error = new ConversationRewindError(new Error("Failed to save the messages"), { error: "no" })

		expect(checkpointRestoreFailureMessage(error)).toBe(
			"common:errors.checkpoint_rewind_restart_failed: Failed to save the messages",
		)
	})
})
