# CUA MCP Server

An **agentic** Model Context Protocol (MCP) server for [CUA Cloud](https://cua.ai) - delegate desktop automation tasks to an autonomous vision-based agent. Images never leave the server; only text summaries are returned.

**Production URL:** `https://cua-mcp-server.vercel.app/mcp`

## What is CUA?

[CUA (Computer Use Agent)](https://cua.ai) provides cloud-based virtual machine sandboxes that AI agents can control. This MCP server exposes CUA's capabilities through a clean task-delegation API:

- **Create and manage VMs** (Linux, Windows, macOS)
- **Delegate tasks** - "Open Chrome and navigate to google.com"
- **Get text summaries** - No images in your context window
- **Query screen state** - Vision-based descriptions without taking action

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

## Project Structure

```
api/mcp.ts                     # MCP protocol handler
lib/
├── agent/                     # Modular agent architecture
│   ├── index.ts               # Public exports
│   ├── types.ts               # Type definitions
│   ├── config.ts              # Model configurations
│   ├── validation.ts          # Coordinate validation helpers
│   ├── execute.ts             # Main agent loop
│   ├── describe.ts            # Screen description
│   ├── progress.ts            # Progress tracking
│   ├── utils.ts               # Utilities (sleep, generateTaskId)
│   └── actions/               # Action handler registry (16 handlers)
├── cua-client.ts              # CUA Cloud API client
└── tool-schemas.ts            # MCP tool definitions
```

## Available Tools (9 total)

### Sandbox Management (5 tools)

| Tool | Description |
|------|-------------|
| `list_sandboxes` | List all CUA cloud sandboxes with their current status |
| `get_sandbox` | Get details of a specific sandbox including API URLs |
| `start_sandbox` | Start a stopped sandbox |
| `stop_sandbox` | Stop a running sandbox |
| `restart_sandbox` | Restart a sandbox |

> **Note:** Create and delete sandboxes via the [CUA Dashboard](https://cloud.trycua.com) - the Cloud API doesn't expose these operations.

### Agentic Tools (4 tools)

| Tool | Description |
|------|-------------|
| `describe_screen` | Get a text description of current screen state using vision AI. No actions taken. |
| `run_task` | Execute a computer task autonomously. Returns immediately with task_id for polling. |
| `get_task_progress` | Poll progress of running tasks. Returns current step, last action, and reasoning. |
| `get_task_history` | Retrieve results of a previously executed task by ID. |

## Quick Start

### 1. Get a CUA API Key

1. Go to [cua.ai/signin](https://cua.ai/signin)
2. Navigate to **Dashboard > API Keys > New API Key**
3. Copy your API key (starts with `sk_cua-api01_...`)

### 2. Configure Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "cua": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://cua-mcp-server.vercel.app/mcp"]
    }
  }
}
```

### 3. Use with Claude Code

```
You: "List my CUA sandboxes"
Claude: [Uses list_sandboxes tool]

You: "Start my-sandbox"
Claude: [Uses start_sandbox tool]

You: "Open Firefox and go to google.com on my-sandbox"
Claude: [Uses run_task with task="Open Firefox and navigate to google.com"]
→ Returns: { success: true, summary: "Opened Firefox, navigated to google.com", steps_taken: 4 }

You: "What's currently on the screen?"
Claude: [Uses describe_screen tool]
→ Returns: { description: "Firefox browser showing Google homepage with search box..." }
```

## Usage Examples

### Automate a Web Task

```
You: "On my-sandbox, open Chrome, go to github.com, and search for 'mcp server'"

Claude uses run_task:
- task: "Open Chrome browser, navigate to github.com, find the search box, type 'mcp server' and press Enter"
- Returns summary of what happened (no screenshots in your context)
```

### Check Screen State

```
You: "What's on the screen right now?"

Claude uses describe_screen:
- focus: "ui" (or "text" or "full")
- Returns text description of UI elements, buttons, text content
```

### Ask Specific Questions

```
You: "Is there a login button visible?"

Claude uses describe_screen:
- question: "Is there a login button visible?"
- Returns: "Yes, there is a blue 'Sign In' button in the top right corner..."
```

## Self-Hosting

### Prerequisites

- Vercel account with Pro plan (for 800s function timeout)
- Vercel Blob storage
- Anthropic API key

### Deploy Your Own Instance

```bash
# Clone the repository
git clone https://github.com/anthropics/cua-mcp-server.git
cd cua-mcp-server

# Install dependencies
npm install

# Deploy to Vercel
vercel --prod
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `CUA_API_KEY` | Your CUA Cloud API key | Yes |
| `ANTHROPIC_API_KEY` | Anthropic API key for vision processing | Yes |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token (auto-added) | Yes |
| `CUA_API_BASE` | Custom API base URL (default: https://api.cua.ai) | No |
| `CUA_MODEL` | Model to use: `claude-opus-4-5` (default) or `claude-sonnet-4-5` | No |

### Setting Up Vercel Blob

1. Go to your Vercel project dashboard
2. Navigate to **Storage** → **Create** → **Blob**
3. The `BLOB_READ_WRITE_TOKEN` will be automatically added

### Pass API Key Per-Request

If you don't want to store the CUA API key on the server:

```json
{
  "mcpServers": {
    "cua": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-deployment.vercel.app/mcp",
        "--header", "X-CUA-API-Key: sk_cua-api01_your-key-here"
      ]
    }
  }
}
```

## API Reference

### MCP Endpoint

**URL:** `POST /mcp`

**Content-Type:** `application/json`

### Example: Run Task

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "id": 1,
  "params": {
    "name": "run_task",
    "arguments": {
      "sandbox_name": "s-linux-abc123",
      "task": "Open Firefox and navigate to google.com",
      "max_steps": 30,
      "timeout_seconds": 120
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"task_id\":\"task_123...\",\"success\":true,\"summary\":\"Opened Firefox, navigated to google.com\",\"steps_taken\":4,\"duration_ms\":8500}"
    }]
  }
}
```

### Example: Describe Screen

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "id": 2,
  "params": {
    "name": "describe_screen",
    "arguments": {
      "sandbox_name": "s-linux-abc123",
      "focus": "ui",
      "question": "Is there a search box visible?"
    }
  }
}
```

