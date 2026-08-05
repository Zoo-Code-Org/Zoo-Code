import { z } from "zod"

export const ZOO_HOST_PROTOCOL_VERSION = 1 as const
export const ZOO_PUBLIC_SCHEMA_VERSION = 1 as const

export const zooCapabilities = [
	"task:start",
	"task:resume",
	"task:input",
	"task:cancel",
	"ask:respond",
	"history:list",
	"host:snapshot",
	"host:shutdown",
	"checkpoint:unavailable",
] as const

export const zooCapabilitySchema = z.enum(zooCapabilities)
export type ZooCapability = z.infer<typeof zooCapabilitySchema>

export const hostHelloSchema = z
	.object({
		type: z.literal("hello"),
		hostId: z.string().min(1),
		supportedVersions: z.array(z.number().int().positive()).nonempty(),
		capabilities: z.record(z.string().regex(/^[1-9]\d*$/), z.array(z.string().min(1))),
		buildVersion: z.string().min(1),
	})
	.strict()
	.superRefine((hello, context) => {
		const advertisedVersions = Object.keys(hello.capabilities).map(Number)
		if (
			advertisedVersions.some((version) => !hello.supportedVersions.includes(version)) ||
			hello.supportedVersions.some((version) => !(String(version) in hello.capabilities))
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Capabilities must be advertised for exactly the supported protocol versions",
			})
		}
	})

export type HostHello = z.infer<typeof hostHelloSchema>

export const parentHelloSchema = z
	.object({
		type: z.literal("hello.select"),
		version: z.number().int().positive(),
		clientVersion: z.string().min(1),
		requiredCapabilities: z.array(zooCapabilitySchema),
	})
	.strict()

export type ParentHello = z.infer<typeof parentHelloSchema>

export type NegotiationResult =
	| { ok: true; version: number }
	| { ok: false; code: "protocol_incompatible"; message: string }

export function negotiateProtocol(
	host: HostHello,
	supportedVersions: readonly number[],
	requiredCapabilities: readonly ZooCapability[],
): NegotiationResult {
	const version = [...supportedVersions]
		.sort((left, right) => right - left)
		.find(
			(candidate) =>
				candidate === ZOO_HOST_PROTOCOL_VERSION &&
				host.supportedVersions.includes(candidate) &&
				requiredCapabilities.every((capability) => host.capabilities[String(candidate)]?.includes(capability)),
		)
	if (version === undefined) {
		return {
			ok: false,
			code: "protocol_incompatible",
			message: "No mutually supported host protocol version provides all required capabilities",
		}
	}

	return { ok: true, version }
}

export function validateParentHello(host: HostHello, parent: ParentHello): NegotiationResult {
	if (parent.version !== ZOO_HOST_PROTOCOL_VERSION) {
		return { ok: false, code: "protocol_incompatible", message: "Selected protocol version has no installed codec" }
	}
	if (!host.supportedVersions.includes(parent.version)) {
		return { ok: false, code: "protocol_incompatible", message: "Parent selected an unadvertised protocol version" }
	}
	const capabilities = host.capabilities[String(parent.version)] ?? []
	const missing = parent.requiredCapabilities.filter((capability) => !capabilities.includes(capability))
	if (missing.length > 0) {
		return {
			ok: false,
			code: "protocol_incompatible",
			message: `Selected protocol version is missing required capabilities: ${missing.join(", ")}`,
		}
	}
	return { ok: true, version: parent.version }
}
