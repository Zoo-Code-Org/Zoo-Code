// npx vitest run core/task/__tests__/Task.getCurrentProfileId.spec.ts

import { describe, expect, it } from "vitest"

import type { ExtensionState } from "@roo-code/types"

import { Task } from "../Task"

type ProfileState = Pick<ExtensionState, "currentApiConfigName" | "listApiConfigMeta">

/**
 * The method is a pure projection of provider-profile state, so the specs drive it
 * directly through the bracket-notation prototype seam the existing Task specs use
 * (see `ask-allowlist-cwd.spec.ts`) instead of going through `startNewTask`-driven
 * flows that would couple the assertion to unrelated provider machinery. The mutation
 * gate (REQ-005 run 3) flagged the *return value* as covered-but-never-asserted: these
 * specs pin the exact id in every branch (match, name mismatch, missing list, and
 * `undefined` state), which kills the `??`/optional-chaining/predicate/default-string
 * mutants on the single body line.
 */
function getCurrentProfileId(state: ProfileState | undefined): string {
	const task = Object.create(Task.prototype) as Task
	return task["getCurrentProfileId"](state)
}

describe("Task.getCurrentProfileId", () => {
	it("returns the id of the profile whose name matches currentApiConfigName", () => {
		const state: ProfileState = {
			currentApiConfigName: "alpha",
			listApiConfigMeta: [
				{ id: "prof-beta", name: "beta" },
				{ id: "prof-alpha", name: "alpha" },
			],
		}

		expect(getCurrentProfileId(state)).toBe("prof-alpha")
	})

	it("falls back to the default profile id when no profile name matches", () => {
		const state: ProfileState = {
			currentApiConfigName: "gamma",
			listApiConfigMeta: [{ id: "prof-alpha", name: "alpha" }],
		}

		expect(getCurrentProfileId(state)).toBe("default")
	})

	it("falls back to the default profile id when the profile list is missing", () => {
		const state: ProfileState = {
			currentApiConfigName: "alpha",
			listApiConfigMeta: undefined,
		}

		expect(getCurrentProfileId(state)).toBe("default")
	})

	it("returns the default profile id without throwing when state is undefined", () => {
		// Covers both the `state?.` optional chaining and the `?? "default"` fallback:
		// a mutant that strips the chaining throws here, and a mutant that replaces the
		// default literal (or flips `??` to `&&`) returns something other than "default".
		expect(getCurrentProfileId(undefined)).toBe("default")
	})
})
