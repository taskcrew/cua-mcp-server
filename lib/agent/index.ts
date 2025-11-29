/**
 * Agent Module
 *
 * Re-exports all agent module components for backward compatibility.
 * Import from this file for a clean API:
 *
 * ```ts
 * import {
 *   AgentStep,
 *   TaskResult,
 *   getModelConfig,
 *   validateCoordinates,
 *   sleep,
 * } from "./agent/index.js";
 * ```
 */

// ============================================
// Types
// ============================================

export type {
  AgentStep,
  TaskResult,
  ScreenDescription,
  TaskProgress,
  ActionInput,
  ActionContext,
  ActionResult,
} from "./types.js";

// ============================================
// Config
// ============================================

export {
  // Task limits (enforced server-side)
  DEFAULT_MAX_STEPS,
  MAX_STEPS_LIMIT,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  // Display defaults
  DEFAULT_DISPLAY_WIDTH,
  DEFAULT_DISPLAY_HEIGHT,
  RECOMMENDED_MAX_WIDTH,
  RECOMMENDED_MAX_HEIGHT,
  ZOOM_REGION_WIDTH,
  ZOOM_REGION_HEIGHT,
  // Timing constants
  RETRY_DELAY_MS,
  MAX_WAIT_MS,
  HEARTBEAT_INTERVAL_MS,
  UI_SETTLE_DELAY_MS,
  // Model configuration
  MODEL_CONFIGS,
  DEFAULT_MODEL,
  getModelConfig,
} from "./config.js";

export type { ModelConfig } from "./config.js";

// ============================================
// Validation
// ============================================

export { validateCoordinates, validateAndExtractCoords } from "./validation.js";

export type {
  CoordinateValidation,
  ValidCoordinates,
  InvalidCoordinates,
} from "./validation.js";

// ============================================
// Utils
// ============================================

export { sleep, generateTaskId, getSandboxHost } from "./utils.js";

// ============================================
// Progress Management
// ============================================

export {
  updateProgress,
  initializeProgress,
  finalizeTask,
  summarizeAction,
} from "./progress.js";

// ============================================
// Execution
// ============================================

export { executeTask, executeTaskInBackground } from "./execute.js";

// ============================================
// Description
// ============================================

export { describeScreen } from "./describe.js";

// ============================================
// Actions
// ============================================

export { ACTION_HANDLERS, OBSERVATION_ACTIONS } from "./actions/index.js";
