/**
 * Agent Validation
 *
 * Coordinate and input validation utilities.
 * Anthropic recommends validating coordinates before executing mouse actions.
 */

import type { ActionInput } from "./types.js";

/**
 * Validation result for coordinates
 */
export interface CoordinateValidation {
  valid: boolean;
  error?: string;
}

/**
 * Successful coordinate extraction result
 */
export interface ValidCoordinates {
  valid: true;
  x: number;
  y: number;
}

/**
 * Failed coordinate extraction result
 */
export interface InvalidCoordinates {
  valid: false;
  error: string;
}

/**
 * Validate that coordinates are within display bounds
 *
 * @param x - X coordinate
 * @param y - Y coordinate
 * @param width - Display width
 * @param height - Display height
 * @returns Validation result with error message if invalid
 */
export function validateCoordinates(
  x: number,
  y: number,
  width: number,
  height: number
): CoordinateValidation {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return {
      valid: false,
      error: `Coordinates (${x}, ${y}) are outside display bounds (${width}x${height})`,
    };
  }
  return { valid: true };
}

/**
 * Validate and extract coordinates from action input
 *
 * @param input - Action input containing optional coordinate
 * @param displayWidth - Display width for bounds checking
 * @param displayHeight - Display height for bounds checking
 * @returns Valid coordinates or error
 */
export function validateAndExtractCoords(
  input: ActionInput,
  displayWidth: number,
  displayHeight: number
): ValidCoordinates | InvalidCoordinates {
  if (!input.coordinate) {
    return { valid: false, error: "Action requires coordinate" };
  }
  const [x, y] = input.coordinate;
  const validation = validateCoordinates(x, y, displayWidth, displayHeight);
  if (!validation.valid) {
    return { valid: false, error: validation.error ?? "Validation failed" };
  }
  return { valid: true, x, y };
}
