import { render, screen } from "@/utils/test-utils"

import DiffView from "../DiffView"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			key === "chat:diffView.hiddenLines" ? `${key} ${JSON.stringify(options)}` : key,
	}),
}))

// A unified diff with two hunks separated by hidden lines produces a "gap" line
// with a hiddenCount, which renders the translated hidden-lines label.
const twoHunkDiff = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 context
-old
+new
 context
@@ -10,3 +10,3 @@
 context
-old2
+new2
 context
`

describe("DiffView", () => {
	it("renders the translated hidden-lines label for gaps between hunks", () => {
		render(<DiffView source={twoHunkDiff} filePath="file.txt" />)

		expect(screen.getByText(`chat:diffView.hiddenLines ${JSON.stringify({ count: 6 })}`)).toBeInTheDocument()
	})
})
