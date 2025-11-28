import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put, head } from "@vercel/blob";
import { CuaSandboxClient } from "../lib/cua-client.js";
import {
  executeTask,
  describeScreen,
  getSandboxHost,
  type TaskResult,
} from "../lib/agent.js";

// MCP Protocol Types
interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Tool definitions - 8 total (5 sandbox management + 3 agentic)
const TOOLS: Tool[] = [
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
  // Agentic Tools (3)
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
          description: "Maximum actions before giving up (default: 30)",
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
          description: "The history_url returned from run_task (preferred for faster lookup)",
        },
      },
      required: ["task_id"],
    },
  },
];

// Get API keys from environment or request headers
function getApiKey(req: VercelRequest): string {
  const headerKey = req.headers["x-cua-api-key"] as string;
  return headerKey || process.env.CUA_API_KEY || "";
}

function getAnthropicApiKey(): string {
  return process.env.ANTHROPIC_API_KEY || "";
}

// Tool execution handler
async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  cuaApiKey: string,
  anthropicApiKey: string
): Promise<unknown> {
  const sandboxClient = new CuaSandboxClient(cuaApiKey);

  switch (toolName) {
    // ==========================================
    // Sandbox Management
    // ==========================================
    case "list_sandboxes":
      return await sandboxClient.listSandboxes();

    case "get_sandbox":
      return await sandboxClient.getSandbox(args.name as string);

    case "start_sandbox":
      return await sandboxClient.startSandbox(args.name as string);

    case "stop_sandbox":
      return await sandboxClient.stopSandbox(args.name as string);

    case "restart_sandbox":
      return await sandboxClient.restartSandbox(args.name as string);

    // ==========================================
    // Agentic Tools
    // ==========================================
    case "describe_screen": {
      const sandboxName = args.sandbox_name as string;
      const focus = (args.focus as "ui" | "text" | "full") || "ui";
      const question = args.question as string | undefined;

      // Get sandbox host
      const host = await getSandboxHost(sandboxName, cuaApiKey);
      if (!host) {
        return {
          success: false,
          error: `Sandbox not found: ${sandboxName}`,
        };
      }

      if (!anthropicApiKey) {
        return {
          success: false,
          error: "ANTHROPIC_API_KEY not configured on server",
        };
      }

      const result = await describeScreen(
        sandboxName,
        host,
        cuaApiKey,
        anthropicApiKey,
        focus,
        question
      );

      return result;
    }

    case "run_task": {
      const sandboxName = args.sandbox_name as string;
      const task = args.task as string;
      const maxSteps = Math.min((args.max_steps as number) || 30, 50);
      const timeoutSeconds = Math.min(
        (args.timeout_seconds as number) || 280,
        280
      );

      // Get sandbox host
      const host = await getSandboxHost(sandboxName, cuaApiKey);
      if (!host) {
        return {
          success: false,
          error: `Sandbox not found: ${sandboxName}`,
          summary: "Failed to start task",
        };
      }

      if (!anthropicApiKey) {
        return {
          success: false,
          error: "ANTHROPIC_API_KEY not configured on server",
          summary: "Failed to start task",
        };
      }

      // Execute the task
      const result = await executeTask(
        sandboxName,
        host,
        cuaApiKey,
        anthropicApiKey,
        task,
        maxSteps,
        timeoutSeconds
      );

      // Store result in Vercel Blob for later retrieval
      let historyUrl: string | undefined;
      try {
        const blob = await put(`tasks/${result.task_id}.json`, JSON.stringify(result), {
          access: "public",
          addRandomSuffix: false,
        });
        historyUrl = blob.url;
      } catch (blobError) {
        // Blob storage failure is non-critical - task still completed
        console.error("Failed to store task result in Blob:", blobError);
      }

      // Return text-only summary (no images)
      return {
        task_id: result.task_id,
        success: result.success,
        summary: result.summary,
        steps_taken: result.steps_taken,
        duration_ms: result.duration_ms,
        error: result.error,
        history_url: historyUrl,
      };
    }

    case "get_task_history": {
      const taskId = args.task_id as string;
      const historyUrl = args.history_url as string | undefined;

      try {
        // If URL provided, fetch directly
        if (historyUrl) {
          const response = await fetch(historyUrl);
          if (!response.ok) {
            return { success: false, error: "Task not found at provided URL" };
          }
          return await response.json() as TaskResult;
        }

        // Try to find blob by checking head
        const blobInfo = await head(`tasks/${taskId}.json`);
        if (!blobInfo) {
          return { success: false, error: "Task not found" };
        }

        const response = await fetch(blobInfo.url);
        return await response.json() as TaskResult;
      } catch (blobError) {
        return {
          success: false,
          error: `Failed to retrieve task: ${blobError instanceof Error ? blobError.message : "Unknown error"}`,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// MCP Request Handler
async function handleMcpRequest(
  request: McpRequest,
  cuaApiKey: string,
  anthropicApiKey: string
): Promise<McpResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: {
              name: "cua-mcp-server",
              version: "2.0.0",
              description:
                "Agentic CUA MCP Server - Autonomous desktop automation with vision AI",
            },
            capabilities: {
              tools: {},
            },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: TOOLS,
          },
        };

      case "tools/call": {
        const toolName = params?.name as string;
        const toolArgs = (params?.arguments || {}) as Record<string, unknown>;

        if (!toolName) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Missing tool name",
            },
          };
        }

        const result = await executeTool(
          toolName,
          toolArgs,
          cuaApiKey,
          anthropicApiKey
        );

        // All results are returned as text (no images in agentic mode)
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      }

      case "ping":
        return {
          jsonrpc: "2.0",
          id,
          result: {},
        };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

// Vercel Handler
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // Only accept POST for MCP
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cuaApiKey = getApiKey(req);
  if (!cuaApiKey) {
    res.status(401).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message:
          "CUA API key required. Set CUA_API_KEY env var or pass X-CUA-API-Key header.",
      },
    });
    return;
  }

  const anthropicApiKey = getAnthropicApiKey();

  try {
    const mcpRequest = req.body as McpRequest;
    const response = await handleMcpRequest(
      mcpRequest,
      cuaApiKey,
      anthropicApiKey
    );
    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Internal server error",
      },
    });
  }
}
