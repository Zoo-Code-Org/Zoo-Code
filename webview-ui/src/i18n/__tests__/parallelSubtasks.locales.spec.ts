import { readdirSync, readFileSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"

// Phase 3 Unit C i18n contract: every locale ships the parallelSubtasks chat
// strings and the experimental.PARALLEL_SUBTASKS settings strings. Untranslated
// locales intentionally fall back to English text (design §13), so the values
// are not asserted, only presence and key shape.
const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../locales")

const LOCALES = [
	"ca",
	"de",
	"en",
	"es",
	"fr",
	"hi",
	"id",
	"it",
	"ja",
	"ko",
	"nl",
	"pl",
	"pt-BR",
	"ru",
	"tr",
	"vi",
	"zh-CN",
	"zh-TW",
]

const CHAT_KEYS = ["title", "progress", "status", "openReport", "openDebugLog", "goToTask", "noReport"]
const STATUSES = ["queued", "running", "completed", "failed", "aborted"]

describe("parallelSubtasks locale coverage", () => {
	it.each(LOCALES)("%s/chat.json parses and carries the full key set", (locale) => {
		const raw = readFileSync(path.join(LOCALES_DIR, locale, "chat.json"), "utf8")
		const chat = JSON.parse(raw)

		for (const key of CHAT_KEYS) {
			expect(chat.parallelSubtasks).toHaveProperty(key)
		}
		for (const status of STATUSES) {
			expect(chat.parallelSubtasks.status).toHaveProperty(status)
		}
		expect(chat.parallelSubtasks.progress).toContain("{{completed}}")
		expect(chat.parallelSubtasks.progress).toContain("{{total}}")
	})

	it.each(LOCALES)("%s/settings.json parses and carries experimental.PARALLEL_SUBTASKS", (locale) => {
		const raw = readFileSync(path.join(LOCALES_DIR, locale, "settings.json"), "utf8")
		const settings = JSON.parse(raw)

		expect(settings.experimental).toBeDefined()
		expect(settings.experimental.PARALLEL_SUBTASKS).toBeDefined()
		expect(typeof settings.experimental.PARALLEL_SUBTASKS.name).toBe("string")
		expect(typeof settings.experimental.PARALLEL_SUBTASKS.description).toBe("string")
		// The key must live inside `experimental`, not as a stray top-level key.
		expect(settings.PARALLEL_SUBTASKS).toBeUndefined()
	})

	it("keeps exactly the 18 shipped locales", () => {
		expect(
			readdirSync(LOCALES_DIR, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort(),
		).toEqual([...LOCALES].sort())
	})
})
