// npx vitest i18n/__tests__/locale-bundles.spec.ts
//
// The i18n setup loads locale bundles from disk outside the test environment,
// so no other suite imports the bundle files. This spec imports every bundle
// directly: it pins the completeness of the keys this unit adds, and it puts
// the bundle files into the coverage report so changed-line coverage can
// measure them.

import { describe, it, expect } from "vitest"
import ca from "../locales/ca/common.json"
import de from "../locales/de/common.json"
import en from "../locales/en/common.json"
import es from "../locales/es/common.json"
import fr from "../locales/fr/common.json"
import hi from "../locales/hi/common.json"
import id from "../locales/id/common.json"
import itBundle from "../locales/it/common.json"
import ja from "../locales/ja/common.json"
import ko from "../locales/ko/common.json"
import nl from "../locales/nl/common.json"
import pl from "../locales/pl/common.json"
import ptBr from "../locales/pt-BR/common.json"
import ru from "../locales/ru/common.json"
import tr from "../locales/tr/common.json"
import vi from "../locales/vi/common.json"
import zhCn from "../locales/zh-CN/common.json"
import zhTw from "../locales/zh-TW/common.json"

const bundles: Record<string, { errors: Record<string, unknown> }> = {
	ca,
	de,
	en,
	es,
	fr,
	hi,
	id,
	it: itBundle,
	ja,
	ko,
	nl,
	pl,
	"pt-BR": ptBr,
	ru,
	tr,
	vi,
	"zh-CN": zhCn,
	"zh-TW": zhTw,
}

// Keys this unit adds to the common namespace (the openFile workspace
// containment error posted by webviewMessageHandler).
const addedKeys = ["path_outside_workspace"]

describe("common locale bundles", () => {
	it.each(Object.keys(bundles))("%s defines every key this unit adds", (locale) => {
		for (const key of addedKeys) {
			expect(bundles[locale].errors[key]).toEqual(expect.any(String))
		}
	})
})
