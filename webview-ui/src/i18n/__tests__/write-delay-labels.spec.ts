import en from "../locales/en/settings.json"
import zhCn from "../locales/zh-CN/settings.json"
import zhTw from "../locales/zh-TW/settings.json"

const delayLabel = (bundle: { autoApprove: { write: { delayLabel: string } } }): string =>
	bundle.autoApprove.write.delayLabel

describe("autoApprove.write.delayLabel locales", () => {
	it("describes a delay AFTER the write, not an inspection window before it", () => {
		// The setting delays the write-completion path so diagnostics can run after the file is
		// on disk. A label that promises a window before approval describes behaviour the code
		// does not have, which is what the zh-CN bundle used to say.
		expect(delayLabel(en)).toContain("after writes")
		expect(delayLabel(zhTw)).toContain("寫入後")
		expect(delayLabel(zhCn)).toContain("写入后")
	})

	it("keeps the stale pre-write phrasing out of the zh-CN bundle", () => {
		expect(delayLabel(zhCn)).not.toContain("再自动批准写入")
	})
})
