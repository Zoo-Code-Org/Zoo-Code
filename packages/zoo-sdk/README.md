# @zoo-code/sdk

TypeScript client for the Zoo Code portable core.

## Usage

```ts
import { ZooClient, createZooServer } from "@zoo-code/sdk"

const server = await createZooServer()
const client = await server.connect()

const session = await client.createSession({ title: "SDK task" })
for await (const chunk of client.sendMessage(session.id, "Summarize this project")) {
	console.log(chunk)
}

await server.close()
```

`ZooClient.connect()` can also attach to an existing server with `{ baseUrl }`, `{ hostname, port }`, `{ ipcPath }`, or an injected test transport.