## Model Support

| Model | Env Variable | Tool Version | Features |
|-------|--------------|--------------|----------|
| Claude Opus 4.5 (default) | `CUA_MODEL=claude-opus-4-5` | `computer_20251124` | Zoom support, higher accuracy |
| Claude Sonnet 4.5 | `CUA_MODEL=claude-sonnet-4-5` | `computer_20250124` | Faster, lower cost |

## Supported Computer Actions

The agent can perform the following actions autonomously:

**UI Actions:**
- `screenshot` - Capture current screen
- `left_click`, `right_click`, `double_click`, `triple_click`, `middle_click` - Mouse clicks at coordinates
- `mouse_move` - Move cursor to coordinates
- `left_click_drag` - Click and drag from start to end coordinates
- `left_mouse_down`, `left_mouse_up` - Press/release mouse button
- `scroll` - Scroll up/down/left/right
- `wait` - Pause execution
- `zoom` - View specific screen region at full resolution (Opus 4.5 only, defaults to center if no coordinate)

**Keyboard:**
- `type` - Type text
- `key` - Press key or key combination (e.g., "ctrl+c")
- `hold_key` - Hold a modifier key down (auto-releases after next action)

## Constraints

| Constraint | Value |
|------------|-------|
| Function timeout | 800 seconds (Vercel Pro) |
| Max steps per task | 100 |
| Default steps | 100 |
| Default timeout | 750 seconds |
| Task history TTL | 24 hours |
| Display resolution | Dynamic (default 1024x768) |

## Sandbox Types

| OS | Size | CPU | RAM | Use Case |
|----|------|-----|-----|----------|
| Linux | small | 2 | 4GB | Development, testing |
| Linux | medium | 4 | 8GB | Build tasks, CI/CD |
| Linux | large | 8 | 16GB | Heavy workloads |
| Windows | small | 2 | 4GB | Basic Windows apps |
| Windows | medium | 4 | 8GB | Office, development |
| Windows | large | 8 | 16GB | Enterprise apps |
| macOS | small | 2 | 4GB | iOS development |
| macOS | medium | 4 | 8GB | Xcode builds |
| macOS | large | 8 | 16GB | Heavy compilation |

## Regions

- `north-america` - US East (lowest latency for US users)
- `europe` - EU West
- `asia` - Asia Pacific

## Troubleshooting

### "CUA API key required"

Set `CUA_API_KEY` environment variable in Vercel or pass via `X-CUA-API-Key` header.

### "ANTHROPIC_API_KEY not configured"

The server needs an Anthropic API key for vision processing. Add it to your Vercel environment variables.

### Task times out

- Default timeout is 750 seconds
- Reduce task complexity or break into smaller steps
- Check if sandbox is responsive with `describe_screen`

### Task exceeds max steps

- Default is 100 steps (max 100)
- Break complex tasks into smaller subtasks
- Use more specific task descriptions

## Resources

- [CUA Documentation](https://cua.ai/docs)
- [CUA Cloud Dashboard](https://cua.ai/dashboard)
- [Anthropic Computer Use](https://docs.anthropic.com/en/docs/agents-and-tools/computer-use)
- [MCP Protocol Specification](https://modelcontextprotocol.io)

## License

MIT
