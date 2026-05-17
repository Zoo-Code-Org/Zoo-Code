const version = process.env.KILO_VERSION ?? process.env.ZOO_VERSION ?? "7.2.52"
const channel = process.env.KILO_CHANNEL ?? process.env.ZOO_CHANNEL ?? "dev"
const release = process.env.KILO_RELEASE === "true" || process.env.ZOO_RELEASE === "true"

export const Script = {
	get channel() {
		return channel
	},
	get version() {
		return version
	},
	get preview() {
		return channel !== "latest"
	},
	get release() {
		return release
	},
	get team() {
		return [] as string[]
	},
}
