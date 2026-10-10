# Scope lifecycle: minimal API sketch

Inspired by [yx_scope](https://pub.dev/packages/yx_scope): services initialize and dispose; a holder creates and drops their scope. This is illustrative TypeScript, not an implemented API or a selected library.

## Services

Services know nothing about DI. AsyncLifecycle is a project-owned contract for asynchronous initialization and cleanup, not JavaScript's built-in disposal protocol. These trivial implementations stand in for real resources.

```typescript
interface AsyncLifecycle {
	init(): Promise<void>
	dispose(): Promise<void>
}

class DatabaseService implements AsyncLifecycle {
	async init(): Promise<void> {
		// Open a connection.
	}

	async dispose(): Promise<void> {
		// Close the connection, including after a failed init.
	}

	async search(query: string): Promise<string[]> {
		return [query]
	}
}

class CodeIndexService implements AsyncLifecycle {
	constructor(private readonly database: DatabaseService) {}

	async init(): Promise<void> {
		// Mandatory setup only; do not wait for workspace indexing.
	}

	async dispose(): Promise<void> {
		// Cancel and await any owned background work.
	}

	search(query: string): Promise<string[]> {
		return this.database.search(query)
	}
}
```

## Composition Root and RAII-like ownership

The Composition Root constructs services and returns their initialization queue. The holder owns initialization, publication, and cleanup. This is RAII-like ownership with explicit asynchronous disposal, not deterministic destructors.

A scope is an ownership and lifetime boundary, not a feature facade. Its published view exposes selected services; business operations stay on those services. One workspace scope may contain services from multiple features. The holder below is a proposed infrastructure API, not an existing implementation.

```typescript
interface ScopeDefinition<TScope extends object> {
	readonly scope: TScope
	readonly initializeQueue: readonly (readonly AsyncLifecycle[])[]
}

type ScopeFactory<TScope extends object> = () => ScopeDefinition<TScope>

// Type contract only; implementation is intentionally omitted.
declare class ScopeHolder<TScope extends object> {
	constructor(factory: ScopeFactory<TScope>)
	readonly scope: TScope | undefined
	create(): Promise<void>
	drop(): Promise<void>
}

interface WorkspaceScope {
	readonly codeIndex: CodeIndexService
}

// Composition Root: construction and initialization are separate steps.
function createWorkspaceScope(): ScopeDefinition<WorkspaceScope> {
	const database = new DatabaseService()
	const codeIndex = new CodeIndexService(database)

	const initializeQueue: AsyncLifecycle[][] = [[database], [codeIndex]]

	return { scope: { codeIndex }, initializeQueue }
}

// Each create runs the Composition Root to obtain fresh instances and their queue.
const holder = new ScopeHolder<WorkspaceScope>(createWorkspaceScope)

await holder.create() // Construct, initialize, then publish scope.
try {
	const scope = holder.scope
	if (scope) {
		await scope.codeIndex.search("authentication")
	}
} finally {
	await holder.drop() // Unpublish, then dispose CodeIndex before Database.
}
// holder.scope === undefined; a subsequent create() builds fresh instances.
```

## Required semantics, not implemented here

- The Composition Root passes dependencies directly; the holder publishes selected services, not every owned dependency or the initialization queue. Services receive constructor dependencies, not the scope itself.
- Constructors do not acquire resources; acquisition belongs in init. The queue lists every owned lifecycle service exactly once, excluding borrowed parent services. Omitted services are not managed automatically.
- Concurrent lifecycle calls are serialized; repeated creation while ready or dropping while absent is a no-op.
- The holder records the entire queue before starting initialization. Stages run sequentially; services within a stage initialize in parallel. On failure, all started initializations settle before cleanup; later stages do not start.
- Failed initialization triggers cleanup before creation rejects. A factory failure publishes nothing; constructors must remain resource-free because the holder has not received the queue yet. Scope publication happens only after successful initialization.
- For this example, disposal runs sequentially in reverse flattened queue order, including uninitialized or partially initialized services. Services must tolerate those states. Cleanup continues after errors and preserves both startup and cleanup failures.
- Dropping unpublishes the scope, then awaits resource disposal. Already retained references are not revoked; callers must stop using them.

Reverse queue order is safe for these two services, not a general rule: differing construction and initialization graphs may require separate disposal ordering. This baseline does not provide graph validation or nested feature composition; it is not a complete solution to the ADR requirements.
