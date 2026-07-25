import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"

/**
 * Required keys for the folder/pin feature introduced in the task-organization
 * work. Every locale's history.json must contain these keys, even if only as a
 * fallback to English, so that components never display a missing-key fallback.
 */
const REQUIRED_HISTORY_KEYS = [
	"newFolder",
	"folderNamePlaceholder",
	"renameFolder",
	"removeFromFolder",
	"deleteEmptyFolder",
	"pin",
	"unpin",
	"pinLimitReached",
	"pinned",
	"folder",
	"tasks",
	"unfiled",
	"dragToOrganize",
	"dropHereToRemove",
	// Sub-task 8 (DnD UX redesign): 16 new keys
	"dragCardToOrganize",
	"selectFolder",
	"selectedFolders_one",
	"selectedFolders_other",
	"createFolderFromSelection",
	"deleteSelectedFolders",
	"deleteFoldersTitle_one",
	"deleteFoldersTitle_other",
	"confirmDeleteFolders_one",
	"confirmDeleteFolders_other",
	"deleteFoldersTasksPreserved",
	"deleteFoldersConfirm_one",
	"deleteFoldersConfirm_other",
	"dropToRemoveFromFolder",
	"mutationPending",
	"mutationFailed",
]

const LOCALES_DIR = path.resolve(__dirname, "../locales")

describe("history.json translation parity", () => {
	it("includes required folder/pin keys in every locale", () => {
		const locales = fs
			.readdirSync(LOCALES_DIR)
			.filter((name) => fs.statSync(path.join(LOCALES_DIR, name)).isDirectory())

		expect(locales.length).toBeGreaterThan(0)

		for (const locale of locales) {
			const filePath = path.join(LOCALES_DIR, locale, "history.json")
			const raw = fs.readFileSync(filePath, "utf-8")
			const history = JSON.parse(raw)

			for (const key of REQUIRED_HISTORY_KEYS) {
				expect(history[key], `Missing key "${key}" in ${locale}/history.json`).toBeDefined()
			}
		}
	})

	it("has identical key shape across all locales for the required task-organization keys", () => {
		// Locales may carry additional legacy keys not present in en. The shape
		// contract that matters for this feature is that every locale exposes
		// the SAME set of required task-organization keys. Sort the required
		// list once and assert every locale's filtered shape equals it.
		const locales = fs
			.readdirSync(LOCALES_DIR)
			.filter((name) => fs.statSync(path.join(LOCALES_DIR, name)).isDirectory())

		const expectedShape = [...REQUIRED_HISTORY_KEYS].sort()

		for (const locale of locales) {
			const filePath = path.join(LOCALES_DIR, locale, "history.json")
			const history = JSON.parse(fs.readFileSync(filePath, "utf-8"))
			const localeRequiredKeys = Object.keys(history)
				.filter((k) => REQUIRED_HISTORY_KEYS.includes(k))
				.sort()

			expect(
				localeRequiredKeys,
				`Key shape mismatch in ${locale}/history.json: missing=${expectedShape.filter(
					(k) => !localeRequiredKeys.includes(k),
				)}`,
			).toEqual(expectedShape)
		}
	})
})
