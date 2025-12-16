# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CUA MCP Server is an **agentic** Model Context Protocol (MCP) server that bridges Claude Code with CUA Cloud virtual machine sandboxes. It enables AI agents to delegate desktop automation tasks to an internal vision-based agent loop - images never leave the server, only text summaries are returned.

**Production URL:** `https://cua-mcp-server.vercel.app/mcp`

## Development Commands

```bash
npm install           # Install dependencies
npm run dev           # Start local Vercel dev server (http://localhost:3000)
vercel --prod         # Deploy to production
```

No explicit build step needed - Vercel compiles TypeScript on deploy.

## Local Development

### Prerequisites
- Node.js 18+
- Vercel CLI (`npm i -g vercel`)
- CUA Cloud account with API key
- Anthropic API key

### Environment Setup
Create `.env.local`:
```bash
CUA_API_KEY=your_cua_key
ANTHROPIC_API_KEY=your_anthropic_key
# BLOB_READ_WRITE_TOKEN is auto-provided by Vercel
```

### Testing Locally
```bash
npm run dev
# In another terminal, test with:
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"method":"tools/list"}'
```

### Testing with Claude Code
Add to `.mcp.json`:
```json
{
  "mcpServers": {
    "cua-local": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp"]
    }
  }
}
```

## Architecture

```
Claude Code (Orchestrator)
    │
    │ run_task("Open Chrome and go to google.com")
    ▼
┌─────────────────────────────────────────────────────────────┐
│  CUA MCP Server (Non-Blocking)                              │
│                                                             │
│  1. Returns immediately: { task_id, status: "running" }     │
│  2. Task executes in background via waitUntil               │
│  3. Progress updates stored in Vercel Blob                  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Background Agent Loop                                │  │
│  │  1. screenshot() → CUA sandbox                        │  │
│  │  2. screenshot → Claude API (computer_use tool)       │  │
│  │  3. Claude returns: click(x,y) / type("text") / done  │  │
│  │  4. Execute action, update progress                   │  │
│  │  5. Loop until complete                               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
Poll get_task_progress → { status, current_step, last_action }
    │
    ▼
When complete → { status: "completed", result: { ... } }
```

### Key Files

```
api/mcp.ts                     # MCP handler with 9 tools (5 sandbox + 4 agentic)
lib/
├── agent/                     # Modular agent architecture
│   ├── index.ts               # Public exports
│   ├── types.ts               # Type definitions (AgentStep, TaskResult, etc.)
│   ├── config.ts              # Constants and model configurations
│   ├── validation.ts          # Coordinate validation helpers
│   ├── progress.ts            # Progress tracking and Blob storage
│   ├── execute.ts             # Main agent execution loop
│   ├── describe.ts            # Screen description functionality
│   ├── utils.ts               # Utilities (sleep, generateTaskId, etc.)
│   └── actions/               # Action handler registry
│       ├── index.ts           # Registry exports and OBSERVATION_ACTIONS set
│       ├── types.ts           # ActionHandler type, ActionContext
│       └── handlers.ts        # 16 action handlers (click, type, scroll, etc.)
├── cua-client.ts              # CUA Cloud API clients (sandbox + computer control)
└── tool-schemas.ts            # MCP tool definitions (extracted from mcp.ts)
```

## Tool Categories (9 total)

**Sandbox Management (5):**
- `list_sandboxes` - List all sandboxes
- `get_sandbox` - Get sandbox details
- `start_sandbox` - Start stopped sandbox
- `stop_sandbox` - Stop running sandbox
- `restart_sandbox` - Restart sandbox

