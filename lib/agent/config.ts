/**
 * Agent Configuration
 *
 * Constants and model configurations for the agent module.
 * Extracted from agent.ts for modularity.
 */

// ============================================
// Display Defaults
// ============================================

/** Default display width when actual size cannot be determined */
export const DEFAULT_DISPLAY_WIDTH = 1024;

/** Default display height when actual size cannot be determined */
export const DEFAULT_DISPLAY_HEIGHT = 768;

/** Anthropic recommends max width for optimal computer use accuracy */
export const RECOMMENDED_MAX_WIDTH = 1280;

/** Anthropic recommends max height for optimal computer use accuracy */
export const RECOMMENDED_MAX_HEIGHT = 800;

/** Width of zoom region for Opus 4.5 zoom action */
export const ZOOM_REGION_WIDTH = 400;

/** Height of zoom region for Opus 4.5 zoom action */
export const ZOOM_REGION_HEIGHT = 300;

// ============================================
// Timing Constants
// ============================================

/** Delay before retrying failed operations (ms) */
export const RETRY_DELAY_MS = 500;

/** Maximum wait time for wait action (ms) */
export const MAX_WAIT_MS = 5000;

/** Interval for progress heartbeat during API calls (ms) */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** Delay for UI to settle after actions (ms) */
export const UI_SETTLE_DELAY_MS = 500;

// ============================================
// Model Configurations
// ============================================

/**
 * Configuration for a specific Claude model
 */
export type ModelConfig = {
  model: string;
  toolType: "computer_20250124" | "computer_20251124";
  betaFlag: string;
  supportsZoom: boolean;
};

/**
 * Available model configurations
 * Keys match the CUA_MODEL environment variable values
 */
export const MODEL_CONFIGS: Record<string, ModelConfig> = {
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

/** Default model key (Opus 4.5 for better accuracy) */
export const DEFAULT_MODEL = "claude-opus-4-5";

/**
 * Get the model configuration based on environment variable
 * Falls back to Sonnet 4.5 if unknown model specified
 */
export function getModelConfig(): ModelConfig {
  const modelKey = process.env.CUA_MODEL || DEFAULT_MODEL;
  const config = MODEL_CONFIGS[modelKey];
  if (!config) {
    console.warn(
      `[Agent] Unknown model ${modelKey}, falling back to claude-sonnet-4-5`
    );
    return MODEL_CONFIGS["claude-sonnet-4-5"];
  }
  return config;
}
