let remoteControlAvailable = false

/** Extension bridge publishes reachability; webview state reads it. */
export function setZooRemoteControlAvailable(available: boolean): void {
	remoteControlAvailable = available
}

export function getZooRemoteControlAvailable(): boolean {
	return remoteControlAvailable
}
