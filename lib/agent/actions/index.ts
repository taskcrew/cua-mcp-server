/**
 * Action Handler Registry
 *
 * Central registry mapping action names to their handler functions.
 * Also exports the set of observation-only actions that don't count
 * toward the step limit.
 */

import type { ActionHandler } from "./types.js";
import {
  // Screenshot Actions
  handleScreenshot,
  handleZoom,
  // Mouse Actions
  handleMouseMove,
  handleLeftClick,
  handleRightClick,
  handleDoubleClick,
  handleTripleClick,
  handleMiddleClick,
  handleLeftClickDrag,
  handleLeftMouseDown,
  handleLeftMouseUp,
  // Keyboard Actions
  handleType,
  handleKey,
  handleHoldKey,
  // Scroll Actions
  handleScroll,
  // Wait
  handleWait,
} from "./handlers.js";

// Re-export types for convenience
export type { ActionHandler, ActionInput, ActionContext, ActionResult } from "./types.js";

/**
 * Registry of action handlers keyed by action name
 * Maps each action type to its corresponding handler function
 */
export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  // Screenshot Actions
  screenshot: handleScreenshot,
  zoom: handleZoom,

  // Mouse Actions
  mouse_move: handleMouseMove,
  left_click: handleLeftClick,
  right_click: handleRightClick,
  double_click: handleDoubleClick,
  triple_click: handleTripleClick,
  middle_click: handleMiddleClick,
  left_click_drag: handleLeftClickDrag,
  left_mouse_down: handleLeftMouseDown,
  left_mouse_up: handleLeftMouseUp,

  // Keyboard Actions
  type: handleType,
  key: handleKey,
  hold_key: handleHoldKey,

  // Scroll Actions
  scroll: handleScroll,

  // Wait
  wait: handleWait,
};

/**
 * Actions that only observe the screen without making changes
 * These don't count toward the max_steps limit
 *
 * @see CLAUDE.md for step counting design rationale
 */
export const OBSERVATION_ACTIONS = new Set(["screenshot", "zoom"]);
