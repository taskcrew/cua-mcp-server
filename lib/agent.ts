/**
 * Agentic Computer Use Loop
 *
 * Internal agent loop that uses Anthropic's computer use tool to autonomously
 * complete tasks. Screenshots and actions stay within this server - only text
 * summaries are returned to the caller.
 */

import Anthropic from "@anthropic-ai/sdk";
import { CuaComputerClient, CuaSandboxClient } from "./cua-client.js";

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
    const result = await computer.getScreenSize();
    if (result.success && result.content) {
      // Parse screen size from response (e.g., "1920x1080" or JSON)
      const match = result.content.match(/(\d+)\s*[x×,]\s*(\d+)/i);
      if (match) {
        return { width: parseInt(match[1]), height: parseInt(match[2]) };
      }
      // Try parsing as JSON
      try {
        const parsed = JSON.parse(result.content);
        if (parsed.width && parsed.height) {
          return { width: parsed.width, height: parsed.height };
        }
      } catch {}
    }
  } catch {}
  return { width: DEFAULT_DISPLAY_WIDTH, height: DEFAULT_DISPLAY_HEIGHT };
}

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Execute a task autonomously using computer use agent loop
 */
export async function executeTask(
  sandboxName: string,
  host: string,
  cuaApiKey: string,
  anthropicApiKey: string,
  task: string,
  maxSteps: number = 30,
  timeoutSeconds: number = 280
): Promise<TaskResult> {
  const taskId = generateTaskId();
  const startTime = Date.now();
  const steps: AgentStep[] = [];

  const anthropic = new Anthropic({ apiKey: anthropicApiKey });
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
      return {
        task_id: taskId,
        success: false,
        summary: "Task timed out",
        steps,
        steps_taken: steps.length,
        duration_ms: elapsed,
        screen_size: { width: displayWidth, height: displayHeight },
        error: `Timeout after ${timeoutSeconds}s`,
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
          // Check for task completion
          if (block.text.includes("TASK_COMPLETE:")) {
            const summary = block.text.split("TASK_COMPLETE:")[1].trim();
            return {
              task_id: taskId,
              success: true,
              summary,
              steps,
              steps_taken: steps.length,
              duration_ms: Date.now() - startTime,
            };
          }
          if (block.text.includes("TASK_FAILED:")) {
            const reason = block.text.split("TASK_FAILED:")[1].trim();
            return {
              task_id: taskId,
              success: false,
              summary: reason,
              steps,
              steps_taken: steps.length,
              duration_ms: Date.now() - startTime,
              error: "Task failed",
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
                  await computer.moveCursor(input.coordinate[0], input.coordinate[1]);
                  toolResultContent = "Cursor moved";
                } else {
                  toolResultContent = "mouse_move requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "left_click": {
                if (input.coordinate) {
                  const [x, y] = input.coordinate;
                  await computer.leftClick(x, y);
                  toolResultContent = `Left click at (${x}, ${y})`;
                } else {
                  toolResultContent = "left_click requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "right_click": {
                if (input.coordinate) {
                  await computer.rightClick(input.coordinate[0], input.coordinate[1]);
                }
                toolResultContent = "Right click performed";
                break;
              }

              case "double_click": {
                if (input.coordinate) {
                  await computer.doubleClick(input.coordinate[0], input.coordinate[1]);
                  toolResultContent = `Double click at (${input.coordinate[0]}, ${input.coordinate[1]})`;
                } else {
                  toolResultContent = "double_click requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "triple_click": {
                if (input.coordinate) {
                  await computer.tripleClick(input.coordinate[0], input.coordinate[1]);
                  toolResultContent = `Triple click at (${input.coordinate[0]}, ${input.coordinate[1]})`;
                } else {
                  toolResultContent = "triple_click requires coordinate";
                  stepRecord.success = false;
                }
                break;
              }

              case "middle_click": {
                if (input.coordinate) {
                  await computer.middleClick(input.coordinate[0], input.coordinate[1]);
                  toolResultContent = `Middle click at (${input.coordinate[0]}, ${input.coordinate[1]})`;
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
                  await computer.drag(startCoord[0], startCoord[1], endCoord[0], endCoord[1]);
                  toolResultContent = `Dragged from (${startCoord[0]}, ${startCoord[1]}) to (${endCoord[0]}, ${endCoord[1]})`;
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
                  await computer.typeText(input.text);
                  toolResultContent = "Text typed";
                } else {
                  toolResultContent = "type requires text";
                  stepRecord.success = false;
                }
                break;
              }

              case "key": {
                if (input.text) {
                  // Handle key combinations like "ctrl+c"
                  if (input.text.includes("+")) {
                    const keys = input.text.split("+").map((k) => k.trim());
                    await computer.hotkey(keys);
                  } else {
                    await computer.pressKey(input.text);
                  }
                  toolResultContent = "Key pressed";
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
                  await computer.moveCursor(input.coordinate[0], input.coordinate[1]);
                }

                // Execute scroll in the specified direction
                switch (direction) {
                  case "down":
                    await computer.scrollDown(amount);
                    break;
                  case "up":
                    await computer.scrollUp(amount);
                    break;
                  case "left":
                    await computer.scrollLeft(amount);
                    break;
                  case "right":
                    await computer.scrollRight(amount);
                    break;
                  default:
                    toolResultContent = `Unknown scroll direction: ${direction}`;
                    stepRecord.success = false;
                }

                if (stepRecord.success) {
                  toolResultContent = input.coordinate
                    ? `Scrolled ${direction} at (${input.coordinate[0]}, ${input.coordinate[1]})`
                    : `Scrolled ${direction}`;
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

            steps.push(stepRecord);

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
        return {
          task_id: taskId,
          success: true,
          summary: lastText?.type === "text" ? lastText.text : "Task completed",
          steps,
          steps_taken: steps.length,
          duration_ms: Date.now() - startTime,
        };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        task_id: taskId,
        success: false,
        summary: `Agent error: ${errorMsg}`,
        steps,
        steps_taken: steps.length,
        duration_ms: Date.now() - startTime,
        error: errorMsg,
      };
    }
  }

  return {
    task_id: taskId,
    success: false,
    summary: "Max steps exceeded without completing task",
    steps,
    steps_taken: steps.length,
    duration_ms: Date.now() - startTime,
    screen_size: { width: displayWidth, height: displayHeight },
    error: `Reached ${maxSteps} step limit`,
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
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });
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
