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
│  CUA MCP Server (Agentic)                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Internal Agent Loop                                  │  │
│  │  1. screenshot() → CUA sandbox                        │  │
│  │  2. screenshot → Claude API (computer_use tool)       │  │
│  │  3. Claude returns: click(x,y) / type("text") / done  │  │
│  │  4. Execute action on sandbox                         │  │
│  │  5. Loop until complete                               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
{ success: true, summary: "Opened Chrome...", steps_taken: 5 }
(TEXT ONLY - no images)
```

### Key Files

- `api/mcp.ts` - MCP handler with 10 tools (7 sandbox management + 3 agentic)
- `lib/agent.ts` - Agent loop with Anthropic computer_use tool
- `lib/cua-client.ts` - CUA Cloud API clients for sandbox and computer control

### API Key Handling

Two API keys required:
1. `CUA_API_KEY` - For sandbox management and computer control
2. `ANTHROPIC_API_KEY` - For vision processing in agent loop

CUA key resolution order:
1. `X-CUA-API-Key` request header
2. `CUA_API_KEY` environment variable

## Tool Categories (10 total)

**Sandbox Management (7):**
- `list_sandboxes` - List all sandboxes
- `get_sandbox` - Get sandbox details
- `create_sandbox` - Create new VM (linux/windows/macos)
- `start_sandbox` - Start stopped sandbox
- `stop_sandbox` - Stop running sandbox
- `restart_sandbox` - Restart sandbox
- `delete_sandbox` - Delete sandbox

**Agentic Tools (3):**
- `describe_screen` - Vision-based screen description (no actions)
- `run_task` - Autonomous task execution with agent loop
- `get_task_history` - Retrieve past task results from Vercel Blob

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CUA_API_KEY` | Yes | CUA Cloud API key |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for vision |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob token (auto-added) |
| `CUA_API_BASE` | No | Custom API base URL |
| `CUA_MODEL` | No | Model to use: `claude-sonnet-4-5` (default) or `claude-opus-4-5` |

## Model Support

| Model | Tool Version | Beta Flag | Zoom Support |
|-------|--------------|-----------|--------------|
| Claude Sonnet 4.5 (default) | `computer_20250124` | `computer-use-2025-01-24` | No |
| Claude Opus 4.5 | `computer_20251124` | `computer-use-2025-11-24` | Yes |

Set `CUA_MODEL=claude-opus-4-5` for Opus 4.5 with enhanced zoom capabilities.

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
- `triple_click` - Triple click (select line/paragraph)
- `middle_click` - Middle mouse button click
- `left_click_drag` - Click and drag from start to end coordinates
- `left_mouse_down` - Press and hold left button
- `left_mouse_up` - Release left button
- `scroll` - Scroll in direction (up/down/left/right)
- `hold_key` - Hold a modifier key down
- `release_key` - Release a held key
- `wait` - Pause execution

**Opus 4.5 Only:**
- `zoom` - View specific screen regions at full resolution (400x300 crop around coordinate)

**Shell Commands:**
- `run_command` - Execute shell command (use `command` field)

**File Operations:**
- `read_file` - Read file contents (use `path` field)
- `write_file` - Write file contents (use `path` and `content` fields)
- `list_directory` - List directory contents (use `path` field)
- `file_exists` - Check if file exists (use `path` field)
- `create_directory` - Create directory (use `path` field)
- `delete_file` - Delete file (use `path` field)

**Clipboard Operations:**
- `get_clipboard` - Get clipboard contents
- `set_clipboard` - Set clipboard contents (use `text` field)

**Accessibility:**
- `get_accessibility_tree` - Get UI accessibility tree
- `find_element` - Find UI element by role/title (use `text` for role, `content` for title)

## Constraints

- Function timeout: 300 seconds (Vercel Pro)
- Max steps per task: 50
- Task history TTL: 24 hours
- Display resolution: Dynamic (fetched from sandbox, default 1024x768)
