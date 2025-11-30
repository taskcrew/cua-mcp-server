/**
 * Agent Execution
 *
 * Main agent execution module that orchestrates the computer use loop.
 * Uses the action handler registry for simplified action dispatch.
 */

import Anthropic from "@anthropic-ai/sdk";
import { put } from "@vercel/blob";
import { CuaComputerClient, CommandResult } from "../cua-client.js";
import type {
  AgentStep,
  TaskResult,
  TaskProgress,
  ActionInput,
} from "./types.js";
import {
  DEFAULT_DISPLAY_WIDTH,
  DEFAULT_DISPLAY_HEIGHT,
  RECOMMENDED_MAX_WIDTH,
  RECOMMENDED_MAX_HEIGHT,
  UI_SETTLE_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT_SECONDS,
  ANTHROPIC_MAX_RETRIES,
  getModelConfig,
} from "./config.js";
import {
  updateProgress,
  initializeProgress,
  finalizeTask,
  summarizeAction,
} from "./progress.js";
import { sleep, generateTaskId, getSandboxHost } from "./utils.js";
import { ACTION_HANDLERS, OBSERVATION_ACTIONS } from "./actions/index.js";

// Actions that should not trigger auto-release of held keys
const NO_AUTO_RELEASE_ACTIONS = new Set([
  "screenshot",
  "zoom",
  "hold_key",
  "wait",
]);

// ============================================
// Screen Dimensions Helper
// ============================================

/**
 * Get actual screen dimensions from the sandbox
 * Falls back to defaults if detection fails
 */
