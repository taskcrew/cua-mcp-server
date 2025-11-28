/**
 * Agentic Computer Use Loop
 *
 * Internal agent loop that uses Anthropic's computer use tool to autonomously
 * complete tasks. Screenshots and actions stay within this server - only text
 * summaries are returned to the caller.
 */

import Anthropic from "@anthropic-ai/sdk";
import { put } from "@vercel/blob";
import { CommandResult, CuaComputerClient, CuaSandboxClient } from "./cua-client.js";

export interface AgentStep {
  step: number;
  action: string;
  reasoning?: string;
  coordinates?: [number, number];
  result?: string;
  success: boolean;
  error?: string;
}

export interface TaskResult {
  task_id: string;
  success: boolean;
  summary: string;
  steps: AgentStep[];
  steps_taken: number;
  duration_ms: number;
  screen_size?: { width: number; height: number };
  error?: string;
}

export interface ScreenDescription {
  success: boolean;
  description?: string;
  focus: string;
  error?: string;
}

export interface TaskProgress {
  task_id: string;
  sandbox_name: string;
  task: string;
  status: "running" | "completed" | "failed" | "timeout";
  current_step: number;
  max_steps: number;
  started_at: number;
  updated_at: number;
  elapsed_ms: number;
  timeout_seconds: number;
  last_action?: {
    action: string;
    reasoning?: string;
    result?: string;
    success: boolean;
    coordinates?: [number, number];
  };
  steps_summary: string[];
  last_reasoning?: string;
  final_result?: {
    success: boolean;
    summary: string;
    total_steps: number;
    duration_ms: number;
    error?: string;
  };
}

// Default display dimensions - will be overridden by actual screen size
const DEFAULT_DISPLAY_WIDTH = 1024;
const DEFAULT_DISPLAY_HEIGHT = 768;

// Zoom region size - balances detail vs context (matches typical UI element sizes)
const ZOOM_REGION_WIDTH = 400;
const ZOOM_REGION_HEIGHT = 300;

// Model configurations
type ModelConfig = {
  model: string;
  toolType: "computer_20250124" | "computer_20251124";
  betaFlag: string;
  supportsZoom: boolean;
};

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "claude-sonnet-4-5": {
    model: "claude-sonnet-4-5-20250929",
    toolType: "computer_20250124",
    betaFlag: "computer-use-2025-01-24",
    supportsZoom: false,
  },
  "claude-opus-4-5": {
    model: "claude-opus-4-5-20251101",
    toolType: "computer_20251124",
    betaFlag: "computer-use-2025-11-24",
    supportsZoom: true,
  },
};

// Default to Opus 4.5 (better accuracy), can be overridden via env
const DEFAULT_MODEL = process.env.CUA_MODEL || "claude-opus-4-5";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getScreenDimensions(computer: CuaComputerClient): Promise<{ width: number; height: number }> {
  try {
    const result = await computer.getScreenSize() as CommandResult & { size?: { width: number; height: number } };
    console.log("[Agent] get_screen_size result:", JSON.stringify(result));

    if (result.success) {
      // CUA SDK returns { success: true, size: { width, height } }
      if (result.size?.width && result.size?.height) {
        const dims = { width: result.size.width, height: result.size.height };
        console.log("[Agent] Screen dimensions from size field:", dims);
        return dims;
      }

      // Fallback: parse from content string (legacy/alternate format)
      if (result.content) {
        // Try regex for "1920x1080" format
        const match = result.content.match(/(\d+)\s*[x×,]\s*(\d+)/i);
        if (match) {
          const dims = { width: parseInt(match[1]), height: parseInt(match[2]) };
          console.log("[Agent] Parsed screen dimensions from string:", dims);
          return dims;
        }
        // Try parsing content as JSON
        try {
          const parsed = JSON.parse(result.content);
          if (parsed.size?.width && parsed.size?.height) {
            const dims = { width: parsed.size.width, height: parsed.size.height };
            console.log("[Agent] Parsed screen dimensions from JSON (size):", dims);
            return dims;
          }
          if (parsed.width && parsed.height) {
            const dims = { width: parsed.width, height: parsed.height };
            console.log("[Agent] Parsed screen dimensions from JSON (direct):", dims);
            return dims;
          }
        } catch {}
      }
    }
    console.log("[Agent] Failed to parse screen size, using defaults");
  } catch (err) {
    console.log("[Agent] Error getting screen size:", err);
  }
  return { width: DEFAULT_DISPLAY_WIDTH, height: DEFAULT_DISPLAY_HEIGHT };
}

