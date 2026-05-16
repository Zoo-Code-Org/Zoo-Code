import type { Command } from "@/command"
import { Review } from "./review"

function lazyTemplate(build: () => Promise<string>) {
	return {
		then(resolve: (value: string) => unknown, reject?: (reason: unknown) => unknown) {
			return Promise.resolve().then(build).then(resolve, reject)
		},
	} as Promise<string>
}

/**
 * /local-review-uncommitted - local review (uncommitted changes)
 */
export function localReviewUncommittedCommand(build = Review.buildReviewPromptUncommitted): Command.Info {
	return {
		name: "local-review-uncommitted",
		description: "local review (uncommitted changes)",
		get template() {
			return lazyTemplate(build)
		},
		hints: [],
	}
}

/**
 * /local-review - local review (current branch vs base)
 */
export function localReviewCommand(build = Review.buildReviewPromptBranch): Command.Info {
	return {
		name: "local-review",
		description: "local review (current branch)",
		get template() {
			return lazyTemplate(build)
		},
		hints: [],
	}
}
