// npx vitest src/i18n/__tests__/plurals.spec.ts
//
// Renders plural strings from the real locale bundles with i18next, so a
// missing CLDR form shows up as the wrong text or as the English fallback.

import i18next from "i18next"

import enChat from "../locales/en/chat.json"
import enCommon from "../locales/en/common.json"
import enHistory from "../locales/en/history.json"
import frChat from "../locales/fr/chat.json"
import plHistory from "../locales/pl/history.json"
import ruChat from "../locales/ru/chat.json"
import ruCommon from "../locales/ru/common.json"
import ruHistory from "../locales/ru/history.json"

async function translator(language: string) {
	const instance = i18next.createInstance()
	await instance.init({
		lng: language,
		fallbackLng: "en",
		resources: {
			en: { chat: enChat, common: enCommon, history: enHistory },
			fr: { chat: frChat },
			pl: { history: plHistory },
			ru: { chat: ruChat, common: ruCommon, history: ruHistory },
		},
	})
	return instance.t
}

describe("plural forms", () => {
	it.each([
		["ru", "chat:autoApprove.triggerLabel", 0, "0 авто-утвержденных"],
		["ru", "chat:autoApprove.triggerLabel", 1, "1 авто-утвержденное"],
		["ru", "chat:autoApprove.triggerLabel", 2, "2 авто-утвержденных"],
		["ru", "chat:autoApprove.triggerLabel", 5, "5 авто-утвержденных"],
		["ru", "common:time_ago.seconds_ago", 31, "31 секунду назад"],
		["ru", "common:time_ago.seconds_ago", 32, "32 секунды назад"],
		["ru", "common:time_ago.seconds_ago", 45, "45 секунд назад"],
		["ru", "chat:contextManagement.truncation.messagesRemoved", 2, "2 сообщения удалено"],
		["ru", "history:subtasks", 3, "3 подзадачи"],
		["pl", "history:subtasks", 22, "22 podzadania"],
		["fr", "chat:codebaseSearch.didSearch", 0, "0 résultat trouvé"],
		["fr", "chat:codebaseSearch.didSearch", 1000000, "1000000 résultats trouvés"],
		["en", "history:deleteItems", 1, "Delete 1 Item"],
	])("%s %s with count %d renders %j", async (language, key, count, expected) => {
		const t = await translator(language)
		expect(t(key, { count })).toBe(expected)
	})
})
