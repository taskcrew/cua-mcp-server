/**
 * Action Handler Types
 *
 * Type definitions for the action handler system.
 * Each handler takes an input, computer client, and context,
 * then returns a result.
 */

import type { CuaComputerClient } from "../../cua-client.js";
import type { ActionInput, ActionContext, ActionResult } from "../types.js";

/**
 * Handler function signature for computer use actions
 *
 * @param input - The action input with action type and parameters
 * @param computer - The CUA computer client for executing actions
 * @param context - Context including display dimensions for validation
 * @returns Promise resolving to the action result
 */
export type ActionHandler = (
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
) => Promise<ActionResult>;

// Re-export types for convenience
export type { ActionInput, ActionContext, ActionResult };
