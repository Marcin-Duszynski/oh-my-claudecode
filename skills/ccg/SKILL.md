---
name: ccg
description: Claude-Codex-Gemini tri-model orchestration - fans out backend tasks to Codex and frontend/UI tasks to Gemini in parallel, then Claude synthesizes results
---

# CCG - Claude-Codex-Gemini Tri-Model Orchestration

CCG spawns a tmux team with Codex and Gemini CLI workers running in parallel panes, then Claude synthesizes the results. Use this for tasks that benefit from multiple AI perspectives simultaneously.

## When to Use

- Backend/analysis + frontend/UI work that can run truly in parallel
- Code review from multiple perspectives (architecture + style simultaneously)
- Research tasks where different models have complementary strengths
- Any task you want to split across Codex (analytical) and Gemini (design/creative) workers

## Requirements

- **Codex CLI**: `npm install -g @openai/codex` (or `@openai/codex`)
- **Gemini CLI**: `npm install -g @google/gemini-cli`
- **tmux**: Must be running inside a tmux session
- If either CLI is unavailable, CCG falls back to Claude-only execution

## How It Works

```
1. Claude decomposes the request into:
   - Backend/analytical tasks → Codex worker
   - Frontend/UI/design tasks → Gemini worker

2. `omc team start` creates a tmux session with 2 workers:
   omc-team-{name}
   ├── Leader pane (Claude orchestrates)
   ├── Worker pane 1: codex CLI (analytical tasks)
   └── Worker pane 2: gemini CLI (design tasks)

3. Workers read tasks from inbox files and write done.json on completion

4. `omc team wait` blocks until all workers finish

5. Claude reads taskResults and synthesizes into final output
```

## Execution Protocol

When invoked, Claude MUST follow this workflow:

### 1. Decompose Request
Split the user's request into:
- **Codex tasks**: code analysis, architecture review, backend logic, security review, test strategy
- **Gemini tasks**: UI/UX design, documentation, visual analysis, large-context file review
- **Synthesis task**: Claude combines results (always done by Claude, not delegated)

Choose a short `teamName` slug (e.g., `ccg-auth-review`).

### 2. Start the team (non-blocking)

Run `omc team start` — spawns workers in the background and returns a `jobId` immediately:

```
omc team start --name "ccg-{slug}" --agent codex --count 1 --cwd "{cwd}" --task "Codex task: ..."
omc team start --name "ccg-{slug}" --agent gemini --count 1 --cwd "{cwd}" --task "Gemini task: ..."
```

Returns: `{ "jobId": "omc-...", "pid": 12345, "message": "Team started in background..." }`

### 3. Wait for completion

Run `omc team wait <job_id>` — blocks internally until done:

```
omc team wait "{jobId}"
```

> **Timeout guidance:** `timeout_ms` is optional; the default wait timeout is fine.
> If wait times out, workers/panes keep running. Call `omc team wait <job_id>` again to keep
> waiting. Use `omc team cleanup <job_id>` only for explicit cancel intent.

Returns when done:
```json
{
  "status": "completed|failed",
  "result": {
    "taskResults": [
      {"taskId": "1", "status": "completed", "summary": "..."},
      {"taskId": "2", "status": "completed", "summary": "..."}
    ]
  }
}
```

### 4. Synthesize Results

Parse `result.taskResults` and synthesize Codex + Gemini outputs into a unified response for the user.

## Fallback (CLIs Not Available)

CLI availability is checked by the MCP runtime automatically. If a CLI is not installed, the worker exits with `command not found`. In that case, fall back to Claude Task agents:

```
[CCG] Codex/Gemini CLI not found. Falling back to Claude-only execution.
```

Use standard Claude Task agents instead:
- `Task(subagent_type="oh-my-claudecode:executor", model="sonnet", ...)` for analytical tasks
- `Task(subagent_type="oh-my-claudecode:designer", model="sonnet", ...)` for design tasks

## Invocation

```
/oh-my-claudecode:ccg [task description]
```

Example:
```
/oh-my-claudecode:ccg Review this PR - check architecture and code quality (Codex) and UI components (Gemini)
```
