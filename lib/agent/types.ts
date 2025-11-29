/**
 * Agent Types
 *
 * Type definitions for the agent module including step tracking,
 * task results, progress reporting, and action handling.
 */

import type Anthropic from "@anthropic-ai/sdk";

// ============================================
// Core Agent Types (extracted from agent.ts)
// ============================================

/**
 * Represents a single step in the agent execution loop
 */
export interface AgentStep {
  step: number;
  action: string;
  reasoning?: string;
  coordinates?: [number, number];
  result?: string;
  success: boolean;
  error?: string;
}

/**
 * Result of a completed task execution
 */
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

/**
 * Result of a screen description request
 */
export interface ScreenDescription {
  success: boolean;
  description?: string;
  focus: string;
  error?: string;
}

/**
 * Progress tracking for running tasks
 * Stored in Vercel Blob and polled by clients
 */
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

// ============================================
// Action Handler Types (new for modular design)
// ============================================

/**
 * Input structure for computer use actions
 * Matches the tool_use block input from Anthropic API
 */
export interface ActionInput {
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
}

/**
 * Context required for action execution
 * Provides display dimensions for coordinate validation
 */
export interface ActionContext {
  displayWidth: number;
  displayHeight: number;
}

/**
 * Result of executing an action
 * Content can be a string message or image blocks for screenshots
 */
export interface ActionResult {
  content: string | Anthropic.Beta.BetaImageBlockParam[];
  success: boolean;
  error?: string;
  result?: string;
}
