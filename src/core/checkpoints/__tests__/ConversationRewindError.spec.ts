import { t } from "../../../i18n"
import {
	checkpointRestoreFailureMessage,
	ConversationRewindError,
	TaskNotRestartedError,
	taskWasNotRestarted,
} from "../ConversationRewindError"

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

	it.each([
		["an Error", new Error("cannot rehydrate"), "cannot rehydrate"],
		["a plain value", "no history", "no history"],
	])(
		"tells why the task could not be started again too, when the restart failure is %s",
		(_name, restartFailure, restartError) => {
			const error = new ConversationRewindError(new Error("Failed to save the messages"), {
				error: restartFailure,
			})

			expect(checkpointRestoreFailureMessage(error)).toBe(
				"common:errors.checkpoint_rewind_restart_failed: Failed to save the messages",
			)
			expect(t).toHaveBeenLastCalledWith("common:errors.checkpoint_rewind_restart_failed", {
				error: "Failed to save the messages",
				restartError,
			})
		},
	)

	it("says that the task has to be opened from the history when it could not be started again after a rewind that worked", () => {
		expect(checkpointRestoreFailureMessage(new TaskNotRestartedError(new Error("cannot rehydrate")))).toBe(
			"common:errors.checkpoint_restart_failed: cannot rehydrate",
		)
	})
})

describe("TaskNotRestartedError and taskWasNotRestarted", () => {
	it.each([
		["a restart that failed after a rewind that worked", new TaskNotRestartedError("x"), true],
		["a failed rewind whose restart failed too", new ConversationRewindError(new Error("x"), { error: "y" }), true],
		["a failed rewind whose task was restarted", new ConversationRewindError(new Error("x")), false],
		["any other failure", new Error("Missing commit"), false],
		["something that is not an error", "Invalid reference", false],
	])("for %s: %s", (_name, error, expected) => {
		expect(taskWasNotRestarted(error)).toBe(expected)
	})

	it.each([
		["an Error", new Error("cannot rehydrate"), "cannot rehydrate"],
		["a plain value", "cannot rehydrate", "cannot rehydrate"],
	])("keeps the cause, an %s", (_name, cause, message) => {
		const error = new TaskNotRestartedError(cause)

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe("TaskNotRestartedError")
		expect(error.message).toBe(message)
		expect(error.cause).toBe(cause)
	})
})
