import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { QwenCode } from "../QwenCode"

// Echo interpolation options so assertions can check the default path reaches the message
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
	}),
}))

describe("QwenCode", () => {
	it("renders every label and instruction through translation keys", () => {
		render(<QwenCode apiConfiguration={{}} setApiConfigurationField={vi.fn()} />)

		expect(screen.getByText("settings:providers.qwenCode.oauthPathLabel")).toBeInTheDocument()
		expect(
			screen.getByText(
				'settings:providers.qwenCode.oauthPathDescription {"defaultPath":"~/.qwen/oauth_creds.json"}',
			),
		).toBeInTheDocument()
		expect(screen.getByText("settings:providers.qwenCode.description")).toBeInTheDocument()
		for (const key of ["gettingStarted", "step1", "step2", "step3"]) {
			expect(screen.getByText(new RegExp(`settings:providers\\.qwenCode\\.${key}`))).toBeInTheDocument()
		}
		expect(screen.getByText("settings:providers.qwenCode.setupInstructions")).toHaveAttribute(
			"href",
			"https://github.com/QwenLM/qwen-code/blob/main/README.md",
		)
	})
})
