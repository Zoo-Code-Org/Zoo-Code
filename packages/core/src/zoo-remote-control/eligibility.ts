import { providerIdentifiers } from "@roo-code/types"

export type ZooRemoteControlEligibilityInput = {
	remoteControlEnabled: boolean
	apiProvider: string | undefined
	sessionToken: string | undefined
}

/** True when remote control is opted in and the session is eligible. */
export function isZooRemoteControlEligible({
	remoteControlEnabled,
	apiProvider,
	sessionToken,
}: ZooRemoteControlEligibilityInput): boolean {
	if (!remoteControlEnabled) {
		return false
	}

	if (apiProvider !== providerIdentifiers.zooGateway) {
		return false
	}

	return Boolean(sessionToken && sessionToken.length > 0)
}
