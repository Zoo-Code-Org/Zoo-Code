export type RequestBody = Record<string, unknown> | unknown[] | string | undefined

export type TransportRequest = {
	method?: string
	path: string
	body?: RequestBody
	headers?: Record<string, string>
}

export interface ZooTransport {
	request<T>(request: TransportRequest): Promise<T>
	stream(request: TransportRequest): AsyncIterableIterator<unknown>
	close?(): Promise<void> | void
}