async function getScreenDimensions(
  computer: CuaComputerClient
): Promise<{ width: number; height: number }> {
  try {
    const result = (await computer.getScreenSize()) as CommandResult & {
      size?: { width: number; height: number };
    };
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
        const match = result.content.match(/(\d+)\s*[x\u00d7,]\s*(\d+)/i);
        if (match) {
          const dims = {
            width: parseInt(match[1]),
            height: parseInt(match[2]),
          };
          console.log("[Agent] Parsed screen dimensions from string:", dims);
          return dims;
        }
        // Try parsing content as JSON
        try {
          const parsed = JSON.parse(result.content);
          if (parsed.size?.width && parsed.size?.height) {
            const dims = {
              width: parsed.size.width,
              height: parsed.size.height,
            };
            console.log(
              "[Agent] Parsed screen dimensions from JSON (size):",
              dims
            );
            return dims;
          }
          if (parsed.width && parsed.height) {
            const dims = { width: parsed.width, height: parsed.height };
            console.log(
              "[Agent] Parsed screen dimensions from JSON (direct):",
              dims
            );
            return dims;
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
    }
    console.log("[Agent] Failed to parse screen size, using defaults");
  } catch (err) {
    console.log("[Agent] Error getting screen size:", err);
  }
  return { width: DEFAULT_DISPLAY_WIDTH, height: DEFAULT_DISPLAY_HEIGHT };
}

// ============================================
// System Prompt
// ============================================

const SYSTEM_PROMPT = `You are a computer use agent. Complete the user's task by interacting with the desktop.

IMPORTANT RULES:
1. After each action, take a screenshot to verify the result
2. When you click a button, verify in the next screenshot that the click worked
3. If a dialog disappears after clicking, the action succeeded
4. Be precise with coordinates - click the center of buttons
5. Do NOT scroll unless necessary - most UI elements are already visible

ENHANCED ACTIONS AVAILABLE:
- triple_click: Triple click to select entire paragraph or line of text
- hold_key: Press and hold a modifier key (e.g., shift, ctrl, alt). Keys are automatically released after the next action.
- left_mouse_down: Press and hold left mouse button at coordinates
- left_mouse_up: Release left mouse button at coordinates
- middle_click: Click middle mouse button (opens links in new tabs)

When using hold_key for modifier+click combinations:
Example sequence: hold_key("shift") -> left_click (shift auto-releases after click)

VISUAL VERIFICATION (Critical):
After every significant action, take a screenshot and carefully evaluate:
- Did the action produce the expected result?
- Is the UI in the expected state?
- If not, try an alternative approach before giving up.
Look for visual confirmation: dialogs appearing/disappearing, text changing, selections highlighting.

When the task is complete, you MUST output exactly: TASK_COMPLETE: <brief summary>
If you cannot complete the task, output exactly: TASK_FAILED: <reason>

Be efficient and direct. Verify your actions worked before moving on.`;

// ============================================
// Background Execution Wrapper
// ============================================

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

// ============================================
// Main Task Execution
// ============================================

/**
 * Execute a task autonomously using computer use agent loop
 *
 * @param sandboxName - Name of the CUA sandbox
 * @param host - Host URL for the sandbox
 * @param cuaApiKey - API key for CUA
 * @param anthropicApiKey - API key for Anthropic
 * @param task - Task description to complete
 * @param maxSteps - Maximum meaningful actions (default: 100)
 * @param timeoutSeconds - Timeout in seconds (default: 280, max: 280)
 * @param existingTaskId - Pre-generated task ID (for non-blocking mode)
 * @param existingProgressUrl - Pre-initialized progress URL
 * @returns Task result with progress URL
 */
export async function executeTask(
  sandboxName: string,
  host: string,
  cuaApiKey: string,
  anthropicApiKey: string,
  task: string,
  maxSteps: number = DEFAULT_MAX_STEPS,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS,
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
    maxRetries: ANTHROPIC_MAX_RETRIES, // Default is 2, increase for long-running tasks
  });
  const computer = new CuaComputerClient(sandboxName, host, cuaApiKey);

  // Get actual screen dimensions from sandbox
  const screenSize = await getScreenDimensions(computer);
  const displayWidth = screenSize.width;
  const displayHeight = screenSize.height;

  // Warn if resolution exceeds Anthropic recommendations for computer use
  if (
    displayWidth > RECOMMENDED_MAX_WIDTH ||
    displayHeight > RECOMMENDED_MAX_HEIGHT
  ) {
    console.warn(
      `[Agent] Screen resolution ${displayWidth}x${displayHeight} exceeds ` +
        `Anthropic's recommended maximum of ${RECOMMENDED_MAX_WIDTH}x${RECOMMENDED_MAX_HEIGHT}. ` +
        `Coordinate accuracy may be reduced for computer use tasks.`
    );
  }

  // Get model configuration
  const modelConfig = getModelConfig();

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Task: ${task}\n\nPlease complete this task. Start by taking a screenshot to see the current state.`,
    },
  ];

  // Track meaningful actions (excludes screenshot/zoom which are just observations)
  let meaningfulSteps = 0;
  // Safety limit: total iterations including screenshots (prevents infinite loops)
  const maxTotalIterations = maxSteps * 3;
  let totalIterations = 0;

  // Track held modifier keys for auto-release after actions
  // This works around Anthropic's computer use tool schema not having release_key
  const heldKeys = new Set<string>();

  while (meaningfulSteps < maxSteps && totalIterations < maxTotalIterations) {
    totalIterations++;

    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutSeconds * 1000) {
      await finalizeTask(taskId, progress, "timeout", {
        success: false,
        summary: "Task timed out",
        steps: steps.length,
        durationMs: elapsed,
        error: `Timeout after ${timeoutSeconds}s`,
      });

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

      // Use a heartbeat to update progress while waiting for API response
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
      const startHeartbeat = () => {
        heartbeatInterval = setInterval(async () => {
          // Create snapshot to avoid race condition with main loop
          const snapshot = {
            ...progress,
            updated_at: Date.now(),
            elapsed_ms: Date.now() - startTime,
          };
          await updateProgress(taskId, snapshot);
        }, HEARTBEAT_INTERVAL_MS);
      };
      const stopHeartbeat = () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = undefined;
        }
      };

      startHeartbeat();
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await anthropic.beta.messages.create({
          model: modelConfig.model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: [computerTool],
          messages,
          betas: [modelConfig.betaFlag],
        });
      } finally {
        stopHeartbeat();
      }

      // Process response
      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          // Capture reasoning from Claude's text (before any completion markers)
          if (
            !block.text.includes("TASK_COMPLETE:") &&
            !block.text.includes("TASK_FAILED:")
          ) {
            lastReasoning = block.text.trim();
          }

          // Check for task completion
          if (block.text.includes("TASK_COMPLETE:")) {
            const summary = block.text.split("TASK_COMPLETE:")[1].trim();
            const durationMs = Date.now() - startTime;

            await finalizeTask(taskId, progress, "completed", {
              success: true,
              summary,
              steps: meaningfulSteps,
              durationMs,
            });

            return {
              task_id: taskId,
              success: true,
              summary,
              steps,
              steps_taken: meaningfulSteps,
              duration_ms: durationMs,
              screen_size: { width: displayWidth, height: displayHeight },
              progress_url: progressUrl,
            };
          }

          if (block.text.includes("TASK_FAILED:")) {
            const reason = block.text.split("TASK_FAILED:")[1].trim();
            const durationMs = Date.now() - startTime;

            await finalizeTask(taskId, progress, "failed", {
              success: false,
              summary: reason,
              steps: meaningfulSteps,
              durationMs,
              error: "Task failed",
            });

            return {
              task_id: taskId,
              success: false,
              summary: reason,
              steps,
              steps_taken: meaningfulSteps,
              duration_ms: durationMs,
              error: "Task failed",
              progress_url: progressUrl,
            };
          }
        }

        if (block.type === "tool_use") {
          const input = block.input as ActionInput;

          const stepRecord: AgentStep = {
            step: steps.length + 1,
            action: input.action,
            coordinates: input.coordinate,
            success: true,
          };

          // Look up handler in registry
          const handler = ACTION_HANDLERS[input.action];
          if (!handler) {
            stepRecord.success = false;
            stepRecord.error = `Unknown action: ${input.action}`;
            steps.push(stepRecord);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Unknown action: ${input.action}`,
              is_error: true,
            });
            continue;
          }

          try {
            // Execute the action handler
            const result = await handler(input, computer, {
              displayWidth,
              displayHeight,
            });

            stepRecord.success = result.success;
            if (result.error) stepRecord.error = result.error;
            if (result.result) stepRecord.result = result.result;
            if (typeof result.content === "string")
              stepRecord.result = result.content;
            if (lastReasoning) stepRecord.reasoning = lastReasoning;

            steps.push(stepRecord);

            // Track held keys for auto-release
            if (input.action === "hold_key" && result.success) {
              const keyToHold = input.key || input.text;
              if (keyToHold) {
                heldKeys.add(keyToHold.toLowerCase());
                console.log(`[Agent] Key held: ${keyToHold} (${heldKeys.size} keys held)`);
              }
            }

            // Auto-release held keys after meaningful actions
            // This simulates the expected modifier key behavior: hold_key → action → release
            if (!NO_AUTO_RELEASE_ACTIONS.has(input.action) && heldKeys.size > 0) {
              console.log(`[Agent] Auto-releasing ${heldKeys.size} held keys after ${input.action}`);
              for (const key of heldKeys) {
                try {
                  await computer.keyUp(key);
                  console.log(`[Agent] Auto-released key: ${key}`);
                } catch (err) {
                  console.warn(`[Agent] Failed to auto-release key ${key}:`, err);
                }
              }
              heldKeys.clear();
            }

            // Update progress for meaningful actions (not screenshots/zoom)
            if (!OBSERVATION_ACTIONS.has(input.action)) {
              meaningfulSteps++;
              const now = Date.now();
              progress.current_step = meaningfulSteps;
              progress.updated_at = now;
              progress.elapsed_ms = now - startTime;
              progress.last_action = {
                action: input.action,
                reasoning: lastReasoning,
                result:
                  typeof result.content === "string"
                    ? result.content
                    : undefined,
                success: stepRecord.success,
                coordinates: input.coordinate,
              };
              progress.last_reasoning = lastReasoning;

              // Maintain rolling summary (last 5 actions)
              const summary = summarizeAction(input.action, input.coordinate);
              progress.steps_summary.push(summary);
              if (progress.steps_summary.length > 5) {
                progress.steps_summary.shift();
              }

              // Update progress (await to ensure it completes before next action)
              await updateProgress(taskId, progress);
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result.content,
            });

            // Delay for UI to settle after meaningful actions
            if (!OBSERVATION_ACTIONS.has(input.action)) {
              await sleep(UI_SETTLE_DELAY_MS);
            }
          } catch (err) {
            stepRecord.success = false;
            stepRecord.error = err instanceof Error ? err.message : String(err);
            steps.push(stepRecord);

            // Log error for debugging
            console.error(
              `[Agent] Action failed (${input.action}):`,
              stepRecord.error
            );

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
        const summaryText =
          lastText?.type === "text" ? lastText.text : "Task completed";
        const durationMs = Date.now() - startTime;

        await finalizeTask(taskId, progress, "completed", {
          success: true,
          summary: summaryText,
          steps: meaningfulSteps,
          durationMs,
        });

        return {
          task_id: taskId,
          success: true,
          summary: summaryText,
          steps,
          steps_taken: meaningfulSteps,
          duration_ms: durationMs,
          screen_size: { width: displayWidth, height: displayHeight },
          progress_url: progressUrl,
        };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;

      await finalizeTask(taskId, progress, "failed", {
        success: false,
        summary: `Agent error: ${errorMsg}`,
        steps: meaningfulSteps,
        durationMs,
        error: errorMsg,
      });

      return {
        task_id: taskId,
        success: false,
        summary: `Agent error: ${errorMsg}`,
        steps,
        steps_taken: meaningfulSteps,
        duration_ms: durationMs,
        screen_size: { width: displayWidth, height: displayHeight },
        error: errorMsg,
        progress_url: progressUrl,
      };
    }
  }

  // Max steps exceeded
  const durationMs = Date.now() - startTime;
  const errorMsg =
    meaningfulSteps >= maxSteps
      ? `Reached ${maxSteps} action limit (${meaningfulSteps} actions taken)`
      : `Safety limit reached (${totalIterations} total iterations)`;

  await finalizeTask(taskId, progress, "failed", {
    success: false,
    summary: "Max steps exceeded without completing task",
    steps: meaningfulSteps,
    durationMs,
    error: errorMsg,
  });

  return {
    task_id: taskId,
    success: false,
    summary: "Max steps exceeded without completing task",
    steps,
    steps_taken: meaningfulSteps,
    duration_ms: durationMs,
    screen_size: { width: displayWidth, height: displayHeight },
    error: errorMsg,
    progress_url: progressUrl,
  };
}

// ============================================
// Re-exports for Convenience
// ============================================

export { generateTaskId, getSandboxHost } from "./utils.js";
export { initializeProgress } from "./progress.js";
