import { render, screen } from "@/utils/test-utils"

import CodeAccordion from "../CodeAccordion"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			key === "chat:codeAccordion.openFileAriaLabel" ? `${key} ${JSON.stringify(options)}` : key,
	}),
}))

vi.mock("@src/components/common/CodeBlock", () => ({
	default: () => null,
}))

describe("CodeAccordion", () => {
	it("renders the translated open-file aria label when a jump-to-file handler is provided", () => {
		render(
			<CodeAccordion
				path="src/example.ts"
				code="const x = 1"
				language="typescript"
				isExpanded={false}
				onToggleExpand={() => {}}
				onJumpToFile={() => {}}
			/>,
		)

		expect(
			screen.getByLabelText(`chat:codeAccordion.openFileAriaLabel ${JSON.stringify({ path: "src/example.ts" })}`),
		).toBeInTheDocument()
	})
})
