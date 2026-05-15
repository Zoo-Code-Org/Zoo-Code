# Zoo Code API

The Zoo Code extension exposes an API that can be used by other extensions.

> Note: The npm package and exported API type names intentionally retain the
> legacy `@roo-code` and `RooCodeAPI` names for backward compatibility after the
> extension rebrand to Zoo Code.

To use this API in your extension:

1. Install `@roo-code/types` with npm, pnpm, or yarn.
2. Import the `RooCodeAPI` type.
3. Load the extension API.

```typescript
import { RooCodeAPI } from "@roo-code/types"

const extension = vscode.extensions.getExtension<RooCodeAPI>("ZooCodeOrganization.zoo-code")

if (!extension?.isActive) {
	throw new Error("Extension is not activated")
}

const api = extension.exports

if (!api) {
	throw new Error("API is not available")
}

// Start a new task with an initial message.
await api.startNewTask("Hello, Zoo Code API! Let's make a new project...")

// Start a new task with an initial message and images.
await api.startNewTask("Use this design language", ["data:image/webp;base64,..."])

// Send a message to the current task.
await api.sendMessage("Can you fix the @problems?")

// Simulate pressing the primary button in the chat interface (e.g. 'Save' or 'Proceed While Running').
await api.pressPrimaryButton()

// Simulate pressing the secondary button in the chat interface (e.g. 'Reject').
await api.pressSecondaryButton()
```

**NOTE:** To ensure that the `ZooCodeOrganization.zoo-code` extension is activated before your extension, add it to the `extensionDependencies` in your `package.json`:

```json
"extensionDependencies": ["ZooCodeOrganization.zoo-code"]
```

For detailed information on the available methods and their usage, refer to the generated declarations in `dist/index.d.ts` or the source types in `packages/types/src/index.ts`.
