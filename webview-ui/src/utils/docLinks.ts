/**
 * Utility for building Zoo Code documentation links with UTM telemetry.
 *
 * GitHub is the only extension-facing support destination for now.
 */
export function buildDocLink(path: string, campaign: string): string {
	// Remove any leading slash from path
	const cleanPath = path.replace(/^\//, "")
	const [basePath, hash] = cleanPath.split("#")
	const baseUrl = `https://docs.zoocode.dev/${basePath}?utm_source=extension&utm_medium=ide&utm_campaign=${encodeURIComponent(campaign)}`
	return hash ? `${baseUrl}#${hash}` : baseUrl
}
