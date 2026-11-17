type GitHubCopilotViewState = {
	/** The newest sign-in request, so a slower, older one cannot overwrite its result. */
	signInId: number
	/** Moves whenever a sign-in starts or settles; anything that began earlier is out of date. */
	changes: number
	/** The newest passive model refresh, so an older overlapping refresh cannot overwrite a newer one. */
	refreshId: number
}

const viewStates = new WeakMap<object, GitHubCopilotViewState>()

/** Per-view bookkeeping that lets sign-in, passive refresh and broadcast discard each other's stale replies. */
export function getGitHubCopilotViewState(view: object): GitHubCopilotViewState {
	let state = viewStates.get(view)
	if (!state) {
		state = { signInId: 0, changes: 0, refreshId: 0 }
		viewStates.set(view, state)
	}
	return state
}
