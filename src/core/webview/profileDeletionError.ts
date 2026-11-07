/**
 * The deletion of a profile committed, but completing the activation of the replacement
 * profile failed. Distinct from a failed deletion so the caller reports "deleted, but the
 * replacement failed to activate" instead of "could not delete", and so the committed
 * state stays posted and in place rather than being rolled back or misreported.
 *
 * Lives in its own module so webviewMessageHandler can discriminate on it without
 * importing ClineProvider at runtime (the module graph there pulls in the whole task
 * stack, which the message-handler unit tests mock around).
 */
export class ProfileDeletionActivationError extends Error {
	constructor(
		public readonly replacementProfileName: string,
		public readonly activationError: unknown,
	) {
		super(`The profile was deleted, but activating replacement profile '${replacementProfileName}' failed.`)
		this.name = "ProfileDeletionActivationError"
	}
}
