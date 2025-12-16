import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { put, head } from "@vercel/blob";
import { CuaSandboxClient } from "../lib/cua-client.js";
import {
  executeTask,
  executeTaskInBackground,
  describeScreen,
  getSandboxHost,
  generateTaskId,
  initializeProgress,
  DEFAULT_MAX_STEPS,
  MAX_STEPS_LIMIT,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  SANDBOX_NAME_MAX_LENGTH,
  TASK_ID_MAX_LENGTH,
  type TaskResult,
  type TaskProgress,
} from "../lib/agent/index.js";
import { TOOLS } from "../lib/tool-schemas.js";

// URL validation for SSRF protection
// Vercel Blob URLs use subdomains like: https://<id>.public.blob.vercel-storage.com/
const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

function isValidBlobUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return (
      urlObj.protocol === "https:" &&
      (urlObj.hostname.endsWith(BLOB_HOST_SUFFIX) ||
        urlObj.hostname === "public.blob.vercel-storage.com")
    );
  } catch {
    return false;
  }
}

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

// Validate sandbox name to prevent injection attacks
function isValidSandboxName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= SANDBOX_NAME_MAX_LENGTH &&
    /^[a-zA-Z0-9_-]+$/.test(name)
  );
}

// Validate task ID to prevent path traversal and injection
function isValidTaskId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= TASK_ID_MAX_LENGTH &&
    /^[a-zA-Z0-9_-]+$/.test(id)
  );
}

// Get API keys from environment or request headers
function getApiKey(req: VercelRequest): string {
  const headerKey = req.headers["x-cua-api-key"] as string;
  return headerKey || process.env.CUA_API_KEY || "";
}

function getAnthropicApiKey(): string {
  return process.env.ANTHROPIC_API_KEY || "";
}

