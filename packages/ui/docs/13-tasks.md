# Tasks

Tasks represent units of work that can be assigned to humans or agents within a workspace. They're persisted in shared storage (PostgreSQL) and visible to all workspace members.

## Task type

```typescript
interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: string; // Open-ended: "todo", "in_progress", "done", etc.
  assigneeId: string | null; // User ID or agent ID
  createdBy: string;
  dueAt: number | null; // Unix timestamp
  result?: string | null; // Outcome/completion notes
  createdAt: number;
  updatedAt: number;
}
```

## CRUD operations

### Creating tasks

```typescript
const task = await coreClient.createTask(workspaceId, "Review PR #42", {
  description: "Check for security issues in the auth module",
  assigneeId: "agent_claude_123",
  dueAt: Date.now() + 86400000, // due tomorrow
});
```

### Updating tasks

```typescript
const updated = await coreClient.updateTask(workspaceId, taskId, {
  status: "in_progress",
  assigneeId: "user_alice",
});
```

Updatable fields: `status`, `title`, `description`, `assigneeId`, `result`.

### Fetching tasks

```typescript
// All tasks in a workspace
const all = await coreClient.fetchTasks(workspaceId);

// Filtered by status
const open = await coreClient.fetchTasks(workspaceId, { status: "todo" });

// Filtered by assignee
const mine = await coreClient.fetchTasks(workspaceId, { assigneeId: userId });
```

## State

Tasks are part of `workspaceState`:

```typescript
workspaceState.tasks; // Task[]
```

They're fetched alongside channels when a workspace is selected (`selectWorkspace()`).

## Routes

| Route                            | View                   |
| -------------------------------- | ---------------------- |
| `/workspace/[id]/tasks`          | Task board (list view) |
| `/workspace/[id]/tasks/[taskId]` | Task detail            |

## Agent interaction

Agents can create and update tasks via MCP tools injected by the daemon. When an agent completes a task, it typically:

1. Updates the task status to `"done"`
2. Sets the `result` field with a summary
3. Posts a message in the workspace channel

The UI reflects these changes in real-time through the WebSocket event system.

## Next steps

- [Agents](./12-agents.md) — How agents interact with tasks
- [State management](./07-state-management.md) — How task state is managed reactively
