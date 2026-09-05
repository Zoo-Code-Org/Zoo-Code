import assert from "node:assert/strict"

type Effort = "disable" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
type Supported = true | readonly Effort[]

interface ModelState {
	supported: Supported
	required: boolean
	modelDefault?: Effort
	stored?: Effort
	enabled?: boolean
}

const canonicalEfforts = ["low", "medium", "high", "xhigh", "max"] as const
const defaultEfforts = ["low", "medium", "high"] as const
const supportedSets: Supported[] = [
	true,
	["disable", "low", "high"],
	["low", "high"],
	["none", "low", "high"],
	["low", "medium", "high", "xhigh", "max"],
]
const values = [undefined, "disable", "none", "low", "high", "max"] as const
const enabledValues = [undefined, false, true] as const

function availableOptions(state: ModelState): readonly Effort[] {
	return state.supported === true
		? state.required
			? defaultEfforts
			: ["disable", ...defaultEfforts]
		: state.supported
}

function supportsEffort(supported: Supported, effort: Effort): boolean {
	return supported === true || supported.includes(effort)
}

function resolveSelection(state: ModelState): Effort {
	const available = availableOptions(state)
	const defaultEffort = state.modelDefault ?? (state.required ? "medium" : "disable")
	const raw = state.stored ?? defaultEffort
	const fallback = available.includes(defaultEffort) ? defaultEffort : (available[0] ?? raw)
	return available.includes(raw) ? raw : fallback
}

function resolveRequest(state: ModelState): Effort | undefined {
	const disabled = state.stored === "disable" || state.stored === "none" || state.enabled === false
	const canDisable = supportsEffort(state.supported, "disable")
	if (disabled && canDisable) return undefined

	const candidates = [disabled ? undefined : state.stored, state.modelDefault]
	const supported = state.supported
	if (supported !== true && !supported.includes("disable")) {
		candidates.push(canonicalEfforts.find((effort) => supported.includes(effort)))
	}

	for (const effort of candidates) {
		if (
			effort &&
			effort !== "disable" &&
			effort !== "none" &&
			effort !== "minimal" &&
			supportsEffort(state.supported, effort)
		) {
			return effort
		}
	}

	return state.required && state.modelDefault && state.modelDefault !== "none" ? state.modelDefault : undefined
}

let checked = 0
for (const supported of supportedSets) {
	for (const required of [false, true]) {
		for (const modelDefault of values) {
			for (const stored of values) {
				for (const enabled of enabledValues) {
					const state: ModelState = { supported, required, modelDefault, stored, enabled }
					const selection = resolveSelection(state)
					const available = availableOptions(state)
					assert.ok(available.length === 0 || available.includes(selection), "selection must be supported")
					if (!available.includes("disable"))
						assert.notEqual(selection, "disable", "required reasoning cannot disable")

					const normalized: ModelState = {
						...state,
						stored: selection,
						enabled: required || selection !== "disable",
					}
					const request = resolveRequest(normalized)
					if (selection === "disable") {
						assert.equal(request, undefined, "an explicit supported disable must omit reasoning")
					} else if (canonicalEfforts.includes(selection as (typeof canonicalEfforts)[number])) {
						assert.equal(request, selection, "a normalized effort must reach the request")
					}

					checked++
				}
			}
		}
	}
}

console.log(`Reasoning defaults model check passed (${checked} states)`)
