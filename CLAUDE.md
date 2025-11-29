# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CUA MCP Server is an **agentic** Model Context Protocol (MCP) server that bridges Claude Code with CUA Cloud virtual machine sandboxes. It enables AI agents to delegate desktop automation tasks to an internal vision-based agent loop - images never leave the server, only text summaries are returned.

**Production URL:** `https://cua-mcp-server.vercel.app/mcp`

## Development Commands

```bash
npm install           # Install dependencies
npm run dev           # Start local Vercel dev server
vercel --prod         # Deploy to production
```

No explicit build step needed - Vercel compiles TypeScript on deploy.

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

### API Key Handling

Two API keys required:
1. `CUA_API_KEY` - For sandbox management and computer control
2. `ANTHROPIC_API_KEY` - For vision processing in agent loop

CUA key resolution order:
1. `X-CUA-API-Key` request header
2. `CUA_API_KEY` environment variable

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

## Progress Tracking

During long-running tasks, the main agent can poll for progress using `get_task_progress`:

```
run_task returns: { task_id, progress_url, ... }
       ↓
Poll every 5-10 seconds: get_task_progress({ task_id, progress_url })
       ↓
Response (running):
{
  "task_id": "task_123",
  "status": "running",
  "progress": {
    "current_step": 5,
    "max_steps": 100,
    "elapsed_ms": 45000,
    "last_action": "left_click",
    "last_reasoning": "I see a Submit button...",
    "steps_summary": ["Click", "Type text", "Click"]
  }
}
       ↓
Response (completed):
{
  "task_id": "task_123",
  "status": "completed",
  "result": { "success": true, "summary": "...", "total_steps": 12 }
}
```

Progress is stored in Vercel Blob at `progress/{task_id}.json` and updated after each action.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CUA_API_KEY` | Yes | CUA Cloud API key |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for vision |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob token (auto-added) |
| `CUA_API_BASE` | No | Custom API base URL |
| `CUA_MODEL` | No | Model to use: `claude-opus-4-5` (default) or `claude-sonnet-4-5` |

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
- `type` - Type text
- `key` - Press key or key combination
- `mouse_move` - Move cursor

**Enhanced Actions:**
- `middle_click` - Middle mouse button click
- `left_click_drag` - Click and drag from start to end coordinates
- `left_mouse_down` - Press and hold left button
- `left_mouse_up` - Release left button
- `scroll` - Scroll in direction (up/down/left/right)
- `hold_key` - Hold a modifier key down
- `release_key` - Release a held key
- `wait` - Pause execution

**Opus 4.5 Only:**
- `zoom` - View specific screen regions at full resolution (400x300 crop around coordinate, defaults to screen center if no coordinate provided)

## Constraints

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
