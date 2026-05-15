export const PRODUCTION_CLERK_BASE_URL = "https://clerk.roocode.com"
export const PRODUCTION_ZOO_CODE_API_URL = "https://app.roocode.com"

export const getClerkBaseUrl = () => process.env.CLERK_BASE_URL || PRODUCTION_CLERK_BASE_URL

export const getRooCodeApiUrl = () => process.env.ZOO_CODE_API_URL || PRODUCTION_ZOO_CODE_API_URL
