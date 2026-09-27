import { z } from "zod"

import { providerIdentifiers } from "../provider-identifiers.js"
import { baseProviderSettingsShape, createModelIdAccessor, createProviderDefinition } from "./common.js"

export const ZOO_GATEWAY_MODEL_ID_FIELD = "zooGatewayModelId"

export const zooGatewayProviderDefinition = createProviderDefinition({
	apiProvider: providerIdentifiers.zooGateway,
	modelIdKey: ZOO_GATEWAY_MODEL_ID_FIELD,
	getModelId: createModelIdAccessor(ZOO_GATEWAY_MODEL_ID_FIELD),
	schema: {
		...baseProviderSettingsShape,
		zooSessionToken: z.string().optional(),
		[ZOO_GATEWAY_MODEL_ID_FIELD]: z.string().optional(),
		zooGatewayBaseUrl: z.string().optional(),
	},
})
