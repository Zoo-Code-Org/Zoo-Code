import { render, screen } from "@/utils/test-utils"

import RooHero from "../RooHero"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => (key === "welcome:landing.logoAlt" ? "Roo logo" : key),
	}),
}))

describe("RooHero", () => {
	it("renders the logo with the translated alt text", () => {
		render(<RooHero />)

		expect(screen.getByAltText("Roo logo")).toBeInTheDocument()
	})
})
