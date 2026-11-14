import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ZooCodeAuthBadge } from "../ZooCodeAuthBadge"

const { authState, postMessageMock } = vi.hoisted(() => ({
	authState: {
		zooCodeIsAuthenticated: false,
		zooCodeUserEmail: undefined as string | undefined,
		zooCodeUserImage: undefined as string | undefined,
	},
	postMessageMock: vi.fn(),
}))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ ...authState, zooCodeBaseUrl: "https://zoo.example" }),
}))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: postMessageMock } }))

// Echo interpolation options so assertions can check what a message names
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
	}),
}))

describe("ZooCodeAuthBadge", () => {
	beforeEach(() => {
		authState.zooCodeIsAuthenticated = false
		authState.zooCodeUserEmail = undefined
		authState.zooCodeUserImage = undefined
		postMessageMock.mockClear()
	})

	it("translates the sign-in prompt for signed-out users", () => {
		render(<ZooCodeAuthBadge />)

		const trigger = screen.getByTitle("chat:zooCodeAuth.signIn")
		fireEvent.click(trigger)

		expect(screen.getByRole("link", { name: "chat:zooCodeAuth.signIn" })).toBeInTheDocument()
	})

	it("translates the account menu for signed-in users", () => {
		authState.zooCodeIsAuthenticated = true
		authState.zooCodeUserEmail = "dev@example.com"
		authState.zooCodeUserImage = "https://zoo.example/avatar.png"
		render(<ZooCodeAuthBadge />)

		fireEvent.click(screen.getByTitle('chat:zooCodeAuth.accountTitle {"account":"dev@example.com"}'))

		expect(screen.getByAltText("chat:zooCodeAuth.avatarAlt")).toBeInTheDocument()
		expect(screen.getByRole("link", { name: "chat:zooCodeAuth.goToDashboard" })).toHaveAttribute(
			"href",
			"https://zoo.example/dashboard",
		)
		fireEvent.click(screen.getByRole("button", { name: "chat:zooCodeAuth.signOut" }))
		expect(postMessageMock).toHaveBeenCalledWith({ type: "zooCodeSignOut" })
	})

	it("falls back to the translated connected label when the email is unknown", () => {
		authState.zooCodeIsAuthenticated = true
		render(<ZooCodeAuthBadge />)

		expect(
			screen.getByTitle('chat:zooCodeAuth.accountTitle {"account":"chat:zooCodeAuth.connected"}'),
		).toBeInTheDocument()
	})
})
