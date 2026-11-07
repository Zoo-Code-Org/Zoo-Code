# IPC (Inter-Process Communication)

This package provides IPC functionality for Roo Code, allowing external applications to communicate with the extension through a socket-based interface.

## Available Commands

The IPC interface supports the following task commands:

### StartNewTask

Starts a new task with optional configuration and initial message.

**Parameters:**

- `configuration`: RooCode settings object
- `text`: Initial task message (string)
- `images`: Array of image data URIs (optional)
- `newTab`: Whether to open in a new tab (boolean, optional)

### CancelTask

Cancels a running task.

**Parameters:**

- `data`: Task ID to cancel (string)

### CloseTask

Closes a task and performs cleanup.

**Parameters:**

- `data`: Task ID to close (string)

### ResumeTask

Resumes a task from history.

**Parameters:**

- `data`: Task ID to resume (string)

**Error Handling:**

- If the task ID is not found in history, the command will fail gracefully without crashing the IPC server
- Errors are logged for debugging purposes but do not propagate to the client

## Usage Example

The package exports only the server half. A client connects to the socket
`IpcServer` listens on and speaks the same `node-ipc` framing: a js-message
envelope (`{"type":"message","data":…}`) terminated by a form feed. The
extension exposes the server through `src/extension/api.ts` when
`ROO_CODE_IPC_SOCKET_PATH` is set; `scripts/agent-evals/ipc-client.ts` is the
in-repo reference client.

```typescript
import { IpcMessageType, IpcOrigin, TaskCommandName } from "@roo-code/types"

socket.write(
	JSON.stringify({
		type: "message",
		data: {
			type: IpcMessageType.TaskCommand,
			origin: IpcOrigin.Client,
			clientId,
			data: { commandName: TaskCommandName.ResumeTask, data: "task-123" },
		},
	}) + "\f",
)
```

## Events

The IPC interface also emits task events that clients can listen to:

- `TaskStarted`: When a task begins
- `TaskCompleted`: When a task finishes
- `TaskAborted`: When a task is cancelled
- `Message`: When a task sends a message

## Socket Path

The socket path is typically located in the system's temporary directory and follows the pattern:

- Unix/Linux/macOS: `/tmp/roo-code-{id}.sock`
- Windows: `\\.\pipe\roo-code-{id}`
