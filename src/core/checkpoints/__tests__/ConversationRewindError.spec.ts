import { checkpointRestoreFailureMessage, ConversationRewindError } from "../ConversationRewindError"

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string, options?: { error?: string }) => `${key}: ${options?.error}`),
}))

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
})
