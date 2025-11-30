/**
 * Progress Management
 *
 * Functions for tracking and updating task progress in Vercel Blob storage.
 * Provides retry logic, initialization, and finalization helpers.
 */

import { put } from "@vercel/blob";
import type { TaskProgress } from "./types.js";
import { sleep } from "./utils.js";
import { RETRY_BACKOFF_BASE_MS } from "./config.js";

/**
 * Update progress in Vercel Blob storage with retry logic
 *
 * @param taskId - Unique task identifier
 * @param progress - Current progress state
 * @param retries - Number of retry attempts (default: 2)
 * @returns The blob URL on success, undefined on failure
 */
export async function updateProgress(
  taskId: string,
  progress: TaskProgress,
  retries: number = 2
): Promise<string | undefined> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const blob = await put(
        `progress/${taskId}.json`,
        JSON.stringify(progress),
        { access: "public", addRandomSuffix: false }
      );
      if (attempt > 0) {
        console.log(`[Agent] Progress update succeeded on retry ${attempt}`);
      }
      return blob.url;
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) {
        console.error(
          `[Agent] Failed to update progress after ${retries + 1} attempts:`,
          err
        );
        return undefined;
      }
      // Wait before retry (exponential backoff: 100ms, 200ms)
      await sleep(RETRY_BACKOFF_BASE_MS * (attempt + 1));
    }
  }
  return undefined;
}

/**
 * Initialize progress tracking for a new task
 *
 * @param taskId - Unique task identifier
 * @param sandboxName - Name of the sandbox being used
 * @param task - Task description
 * @param maxSteps - Maximum number of steps allowed
 * @param timeoutSeconds - Timeout in seconds
 * @returns The progress URL for polling
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
 * Finalize task progress with result
 *
 * Consolidates the repeated progress update pattern used for
 * completion, failure, and timeout scenarios.
 *
 * @param taskId - Unique task identifier
 * @param progress - Current progress state (will be mutated)
 * @param status - Final status to set
 * @param result - Final result details
 * @returns The blob URL on success, undefined on failure
 */
export async function finalizeTask(
  taskId: string,
  progress: TaskProgress,
  status: TaskProgress["status"],
  result: {
    success: boolean;
    summary: string;
    steps: number;
    durationMs: number;
    error?: string;
  }
): Promise<string | undefined> {
  progress.status = status;
  progress.current_step = result.steps;
  progress.updated_at = Date.now();
  progress.elapsed_ms = result.durationMs;
  progress.final_result = {
    success: result.success,
    summary: result.summary,
    total_steps: result.steps,
    duration_ms: result.durationMs,
    error: result.error,
  };

  const updateResult = await updateProgress(taskId, progress);
  console.log(
    `[Agent] Final progress update (${status}): ${updateResult ? "success" : "FAILED"}`
  );
  return updateResult;
}

// ============================================
// Action Summary Helpers
// ============================================

/**
 * Human-readable labels for action types
 */
const ACTION_LABELS: Record<string, string> = {
  left_click: "Click",
  right_click: "Right-click",
  double_click: "Double-click",
  triple_click: "Triple-click",
  middle_click: "Middle-click",
  type: "Type text",
  key: "Key press",
  scroll: "Scroll",
  mouse_move: "Move cursor",
  left_click_drag: "Drag",
};

/**
 * Create a human-readable summary of an action
 *
 * @param action - The action type (e.g., "left_click", "type")
 * @param coords - Optional coordinates for mouse actions
 * @returns Human-readable action description
 */
export function summarizeAction(
  action: string,
  coords?: [number, number]
): string {
  const coordStr = coords ? ` at (${coords[0]}, ${coords[1]})` : "";
  const label = ACTION_LABELS[action] || action.replace(/_/g, " ");
  return `${label}${coordStr}`;
}
