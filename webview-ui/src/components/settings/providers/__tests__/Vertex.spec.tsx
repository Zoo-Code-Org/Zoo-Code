import { render, screen } from "@testing-library/react"
import { Vertex } from "../Vertex"
import type { ProviderSettings } from "@roo-code/types"
import { VERTEX_REGIONS } from "@roo-code/types"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, type }: any) => (
		<div>
			{children}
			<input type={type} value={value} onChange={(e) => onInput(e)} />
		</div>
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange, "data-testid": testId }: any) => (
		<label data-testid={testId}>
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<div data-value={value} data-onvaluechange={onValueChange}>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
}))

describe("Vertex", () => {
	const defaultApiConfiguration: ProviderSettings = {
		vertexKeyFile: "",
		vertexJsonCredentials: "",
		vertexProjectId: "",
		vertexRegion: "",
		apiModelId: "gemini-2.0-flash-001",
	}

	const mockSetApiConfigurationField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("VERTEX_REGIONS", () => {
		it('should include the "global" region as the first entry', () => {
			expect(VERTEX_REGIONS[0]).toEqual({ value: "global", label: "global" })
		})

		it('should contain "global" region exactly once', () => {
			const globalRegions = VERTEX_REGIONS.filter((r: { value: string; label: string }) => r.value === "global")
			expect(globalRegions).toHaveLength(1)
		})

		it('should contain the "us" multi-region exactly once', () => {
			const usRegions = VERTEX_REGIONS.filter((r: { value: string; label: string }) => r.value === "us")
			expect(usRegions).toHaveLength(1)
			expect(usRegions[0]).toEqual({ value: "us", label: "us" })
		})

		it('should contain the "eu" multi-region exactly once', () => {
			const euRegions = VERTEX_REGIONS.filter((r: { value: string; label: string }) => r.value === "eu")
			expect(euRegions).toHaveLength(1)
			expect(euRegions[0]).toEqual({ value: "eu", label: "eu" })
		})

		it("should preserve existing regional endpoints", () => {
			expect(VERTEX_REGIONS).toContainEqual({ value: "us-east5", label: "us-east5" })
			expect(VERTEX_REGIONS).toContainEqual({ value: "europe-west1", label: "europe-west1" })
		})

		it('should contain "asia-east1" region exactly once', () => {
			const asiaEast1Regions = VERTEX_REGIONS.filter(
				(r: { value: string; label: string }) => r.value === "asia-east1" && r.label === "asia-east1",
			)
			expect(asiaEast1Regions).toHaveLength(1)
			expect(asiaEast1Regions[0]).toEqual({ value: "asia-east1", label: "asia-east1" })
		})
	})

	it("should not render URL context or grounding search checkboxes", () => {
		render(
			<Vertex
				apiConfiguration={defaultApiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.queryByTestId("checkbox-url-context")).not.toBeInTheDocument()
		expect(screen.queryByTestId("checkbox-grounding-search")).not.toBeInTheDocument()
	})
})
