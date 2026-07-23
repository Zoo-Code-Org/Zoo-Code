declare module "monocart-reporter" {
	export function addCoverageReport(coverageData: any[], testInfo: any): Promise<void>
}