> Note: Create/delete sandboxes via [CUA Dashboard](https://cloud.trycua.com)

**Agentic Tools (4):**
- `describe_screen` - Vision-based screen description (no actions)
- `run_task` - Autonomous task execution with agent loop
- `get_task_progress` - Poll progress of running tasks (step count, last action, reasoning)
- `get_task_history` - Retrieve past task results from Vercel Blob

## Debugging & Troubleshooting

### Common Issues

**"Sandbox not found" / 404 errors:**
- Verify sandbox name matches exactly (case-sensitive)
- Check sandbox status - may be stopped/paused
- Ensure CUA_API_KEY has access to the sandbox

**Task never completes:**
- Check Vercel function logs: `vercel logs --follow`
- Task may have hit timeout (750s max)
- Agent may be stuck in a loop - check progress for repeated actions

**Stale progress data:**
Vercel Blob uses CDN caching. Always use cache-busting:
```typescript
const cacheBuster = `?t=${Date.now()}`;
const response = await fetch(progressUrl + cacheBuster, { cache: 'no-store' });
```

**Local dev: Blob storage errors:**
Vercel Blob requires `BLOB_READ_WRITE_TOKEN`. For local development:
1. Link project: `vercel link`
2. Pull env vars: `vercel env pull .env.local`

### Viewing Logs

```bash
# Production logs
vercel logs --follow

# Filter by function
vercel logs --filter="api/mcp"
```

### Agent Loop Debugging

The agent loop in `lib/agent/execute.ts` has detailed console logging:
- `[Agent] Step X:` shows current iteration
- `[Agent] Action:` shows the action Claude requested
- `[Agent] Error:` shows any failures

## Testing

**Current state:** No automated tests exist.

**Manual testing workflow:**
1. Start local dev server
2. Use `curl` or MCP inspector to call tools
3. Monitor Vercel logs for errors
4. Check Vercel Blob storage for progress/history data

**Testing tips:**
- Use `describe_screen` first to verify sandbox connectivity
- Start with simple tasks before complex multi-step ones
- Monitor `get_task_progress` during long tasks

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CUA_API_KEY` | Yes | CUA Cloud API key |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for vision |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob token (auto-added) |
| `CUA_API_BASE` | No | Custom API base URL |
| `CUA_MODEL` | No | Model to use: `claude-opus-4-5` (default) or `claude-sonnet-4-5` |

### API Key Handling

Two API keys required:
1. `CUA_API_KEY` - For sandbox management and computer control
2. `ANTHROPIC_API_KEY` - For vision processing in agent loop

CUA key resolution order:
1. `X-CUA-API-Key` request header
2. `CUA_API_KEY` environment variable

## Model Support

| Model | Tool Version | Beta Flag | Zoom Support |
|-------|--------------|-----------|--------------|
| Claude Opus 4.5 (default) | `computer_20251124` | `computer-use-2025-11-24` | Yes |
| Claude Sonnet 4.5 | `computer_20250124` | `computer-use-2025-01-24` | No |

Set `CUA_MODEL=claude-sonnet-4-5` for Sonnet 4.5 (faster, lower cost).

## Supported Computer Actions

**Basic Actions:**
- `screenshot` - Capture current screen
- `left_click` - Click at coordinates
- `right_click` - Right click at coordinates
- `double_click` - Double click at coordinates
- `triple_click` - Triple click at coordinates (selects paragraph/line)
- `type` - Type text
- `key` - Press key or key combination
- `mouse_move` - Move cursor

**Enhanced Actions:**
- `middle_click` - Middle mouse button click (uses mouse_down/mouse_up with button: "middle")
- `left_click_drag` - Click and drag from start to end coordinates
- `left_mouse_down` - Press and hold left button
- `left_mouse_up` - Release left button
- `scroll` - Scroll in direction (up/down/left/right)
- `hold_key` - Hold a modifier key down (auto-releases after next action)
- `wait` - Pause execution

**Opus 4.5 Only:**
- `zoom` - View specific screen regions at full resolution (400x300 crop around coordinate, defaults to screen center if no coordinate provided)

## Constraints & Limits

| Parameter | Default | Hard Max | Notes |
|-----------|---------|----------|-------|
| `timeout_seconds` | 750 | 750 | 50s buffer before Vercel's 800s limit |
| `max_steps` | 100 | 100 | Meaningful actions only (screenshots don't count) |

- Client-provided values are silently clamped to hard limits (no errors)
- Task history TTL: 24 hours
- Display resolution: Dynamic (fetched from sandbox, default 1024x768)

## Agent Step Counting Design

The `max_steps` parameter counts only **meaningful actions** (clicks, types, keys, scrolls, etc.).

**Observation actions don't count toward the limit:**
- `screenshot` - Visual verification after actions
- `zoom` - Viewing specific screen regions

This design allows the agent to verify its actions without wasting the step budget. For example, with `max_steps=15`:
- Agent can perform 15 clicks/types/etc.
- Each action can be followed by a verification screenshot
- Total iterations may be ~30-45, but only 15 count toward the limit

**Safety limit:** Total iterations are capped at `3 × max_steps` to prevent infinite loops if the agent only takes observation actions.

## Modifier Key Handling

The `hold_key` action enables modifier+click combinations (e.g., Shift+click for extended context menus).

**Auto-release behavior:** Held keys are automatically released after the next meaningful action. This works around Anthropic's computer use tool schema not exposing a separate `release_key` action.

Example sequence:
1. `hold_key("shift")` - Shift key is held
2. `right_click(x, y)` - Right-click with Shift held
3. Shift is auto-released after the click

Actions that trigger auto-release: clicks, typing, key presses, scrolling, dragging.
Actions that don't trigger release: screenshot, zoom, wait, hold_key itself.

## Known Limitations

1. **No create/delete sandbox via MCP** - Use CUA Dashboard instead
2. **750s timeout** - Vercel serverless limit; very long tasks may need to be split
3. **No persistent state** - Each task starts fresh; no memory between tasks
4. **Vision-only** - Cannot access DOM, page source, or network requests
5. **Single sandbox per task** - Cannot orchestrate multiple sandboxes in one task
6. **No streaming** - Results returned only after task completes (use progress polling)

## Security Considerations

**API Key Sharing:** When deployed, authenticated callers (those with valid CUA_API_KEY) also consume the server's ANTHROPIC_API_KEY quota. The server does not implement per-request billing or key scoping. For production deployments with untrusted users, consider:
- Deploying behind an API gateway with rate limiting
- Requiring users to provide their own Anthropic API key
- Restricting CORS to specific origins

**CORS Policy:** The server uses `Access-Control-Allow-Origin: *` for MCP compatibility. This is intentional for broad client support but may need restriction in production environments with security requirements.

**Context Management:** Message history is trimmed to the last 20 exchanges to prevent context exhaustion from accumulated screenshots. Very long tasks (50+ meaningful steps with verification screenshots) may still approach context limits.