export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Update progress in Vercel Blob storage (fire-and-forget)
 */
async function updateProgress(
  taskId: string,
  progress: TaskProgress
): Promise<string | undefined> {
  try {
    const blob = await put(
      `progress/${taskId}.json`,
      JSON.stringify(progress),
      { access: "public", addRandomSuffix: false }
    );
    return blob.url;
  } catch (err) {
    console.error("[Agent] Failed to update progress:", err);
    return undefined;
  }
}

/**
 * Initialize progress tracking for a new task
 * Returns the progress URL for polling
 */
export async function initializeProgress(
  taskId: string,
  sandboxName: string,
  task: string,
  maxSteps: number,
  timeoutSeconds: number
): Promise<string | undefined> {
  const progress: TaskProgress = {
    task_id: taskId,
    sandbox_name: sandboxName,
    task,
    status: "running",
    current_step: 0,
    max_steps: maxSteps,
    started_at: Date.now(),
    updated_at: Date.now(),
    elapsed_ms: 0,
    timeout_seconds: timeoutSeconds,
    steps_summary: [],
  };
  return updateProgress(taskId, progress);
}

/**
 * Execute a task in the background (for non-blocking mode)
 * Wraps executeTask with error handling and result storage
 */
export async function executeTaskInBackground(
  taskId: string,
  progressUrl: string,
  sandboxName: string,
  host: string,
  cuaApiKey: string,
  anthropicApiKey: string,
  task: string,
  maxSteps: number,
  timeoutSeconds: number
): Promise<void> {
  try {
    const result = await executeTask(
      sandboxName,
      host,
      cuaApiKey,
      anthropicApiKey,
      task,
      maxSteps,
      timeoutSeconds,
      taskId,
      progressUrl
    );

    // Store final result in Blob
    await put(`tasks/${taskId}.json`, JSON.stringify(result), {
      access: "public",
      addRandomSuffix: false,
    });
  } catch (err) {
    console.error(`[Agent] Background task ${taskId} failed:`, err);

    // Update progress with error
    const errorProgress: TaskProgress = {
      task_id: taskId,
      sandbox_name: sandboxName,
      task,
      status: "failed",
      current_step: 0,
      max_steps: maxSteps,
      started_at: Date.now(),
      updated_at: Date.now(),
      elapsed_ms: 0,
      timeout_seconds: timeoutSeconds,
      steps_summary: [],
      final_result: {
        success: false,
        summary: `Background execution failed: ${err instanceof Error ? err.message : String(err)}`,
        total_steps: 0,
        duration_ms: 0,
        error: err instanceof Error ? err.message : String(err),
      },
    };
    await put(`progress/${taskId}.json`, JSON.stringify(errorProgress), {
      access: "public",
      addRandomSuffix: false,
    });
  }
}

/**
 * Create a human-readable summary of an action
 */
function summarizeAction(
  action: string,
  result?: string,
  coords?: [number, number]
): string {
  const coordStr = coords ? ` at (${coords[0]}, ${coords[1]})` : "";
  switch (action) {
    case "left_click": return `Click${coordStr}`;
    case "right_click": return `Right-click${coordStr}`;
    case "double_click": return `Double-click${coordStr}`;
    case "triple_click": return `Triple-click${coordStr}`;
    case "middle_click": return `Middle-click${coordStr}`;
    case "type": return "Type text";
    case "key": return "Key press";
    case "scroll": return "Scroll";
    case "run_command": return "Run command";
    case "mouse_move": return `Move cursor${coordStr}`;
    case "left_click_drag": return "Drag";
    case "read_file": return "Read file";
    case "write_file": return "Write file";
    case "list_directory": return "List directory";
    default: return action.replace(/_/g, " ");
  }
}

/**
 * Execute a task autonomously using computer use agent loop
 * @param existingTaskId - Optional pre-generated task ID (for non-blocking mode)
 * @param existingProgressUrl - Optional pre-initialized progress URL (for non-blocking mode)
 */