// Format progress response for get_task_progress
function formatProgressResponse(progress: TaskProgress) {
  if (
    progress.status === "completed" ||
    progress.status === "failed" ||
    progress.status === "timeout"
  ) {
    return {
      task_id: progress.task_id,
      status: progress.status,
      result: progress.final_result,
    };
  }

  return {
    task_id: progress.task_id,
    status: progress.status,
    progress: {
      current_step: progress.current_step,
      max_steps: progress.max_steps,
      elapsed_ms: progress.elapsed_ms,
      timeout_seconds: progress.timeout_seconds,
      last_action: progress.last_action?.action,
      last_reasoning: progress.last_reasoning,
      steps_summary: progress.steps_summary,
    },
  };
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

    case "get_sandbox": {
      if (!isValidSandboxName(args.name)) {
        return { success: false, error: "Invalid sandbox name" };
      }
      const sandbox = await sandboxClient.getSandbox(args.name);
      if (!sandbox) {
        return { success: false, error: `Sandbox not found: ${args.name}` };
      }
      return sandbox;
    }

    case "start_sandbox": {
      if (!isValidSandboxName(args.name)) {
        return { success: false, error: "Invalid sandbox name" };
      }
      return await sandboxClient.startSandbox(args.name);
    }

    case "stop_sandbox": {
      if (!isValidSandboxName(args.name)) {
        return { success: false, error: "Invalid sandbox name" };
      }
      return await sandboxClient.stopSandbox(args.name);
    }

    case "restart_sandbox": {
      if (!isValidSandboxName(args.name)) {
        return { success: false, error: "Invalid sandbox name" };
      }
      return await sandboxClient.restartSandbox(args.name);
    }

    // ==========================================
    // Agentic Tools
    // ==========================================
    case "describe_screen": {
      if (!isValidSandboxName(args.sandbox_name)) {
        return { success: false, error: "Invalid sandbox name" };
      }
      const sandboxName = args.sandbox_name;
      // Validate focus enum - default to "ui" if invalid
      const validFocusValues = ["ui", "text", "full"] as const;
      const rawFocus = args.focus as string | undefined;
      const focus = validFocusValues.includes(rawFocus as "ui" | "text" | "full")
        ? (rawFocus as "ui" | "text" | "full")
        : "ui";
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
      if (!isValidSandboxName(args.sandbox_name)) {
        return { success: false, error: "Invalid sandbox name", summary: "Failed to start task" };
      }
      const sandboxName = args.sandbox_name;
      const task = args.task as string;
      if (typeof task !== "string" || !task.trim()) {
        return { success: false, error: "Task description is required", summary: "Failed to start task" };
      }
      const rawMaxSteps = Number(args.max_steps);
      const maxSteps = Math.min(
        Number.isFinite(rawMaxSteps) && rawMaxSteps > 0 ? rawMaxSteps : DEFAULT_MAX_STEPS,
        MAX_STEPS_LIMIT
      );
      const rawTimeout = Number(args.timeout_seconds);
      const timeoutSeconds = Math.min(
        Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS
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

      // Generate task ID and initialize progress BEFORE returning
      const taskId = generateTaskId();
      const progressUrl = await initializeProgress(
        taskId,
        sandboxName,
        task,
        maxSteps,
        timeoutSeconds
      );

      // Schedule background execution using waitUntil
      const backgroundTask = executeTaskInBackground(
        taskId,
        progressUrl || "",
        sandboxName,
        host,
        cuaApiKey,
        anthropicApiKey,
        task,
        maxSteps,
        timeoutSeconds
      );

      // Use Vercel's waitUntil to continue execution after response
      waitUntil(backgroundTask);

      // Return immediately with "running" status
      return {
        task_id: taskId,
        status: "running",
        progress_url: progressUrl,
        message: "Task started. Poll get_task_progress for updates.",
      };
    }

    case "get_task_history": {
      const taskId = args.task_id as string;
      if (!isValidTaskId(taskId)) {
        return { success: false, error: "Invalid task_id format" };
      }
      const historyUrl = args.history_url as string | undefined;

      // If URL provided, validate and fetch directly (SSRF protection)
      if (historyUrl) {
        if (!isValidBlobUrl(historyUrl)) {
          return { success: false, error: "Invalid history URL - must be a Vercel Blob URL" };
        }
        try {
          const response = await fetch(historyUrl);
          if (!response.ok) {
            return { success: false, error: "Task not found at provided URL" };
          }
          return await response.json() as TaskResult;
        } catch {
          return { success: false, error: "Failed to fetch from provided URL" };
        }
      }

      // Try to find blob by checking head (throws if not found)
      try {
        const blobInfo = await head(`tasks/${taskId}.json`);
        const response = await fetch(blobInfo.url);
        return await response.json() as TaskResult;
      } catch {
        return { success: false, error: "Task not found" };
      }
    }

    case "get_task_progress": {
      const taskId = args.task_id as string;
      if (!isValidTaskId(taskId)) {
        return { task_id: "", status: "error", error: "Invalid task_id format" };
      }

      // Always use head() to get fresh URL - bypasses CDN cache
      // The progress_url parameter is ignored in favor of fresh lookup
      try {
        const blobInfo = await head(`progress/${taskId}.json`);
        const response = await fetch(blobInfo.url, { cache: 'no-store' });
        const progress = (await response.json()) as TaskProgress;
        return formatProgressResponse(progress);
      } catch {
        // Progress blob not found, check if task completed
      }

      // Check if task completed (progress might be stale but task finished)
      try {
        const resultInfo = await head(`tasks/${taskId}.json`);
        const response = await fetch(resultInfo.url);
        const result = (await response.json()) as TaskResult;
        return {
          task_id: taskId,
          status: result.success ? "completed" : "failed",
          result: {
            success: result.success,
            summary: result.summary,
            total_steps: result.steps_taken,
            duration_ms: result.duration_ms,
            error: result.error,
          },
        };
      } catch {
        // Neither progress nor result found
        return { task_id: taskId, status: "not_found" };
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
