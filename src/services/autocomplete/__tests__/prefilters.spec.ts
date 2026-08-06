// npx vitest run src/services/autocomplete/__tests__/prefilters.spec.ts

import * as vscode from "vscode"

// The shared vscode mock (resolve.alias) has no InlineCompletionTriggerKind;
// augment it locally rather than touching the shared mock used by every suite.
vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
	}
})

import { AUTOCOMPLETE_DEFAULTS, type AutocompleteConfig } from "@roo-code/types"

import { MAX_CURSORS } from "../constants"
import {
	isLanguageDisabled,
	prefilterDocument,
	shouldBailForWidget,
	shouldSuppressAutomaticTrigger,
} from "../prefilters"
import type { AutocompleteInput } from "../types"

const makeInput = (overrides: Partial<AutocompleteInput> = {}): AutocompleteInput => ({
	document: {
		uri: { fsPath: "/workspace/src/app.ts" },
		languageId: "typescript",
	} as unknown as vscode.TextDocument,
	position: new vscode.Position(0, 0),
	cursorCount: 1,
	languageId: "typescript",
	...overrides,
})

const defaultConfig = (overrides: AutocompleteConfig = {}): AutocompleteConfig => ({
	...AUTOCOMPLETE_DEFAULTS,
	enabled: true,
	...overrides,
})

describe("prefilterDocument", () => {
	it("accepts a plain cursor in an enabled, allowed language", () => {
		const result = prefilterDocument(makeInput(), defaultConfig(), () => true)
		expect(result).toEqual({ ok: true })
	})

	it("rejects multi-cursor editing before any other check", () => {
		const result = prefilterDocument(
			makeInput({ cursorCount: MAX_CURSORS + 1 }),
			defaultConfig({ enabled: true }),
			() => true,
		)
		expect(result).toEqual({ ok: false, reason: "multi-cursor" })
	})

	it("rejects when the feature is disabled", () => {
		const result = prefilterDocument(makeInput(), defaultConfig({ enabled: false }), () => true)
		expect(result).toEqual({ ok: false, reason: "disabled" })
	})

	it("rejects built-in never-complete languages", () => {
		const result = prefilterDocument(makeInput({ languageId: "markdown" }), defaultConfig(), () => true)
		expect(result).toEqual({ ok: false, reason: "language" })
	})

	it("rejects user-disabled languages", () => {
		const result = prefilterDocument(
			makeInput({ languageId: "vue" }),
			defaultConfig({ disabledLanguages: ["vue"] }),
			() => true,
		)
		expect(result).toEqual({ ok: false, reason: "language" })
	})

	it("allows a user-disabled language when the list is empty", () => {
		const result = prefilterDocument(
			makeInput({ languageId: "vue" }),
			defaultConfig({ disabledLanguages: [] }),
			() => true,
		)
		expect(result).toEqual({ ok: true })
	})

	it("rejects files excluded by .rooignore", () => {
		const result = prefilterDocument(makeInput(), defaultConfig(), () => false)
		expect(result).toEqual({ ok: false, reason: "rooignore" })
	})

	it("runs the language check before the rooignore check", () => {
		// An ignored file in a never-complete language should report the language
		// gate (cheapest check first); the rooignore validator must not be called.
		const validateAccess = vi.fn(() => false)
		const result = prefilterDocument(makeInput({ languageId: "log" }), defaultConfig(), validateAccess)
		expect(result).toEqual({ ok: false, reason: "language" })
		expect(validateAccess).not.toHaveBeenCalled()
	})
})

describe("shouldBailForWidget", () => {
	/** A document whose text in any range is `text`. */
	const documentWith = (text: string) => ({ getText: () => text }) as unknown as vscode.TextDocument

	const contextWith = (selected?: { text: string; range: vscode.Range }) =>
		({
			triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
			selectedCompletionInfo: selected,
		}) as unknown as vscode.InlineCompletionContext

	it("bails when the widget would insert text beyond what is typed", () => {
		// The widget will replace "foo" with "foobar", so a completion computed
		// against the current document is stale.
		expect(
			shouldBailForWidget(
				contextWith({ text: "foobar", range: new vscode.Range(0, 0, 0, 3) }),
				documentWith("foo"),
			),
		).toBe(true)
	})

	it("does not bail when the widget selection merely echoes the typed text", () => {
		// This is the common case in Python/TypeScript: the widget re-opens on
		// nearly every keystroke showing what is already there. Bailing here
		// suppressed ghost text permanently.
		expect(
			shouldBailForWidget(
				contextWith({ text: "number", range: new vscode.Range(0, 0, 0, 6) }),
				documentWith("number"),
			),
		).toBe(false)
	})

	it("does not bail when nothing is selected in the widget", () => {
		expect(shouldBailForWidget(contextWith(undefined), documentWith(""))).toBe(false)
	})
})

describe("shouldSuppressAutomaticTrigger", () => {
	it("suppresses automatic triggers in manual mode", () => {
		expect(shouldSuppressAutomaticTrigger(vscode.InlineCompletionTriggerKind.Automatic, "manual")).toBe(true)
	})

	it("allows Invoke triggers in manual mode", () => {
		expect(shouldSuppressAutomaticTrigger(vscode.InlineCompletionTriggerKind.Invoke, "manual")).toBe(false)
	})

	it("allows automatic triggers in automatic mode", () => {
		expect(shouldSuppressAutomaticTrigger(vscode.InlineCompletionTriggerKind.Automatic, "automatic")).toBe(false)
	})
})

describe("isLanguageDisabled", () => {
	it("treats plaintext and markdown as always disabled", () => {
		expect(isLanguageDisabled("plaintext", defaultConfig())).toBe(true)
		expect(isLanguageDisabled("markdown", defaultConfig())).toBe(true)
	})

	it("treats typescript as enabled", () => {
		expect(isLanguageDisabled("typescript", defaultConfig())).toBe(false)
	})

	it("respects the user override list", () => {
		expect(isLanguageDisabled("python", defaultConfig({ disabledLanguages: ["python"] }))).toBe(true)
	})
})
