import { describe, expect, it } from "vitest"

import { providerIdentifiers } from "@roo-code/types"

import { isZooRemoteControlEligible } from "../eligibility.js"

describe("isZooRemoteControlEligible", () => {
	it("returns true when opted in with an eligible Zoo session", () => {
		expect(
			isZooRemoteControlEligible({
				remoteControlEnabled: true,
				apiProvider: providerIdentifiers.zooGateway,
				sessionToken: "zoo_ext_test",
			}),
		).toBe(true)
	})

	it("returns false when the setting is off", () => {
		expect(
			isZooRemoteControlEligible({
				remoteControlEnabled: false,
				apiProvider: providerIdentifiers.zooGateway,
				sessionToken: "zoo_ext_test",
			}),
		).toBe(false)
	})

	it("returns false when the active provider is not eligible", () => {
		expect(
			isZooRemoteControlEligible({
				remoteControlEnabled: true,
				apiProvider: providerIdentifiers.openrouter,
				sessionToken: "zoo_ext_test",
			}),
		).toBe(false)
	})

	it("returns false when the session token is missing", () => {
		expect(
			isZooRemoteControlEligible({
				remoteControlEnabled: true,
				apiProvider: providerIdentifiers.zooGateway,
				sessionToken: undefined,
			}),
		).toBe(false)

		expect(
			isZooRemoteControlEligible({
				remoteControlEnabled: true,
				apiProvider: providerIdentifiers.zooGateway,
				sessionToken: "",
			}),
		).toBe(false)
	})
})
