/**
 * MCP Tool Schemas
 *
 * Tool definitions for the CUA MCP server.
 * 9 tools total: 5 sandbox management + 4 agentic
 */

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOLS: Tool[] = [
  // ==========================================
  // Sandbox Management Tools (5)
  // Note: Create/delete must be done via CUA Dashboard
  // ==========================================
  {
    name: "list_sandboxes",
    description: "List all CUA cloud sandboxes with their current status",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_sandbox",
    description: "Get details of a specific sandbox including API URLs",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The sandbox name",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "start_sandbox",
    description: "Start a stopped sandbox",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The sandbox name to start",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "stop_sandbox",
    description: "Stop a running sandbox",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The sandbox name to stop",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "restart_sandbox",
    description: "Restart a sandbox",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The sandbox name to restart",
        },
      },
      required: ["name"],
    },
  },

  // ==========================================
  // Agentic Tools (4)
  // ==========================================
  {
    name: "describe_screen",
    description:
      "Get a text description of current screen state using vision AI. No actions taken. Use for situational awareness without running a full task. Images are processed server-side and never returned.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: {
          type: "string",
          description: "The sandbox name",
        },
        focus: {
          type: "string",
          enum: ["ui", "text", "full"],
          description:
            "Focus area: 'ui' for clickable elements, 'text' for readable content, 'full' for comprehensive",
        },
        question: {
          type: "string",
          description:
            "Optional specific question about the screen (e.g., 'Is there a login button?')",
        },
      },
      required: ["sandbox_name"],
    },
  },
  {
    name: "run_task",
    description:
      "Execute a computer task autonomously. The MCP server will control the sandbox, take screenshots, and complete the task using vision AI. Only the result summary is returned - no images. Use this for any desktop automation task.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_name: {
          type: "string",
          description: "The sandbox name to use",
        },
        task: {
          type: "string",
          description:
            "Natural language description of what to accomplish (e.g., 'Open Chrome and navigate to google.com')",
        },
        max_steps: {
          type: "number",
          description: "Maximum actions before giving up (default: 100)",
        },
        timeout_seconds: {
          type: "number",
          description: "Maximum time in seconds (default: 280, max: 280)",
        },
      },
      required: ["sandbox_name", "task"],
    },
  },
  {
    name: "get_task_history",
    description:
      "Retrieve the result of a previously executed task. Use the history_url from run_task response for fastest lookup.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID returned from run_task",
        },
        history_url: {
          type: "string",
          description:
            "The history_url returned from run_task (preferred for faster lookup)",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "get_task_progress",
    description:
      "Check the progress of a running task. Returns current step, last action, and status. For completed tasks, includes the final result. Poll this every 5-10 seconds during long-running tasks.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID returned from run_task",
        },
        progress_url: {
          type: "string",
          description:
            "The progress_url returned from run_task (preferred for faster lookup)",
        },
      },
      required: ["task_id"],
    },
  },
];
