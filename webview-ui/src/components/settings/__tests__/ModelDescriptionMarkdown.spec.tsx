import { render, screen } from "@/utils/test-utils"

import { ModelDescriptionMarkdown } from "../ModelDescriptionMarkdown"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"settings:modelInfo.showLess": "Less",
				"settings:modelInfo.showMore": "More",
			}
			return translations[key] ?? key
		},
	}),
}))

vi.mock("react-remark", () => ({
	useRemark: () => [null, vi.fn()],
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}))

vi.mock("@/components/ui/collapsible", () => ({
	Collapsible: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("../styles", () => ({
	StyledMarkdown: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

describe("ModelDescriptionMarkdown", () => {
	it("shows the translated show-more label when collapsed", () => {
		render(
			<ModelDescriptionMarkdown
				key="description"
				markdown="Some description"
				isExpanded={false}
				setIsExpanded={() => {}}
			/>,
		)

		expect(screen.getByText("More")).toBeInTheDocument()
	})

	it("shows the translated show-less label when expanded", () => {
		render(
			<ModelDescriptionMarkdown
				key="description"
				markdown="Some description"
				isExpanded={true}
				setIsExpanded={() => {}}
			/>,
		)

		expect(screen.getByText("Less")).toBeInTheDocument()
	})
})
