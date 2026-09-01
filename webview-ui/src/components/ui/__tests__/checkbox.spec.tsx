import { render, screen } from "@/utils/test-utils"
import { describe, expect, test } from "vitest"

import { Checkbox } from "../checkbox"

describe("Checkbox", () => {
	test("renders the description variant as checked", () => {
		render(<Checkbox aria-label="Include optional context" variant="description" checked />)

		expect(screen.getByRole("checkbox", { name: "Include optional context" })).toBeChecked()
	})
})