export async function executeTask(
  sandboxName: string,
  host: string,
  cuaApiKey: string,
  anthropicApiKey: string,
  task: string,
  maxSteps: number = 30,
  timeoutSeconds: number = 280,
  existingTaskId?: string,
  existingProgressUrl?: string
): Promise<TaskResult & { progress_url?: string }> {
  const taskId = existingTaskId || generateTaskId();
  const startTime = Date.now();
  const steps: AgentStep[] = [];
  let progressUrl: string | undefined = existingProgressUrl;
  let lastReasoning: string | undefined;

  // Initialize progress tracking (only if not pre-initialized)
  const progress: TaskProgress = {
    task_id: taskId,
    sandbox_name: sandboxName,
    task,
    status: "running",
    current_step: 0,
    max_steps: maxSteps,
    started_at: startTime,
    updated_at: startTime,
    elapsed_ms: 0,
    timeout_seconds: timeoutSeconds,
    steps_summary: [],
  };

  // Store initial progress (only if not pre-initialized)
  if (!existingProgressUrl) {
    progressUrl = await updateProgress(taskId, progress);
  }

  const anthropic = new Anthropic({
    apiKey: anthropicApiKey,
    maxRetries: 4,  // Default is 2, increase for long-running tasks
  });
  const computer = new CuaComputerClient(sandboxName, host, cuaApiKey);

  // Get actual screen dimensions from sandbox
  const screenSize = await getScreenDimensions(computer);
  const displayWidth = screenSize.width;
  const displayHeight = screenSize.height;

  // Get model configuration
  const modelKey = process.env.CUA_MODEL || DEFAULT_MODEL;
  const modelConfig = MODEL_CONFIGS[modelKey] || MODEL_CONFIGS["claude-sonnet-4-5"];

  const systemPrompt = `You are a computer use agent. Complete the user's task by interacting with the desktop.

IMPORTANT RULES:
1. After each action, take a screenshot to verify the result
2. When you click a button, verify in the next screenshot that the click worked
3. If a dialog disappears after clicking, the action succeeded
4. Be precise with coordinates - click the center of buttons
5. Do NOT scroll unless necessary - most UI elements are already visible

VISUAL VERIFICATION (Critical):
After every significant action, take a screenshot and carefully evaluate:
- Did the action produce the expected result?
- Is the UI in the expected state?
- If not, try an alternative approach before giving up.
Look for visual confirmation: dialogs appearing/disappearing, text changing, selections highlighting.

EXTENDED ACTIONS AVAILABLE:
Beyond standard computer_use actions, you can also use:
- run_command: Execute shell commands (use "command" field)
- read_file/write_file: Read/write files (use "path" and "content" fields)
- list_directory/file_exists/create_directory/delete_file: File system operations
- get_clipboard/set_clipboard: Clipboard operations (use "text" field for set)
- get_accessibility_tree/find_element: UI accessibility queries
- hold_key/release_key: Hold modifier keys for complex interactions

When the task is complete, you MUST output exactly: TASK_COMPLETE: <brief summary>
If you cannot complete the task, output exactly: TASK_FAILED: <reason>

Be efficient and direct. Verify your actions worked before moving on.`;

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Task: ${task}\n\nPlease complete this task. Start by taking a screenshot to see the current state.`,
    },
  ];

  for (let stepNum = 0; stepNum < maxSteps; stepNum++) {
    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutSeconds * 1000) {
      // Update final progress
      progress.status = "timeout";
      progress.updated_at = Date.now();
      progress.elapsed_ms = elapsed;
      progress.final_result = {
        success: false,
        summary: "Task timed out",
        total_steps: steps.length,
        duration_ms: elapsed,
        error: `Timeout after ${timeoutSeconds}s`,
      };
      await updateProgress(taskId, progress);

      return {
        task_id: taskId,
        success: false,
        summary: "Task timed out",
        steps,
        steps_taken: steps.length,
        duration_ms: elapsed,
        screen_size: { width: displayWidth, height: displayHeight },
        error: `Timeout after ${timeoutSeconds}s`,
        progress_url: progressUrl,
      };
    }

    try {
      // Build computer tool based on model config
      const computerTool = modelConfig.supportsZoom
        ? {
            type: modelConfig.toolType,
            name: "computer" as const,
            display_width_px: displayWidth,
            display_height_px: displayHeight,
            display_number: 1,
            enable_zoom: true,
          }
        : {
            type: modelConfig.toolType,
            name: "computer" as const,
            display_width_px: displayWidth,
            display_height_px: displayHeight,
            display_number: 1,
          };

      // Call Claude with computer use tool
      const response = await anthropic.beta.messages.create({
        model: modelConfig.model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: [computerTool],
        messages,
        betas: [modelConfig.betaFlag],
      });

      // Process response
      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          // Capture reasoning from Claude's text (before any completion markers)
          if (!block.text.includes("TASK_COMPLETE:") && !block.text.includes("TASK_FAILED:")) {
            lastReasoning = block.text.trim();
          }

          // Check for task completion
          if (block.text.includes("TASK_COMPLETE:")) {
            const summary = block.text.split("TASK_COMPLETE:")[1].trim();
            const durationMs = Date.now() - startTime;

            // Update final progress
            progress.status = "completed";
            progress.updated_at = Date.now();
            progress.elapsed_ms = durationMs;
            progress.final_result = {
              success: true,
              summary,
              total_steps: steps.length,
              duration_ms: durationMs,
            };
            await updateProgress(taskId, progress);

            return {
              task_id: taskId,
              success: true,
              summary,
              steps,
              steps_taken: steps.length,
              duration_ms: durationMs,
              screen_size: { width: displayWidth, height: displayHeight },
              progress_url: progressUrl,
            };
          }
          if (block.text.includes("TASK_FAILED:")) {
            const reason = block.text.split("TASK_FAILED:")[1].trim();
            const durationMs = Date.now() - startTime;

            // Update final progress
            progress.status = "failed";
            progress.updated_at = Date.now();
            progress.elapsed_ms = durationMs;
            progress.final_result = {
              success: false,
              summary: reason,
              total_steps: steps.length,
              duration_ms: durationMs,
              error: "Task failed",
            };
            await updateProgress(taskId, progress);

            return {
              task_id: taskId,
              success: false,
              summary: reason,
              steps,
              steps_taken: steps.length,
              duration_ms: durationMs,
              error: "Task failed",
              progress_url: progressUrl,
            };
          }
        }

        if (block.type === "tool_use") {
          const input = block.input as {
            action: string;
            coordinate?: [number, number];
            start_coordinate?: [number, number];
            text?: string;
            scroll_direction?: "up" | "down" | "left" | "right";
            scroll_amount?: number;
            duration?: number;
            key?: string;
            // Extended actions for file/shell/clipboard
            command?: string;
            path?: string;
            content?: string;
          };

          const stepRecord: AgentStep = {
            step: stepNum + 1,
            action: input.action,
            coordinates: input.coordinate,
            success: true,
          };

          try {
            let toolResultContent: Anthropic.Beta.BetaToolResultBlockParam["content"];

            switch (input.action) {
              case "screenshot": {
                let result = await computer.screenshot();
                // Retry once on failure after 500ms
                if (!result.success || !result.base64_image) {
                  await sleep(500);
                  result = await computer.screenshot();
                }
                if (result.success && result.base64_image) {
                  toolResultContent = [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: result.base64_image,
                      },
                    },
                  ];
                } else {
                  toolResultContent = `Screenshot failed: ${result.error || "Unknown error"}`;
                  stepRecord.success = false;
                  stepRecord.error = result.error;
                }
                break;
              }

              case "mouse_move": {
                if (input.coordinate) {
                  const [x, y] = input.coordinate;
                  const result = await computer.moveCursor(x, y);
                  if (result.success) {
                    toolResultContent = `Cursor moved to (${x}, ${y})`;
                  } else {
                    toolResultContent = `Move cursor failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "mouse_move requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "left_click": {
                if (input.coordinate) {
                  const [x, y] = input.coordinate;
                  const result = await computer.leftClick(x, y);
                  if (result.success) {
                    toolResultContent = `Left click at (${x}, ${y})`;
                  } else {
                    toolResultContent = `Left click failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "left_click requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "right_click": {
                if (input.coordinate) {
                  const [x, y] = input.coordinate;
                  const result = await computer.rightClick(x, y);
                  if (result.success) {
                    toolResultContent = `Right click at (${x}, ${y})`;
                  } else {
                    toolResultContent = `Right click failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "right_click requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "double_click": {
                if (input.coordinate) {
                  const [x, y] = input.coordinate;
                  const result = await computer.doubleClick(x, y);
                  if (result.success) {
                    toolResultContent = `Double click at (${x}, ${y})`;
                  } else {
                    toolResultContent = `Double click failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "double_click requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "triple_click": {
                if (input.coordinate) {
                  const [x, y] = input.coordinate;
                  const result = await computer.tripleClick(x, y);
                  if (result.success) {
                    toolResultContent = `Triple click at (${x}, ${y})`;
                  } else {
                    toolResultContent = `Triple click failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "triple_click requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "middle_click": {
                if (input.coordinate) {
                  const [x, y] = input.coordinate;
                  const result = await computer.middleClick(x, y);
                  if (result.success) {
                    toolResultContent = `Middle click at (${x}, ${y})`;
                  } else {
                    toolResultContent = `Middle click failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "middle_click requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "left_click_drag": {
                // Drag from start_coordinate to coordinate (end)
                const startCoord = input.start_coordinate || input.coordinate;
                const endCoord = input.coordinate;

                if (startCoord && endCoord) {
                  const result = await computer.drag(startCoord[0], startCoord[1], endCoord[0], endCoord[1]);
                  if (result.success) {
                    toolResultContent = `Dragged from (${startCoord[0]}, ${startCoord[1]}) to (${endCoord[0]}, ${endCoord[1]})`;
                  } else {
                    toolResultContent = `Drag failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "left_click_drag requires start_coordinate and coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "left_mouse_down": {
                await computer.mouseDown();
                toolResultContent = "Mouse button pressed down";
                break;
              }

              case "left_mouse_up": {
                await computer.mouseUp();
                toolResultContent = "Mouse button released";
                break;
              }

              case "hold_key": {
                // Hold a modifier key down - will be released on next action or explicitly
                const keyToHold = input.key || input.text;
                if (keyToHold) {
                  await computer.keyDown(keyToHold);
                  toolResultContent = `Key held down: ${keyToHold}. Will remain held until released.`;
                } else {
                  toolResultContent = "hold_key requires key";
                  stepRecord.success = false;
                }
                break;
              }

              case "release_key": {
                // Release a held key
                const keyToRelease = input.key || input.text;
                if (keyToRelease) {
                  await computer.keyUp(keyToRelease);
                  toolResultContent = `Key released: ${keyToRelease}`;
                } else {
                  toolResultContent = "release_key requires key";
                  stepRecord.success = false;
                }
                break;
              }

              case "type": {
                if (input.text) {
                  const result = await computer.typeText(input.text);
                  if (result.success) {
                    toolResultContent = "Text typed";
                  } else {
                    toolResultContent = `Type failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "type requires text";
                  stepRecord.success = false;
                }
                break;
              }

              case "key": {
                if (input.text) {
                  // Handle key combinations like "ctrl+c"
                  let result;
                  if (input.text.includes("+")) {
                    const keys = input.text.split("+").map((k) => k.trim());
                    result = await computer.hotkey(keys);
                  } else {
                    result = await computer.pressKey(input.text);
                  }
                  if (result.success) {
                    toolResultContent = `Key pressed: ${input.text}`;
                  } else {
                    toolResultContent = `Key press failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = result.error;
                  }
                } else {
                  toolResultContent = "key requires text";
                  stepRecord.success = false;
                }
                break;
              }

              case "scroll": {
                const direction = input.scroll_direction || "down";
                const amount = input.scroll_amount || 3;

                // Move to scroll position first (if coordinate provided)
                if (input.coordinate) {
                  const moveResult = await computer.moveCursor(input.coordinate[0], input.coordinate[1]);
                  if (!moveResult.success) {
                    toolResultContent = `Move cursor for scroll failed: ${moveResult.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = moveResult.error;
                    break;
                  }
                }

                // Execute scroll in the specified direction
                let scrollResult;
                switch (direction) {
                  case "down":
                    scrollResult = await computer.scrollDown(amount);
                    break;
                  case "up":
                    scrollResult = await computer.scrollUp(amount);
                    break;
                  case "left":
                    scrollResult = await computer.scrollLeft(amount);
                    break;
                  case "right":
                    scrollResult = await computer.scrollRight(amount);
                    break;
                  default:
                    toolResultContent = `Unknown scroll direction: ${direction}`;
                    stepRecord.success = false;
                    break;
                }

                if (scrollResult) {
                  if (scrollResult.success) {
                    toolResultContent = input.coordinate
                      ? `Scrolled ${direction} at (${input.coordinate[0]}, ${input.coordinate[1]})`
                      : `Scrolled ${direction}`;
                  } else {
                    toolResultContent = `Scroll failed: ${scrollResult.error || "Unknown error"}`;
                    stepRecord.success = false;
                    stepRecord.error = scrollResult.error;
                  }
                }
                break;
              }

              case "cursor_position": {
                const result = await computer.getCursorPosition();
                toolResultContent = result.content || "Unknown position";
                break;
              }

              case "wait": {
                // Wait for a specified duration (default 1 second)
                const waitMs = (input.duration as number) || 1000;
                await sleep(Math.min(waitMs, 5000)); // Cap at 5 seconds
                toolResultContent = `Waited ${waitMs}ms`;
                break;
              }

              case "zoom": {
                // Zoom action for Opus 4.5 - view specific screen regions at full resolution
                // Takes a cropped screenshot centered on the coordinate
                if (input.coordinate) {
                  const [centerX, centerY] = input.coordinate;

                  // Calculate region bounds, clamped to screen dimensions
                  const x = Math.max(0, Math.floor(centerX - ZOOM_REGION_WIDTH / 2));
                  const y = Math.max(0, Math.floor(centerY - ZOOM_REGION_HEIGHT / 2));

                  // Try region screenshot first, fall back to full screenshot if not supported
                  let result = await computer.screenshotRegion(x, y, ZOOM_REGION_WIDTH, ZOOM_REGION_HEIGHT);

                  // Retry once on failure, then fall back to full screenshot
                  if (!result.success || !result.base64_image) {
                    await sleep(500);
                    result = await computer.screenshotRegion(x, y, ZOOM_REGION_WIDTH, ZOOM_REGION_HEIGHT);
                  }
                  if (!result.success || !result.base64_image) {
                    result = await computer.screenshot();
                  }

                  if (result.success && result.base64_image) {
                    toolResultContent = [
                      {
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: "image/png",
                          data: result.base64_image,
                        },
                      },
                    ];
                    stepRecord.result = `Zoomed to region around (${centerX}, ${centerY})`;
                  } else {
                    toolResultContent = `Zoom screenshot failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                  }
                } else {
                  toolResultContent = "zoom requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              // ==========================================
              // Extended Actions: Shell Commands
              // ==========================================
              case "run_command": {
                if (input.command) {
                  const result = await computer.runCommand(input.command);
                  if (result.success) {
                    toolResultContent = result.content || "Command executed successfully";
                  } else {
                    toolResultContent = `Command failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                  }
                } else {
                  toolResultContent = "run_command requires command";
                  stepRecord.success = false;
                }
                break;
              }

              // ==========================================
              // Extended Actions: File Operations
              // ==========================================
              case "read_file": {
                if (input.path) {
                  const result = await computer.readText(input.path);
                  if (result.success) {
                    toolResultContent = result.content || "(empty file)";
                  } else {
                    toolResultContent = `Read failed: ${result.error || "File not found"}`;
                    stepRecord.success = false;
                  }
                } else {
                  toolResultContent = "read_file requires path";
                  stepRecord.success = false;
                }
                break;
              }

              case "write_file": {
                if (input.path && input.content !== undefined) {
                  const result = await computer.writeText(input.path, input.content);
                  if (result.success) {
                    toolResultContent = `File written: ${input.path}`;
                  } else {
                    toolResultContent = `Write failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                  }
                } else {
                  toolResultContent = "write_file requires path and content";
                  stepRecord.success = false;
                }
                break;
              }

              case "list_directory": {
                if (input.path) {
                  const result = await computer.listDir(input.path);
                  if (result.success) {
                    toolResultContent = result.content || "(empty directory)";
                  } else {
                    toolResultContent = `List failed: ${result.error || "Directory not found"}`;
                    stepRecord.success = false;
                  }
                } else {
                  toolResultContent = "list_directory requires path";
                  stepRecord.success = false;
                }
                break;
              }

              case "file_exists": {
                if (input.path) {
                  const result = await computer.fileExists(input.path);
                  toolResultContent = result.content || (result.success ? "true" : "false");
                } else {
                  toolResultContent = "file_exists requires path";
                  stepRecord.success = false;
                }
                break;
              }

              case "create_directory": {
                if (input.path) {
                  const result = await computer.createDir(input.path);
                  if (result.success) {
                    toolResultContent = `Directory created: ${input.path}`;
                  } else {
                    toolResultContent = `Create failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                  }
                } else {
                  toolResultContent = "create_directory requires path";
                  stepRecord.success = false;
                }
                break;
              }

              case "delete_file": {
                if (input.path) {
                  const result = await computer.deleteFile(input.path);
                  if (result.success) {
                    toolResultContent = `File deleted: ${input.path}`;
                  } else {
                    toolResultContent = `Delete failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                  }
                } else {
                  toolResultContent = "delete_file requires path";
                  stepRecord.success = false;
                }
                break;
              }

              // ==========================================
              // Extended Actions: Clipboard Operations
              // ==========================================
              case "get_clipboard": {
                const result = await computer.copyToClipboard();
                if (result.success) {
                  toolResultContent = result.content || "(clipboard empty)";
                } else {
                  toolResultContent = `Get clipboard failed: ${result.error || "Unknown error"}`;
                  stepRecord.success = false;
                }
                break;
              }

              case "set_clipboard": {
                if (input.text) {
                  const result = await computer.setClipboard(input.text);
                  if (result.success) {
                    toolResultContent = "Clipboard set";
                  } else {
                    toolResultContent = `Set clipboard failed: ${result.error || "Unknown error"}`;
                    stepRecord.success = false;
                  }
                } else {
                  toolResultContent = "set_clipboard requires text";
                  stepRecord.success = false;
                }
                break;
              }

              // ==========================================
              // Extended Actions: Accessibility
              // ==========================================
              case "get_accessibility_tree": {
                const result = await computer.getAccessibilityTree();
                if (result.success) {
                  toolResultContent = result.content || "(no accessibility tree)";
                } else {
                  toolResultContent = `Get accessibility tree failed: ${result.error || "Unknown error"}`;
                  stepRecord.success = false;
                }
                break;
              }

              case "find_element": {
                const role = input.text; // Use text field for role
                const title = input.content; // Use content field for title
                const result = await computer.findElement(role, title);
                if (result.success) {
                  toolResultContent = result.content || "(element not found)";
                } else {
                  toolResultContent = `Find element failed: ${result.error || "Unknown error"}`;
                  stepRecord.success = false;
                }
                break;
              }

              default:
                toolResultContent = `Unknown action: ${input.action}`;
                stepRecord.success = false;
            }

            // Capture result in step record (for non-screenshot actions)
            if (typeof toolResultContent === "string") {
              stepRecord.result = toolResultContent;
            }

            // Store reasoning in step record
            if (lastReasoning) {
              stepRecord.reasoning = lastReasoning;
            }

            steps.push(stepRecord);

            // Update progress for meaningful actions (not screenshots/zoom)
            if (input.action !== "screenshot" && input.action !== "zoom") {
              const now = Date.now();
              progress.current_step = steps.length;
              progress.updated_at = now;
              progress.elapsed_ms = now - startTime;
              progress.last_action = {
                action: input.action,
                reasoning: lastReasoning,
                result: typeof toolResultContent === "string" ? toolResultContent : undefined,
                success: stepRecord.success,
                coordinates: input.coordinate,
              };
              progress.last_reasoning = lastReasoning;

              // Maintain rolling summary (last 5 actions)
              const summary = summarizeAction(input.action, stepRecord.result, input.coordinate);
              progress.steps_summary.push(summary);
              if (progress.steps_summary.length > 5) {
                progress.steps_summary.shift();
              }

              // Fire-and-forget progress update (don't block agent loop)
              updateProgress(taskId, progress).catch((err) => {
                console.error(`[Agent] Progress update failed for step ${steps.length}:`, err);
              });
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: toolResultContent,
            });

            // Delay for UI to settle after action (500ms handles slower UI frameworks)
            if (input.action !== "screenshot" && input.action !== "zoom") {
              await sleep(500);
            }
          } catch (err) {
            stepRecord.success = false;
            stepRecord.error = err instanceof Error ? err.message : String(err);
            steps.push(stepRecord);

            // Log error for debugging
            console.error(`[Agent] Step ${stepNum + 1} failed (${input.action}):`, stepRecord.error);

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error: ${stepRecord.error}`,
              is_error: true,
            });
          }
        }
      }

      // Add assistant response and tool results to message history
      messages.push({
        role: "assistant",
        content: response.content,
      });

      if (toolResults.length > 0) {
        messages.push({
          role: "user",
          content: toolResults,
        });
      }

      // If the model stopped without tool use and without completion markers
      if (response.stop_reason === "end_turn" && toolResults.length === 0) {
        // Check final text for any summary
        const lastText = response.content.find((b) => b.type === "text");
        const summaryText = lastText?.type === "text" ? lastText.text : "Task completed";
        const durationMs = Date.now() - startTime;

        // Update final progress
        progress.status = "completed";
        progress.updated_at = Date.now();
        progress.elapsed_ms = durationMs;
        progress.final_result = {
          success: true,
          summary: summaryText,
          total_steps: steps.length,
          duration_ms: durationMs,
        };
        await updateProgress(taskId, progress);

        return {
          task_id: taskId,
          success: true,
          summary: summaryText,
          steps,
          steps_taken: steps.length,
          duration_ms: durationMs,
          screen_size: { width: displayWidth, height: displayHeight },
          progress_url: progressUrl,
        };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;

      // Update final progress
      progress.status = "failed";
      progress.updated_at = Date.now();
      progress.elapsed_ms = durationMs;
      progress.final_result = {
        success: false,
        summary: `Agent error: ${errorMsg}`,
        total_steps: steps.length,
        duration_ms: durationMs,
        error: errorMsg,
      };
      await updateProgress(taskId, progress);

      return {
        task_id: taskId,
        success: false,
        summary: `Agent error: ${errorMsg}`,
        steps,
        steps_taken: steps.length,
        duration_ms: durationMs,
        screen_size: { width: displayWidth, height: displayHeight },
        error: errorMsg,
        progress_url: progressUrl,
      };
    }
  }

  const durationMs = Date.now() - startTime;

  // Update final progress
  progress.status = "failed";
  progress.updated_at = Date.now();
  progress.elapsed_ms = durationMs;
  progress.final_result = {
    success: false,
    summary: "Max steps exceeded without completing task",
    total_steps: steps.length,
    duration_ms: durationMs,
    error: `Reached ${maxSteps} step limit`,
  };
  await updateProgress(taskId, progress);

  return {
    task_id: taskId,
    success: false,
    summary: "Max steps exceeded without completing task",
    steps,
    steps_taken: steps.length,
    duration_ms: durationMs,
    screen_size: { width: displayWidth, height: displayHeight },
    error: `Reached ${maxSteps} step limit`,
    progress_url: progressUrl,
  };
}

/**
 * Describe what's on the screen using vision
 */
export async function describeScreen(
  sandboxName: string,
  host: string,
  cuaApiKey: string,
  anthropicApiKey: string,
  focus: "ui" | "text" | "full" = "ui",
  question?: string
): Promise<ScreenDescription> {
  const anthropic = new Anthropic({
    apiKey: anthropicApiKey,
    maxRetries: 4,  // Default is 2, increase for reliability
  });
  const computer = new CuaComputerClient(sandboxName, host, cuaApiKey);

  // Get model configuration
  const modelKey = process.env.CUA_MODEL || DEFAULT_MODEL;
  const modelConfig = MODEL_CONFIGS[modelKey] || MODEL_CONFIGS["claude-sonnet-4-5"];

  try {
    // Take screenshot with retry
    let screenshotResult = await computer.screenshot();
    if (!screenshotResult.success || !screenshotResult.base64_image) {
      // Retry once after 500ms
      await sleep(500);
      screenshotResult = await computer.screenshot();
    }
    if (!screenshotResult.success || !screenshotResult.base64_image) {
      return {
        success: false,
        focus,
        error: screenshotResult.error || "Failed to capture screenshot",
      };
    }

    // Build prompt based on focus
    const prompts = {
      ui: "Describe clickable elements, buttons, inputs, links, and their approximate positions. Be precise about what can be interacted with.",
      text: "Extract and transcribe all readable text, organized by visual hierarchy.",
      full: "Provide comprehensive description: layout, UI elements, text content, visual state.",
    };

    const systemPrompt = question
      ? `Answer this question about the screenshot: ${question}`
      : prompts[focus];

    // Call Claude for description
    const response = await anthropic.messages.create({
      model: modelConfig.model,
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshotResult.base64_image,
              },
            },
            {
              type: "text",
              text: systemPrompt,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    return {
      success: true,
      description: textBlock?.type === "text" ? textBlock.text : "No description generated",
      focus,
    };
  } catch (err) {
    return {
      success: false,
      focus,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Get sandbox host from API
 */
export async function getSandboxHost(
  sandboxName: string,
  cuaApiKey: string
): Promise<string | null> {
  const client = new CuaSandboxClient(cuaApiKey);
  try {
    // Use listSandboxes and filter - no single-sandbox endpoint exists
    const sandboxes = await client.listSandboxes();
    const sandbox = sandboxes.find((s) => s.name === sandboxName);
    if (!sandbox) {
      return null;
    }
    return sandbox.host || `${sandboxName}.sandbox.cua.ai`;
  } catch {
    return null;
  }
}
