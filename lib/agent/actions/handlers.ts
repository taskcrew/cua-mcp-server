/**
 * Action Handlers
 *
 * Individual handler functions for each computer use action.
 * Each handler follows the same signature and returns ActionResult.
 */

import type { CuaComputerClient } from "../../cua-client.js";
import type { ActionInput, ActionContext, ActionResult } from "./types.js";
import {
  validateCoordinates,
  validateAndExtractCoords,
} from "../validation.js";
import {
  ZOOM_REGION_WIDTH,
  ZOOM_REGION_HEIGHT,
  RETRY_DELAY_MS,
  MAX_WAIT_MS,
} from "../config.js";

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================
// Screenshot Actions
// ==========================================

/**
 * Capture full screen screenshot
 */
export async function handleScreenshot(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  let result = await computer.screenshot();
  // Retry once on failure after delay
  if (!result.success || !result.base64_image) {
    await sleep(RETRY_DELAY_MS);
    result = await computer.screenshot();
  }
  if (result.success && result.base64_image) {
    return {
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: result.base64_image,
          },
        },
      ],
      success: true,
    };
  }
  return {
    content: `Screenshot failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Capture zoomed region screenshot (Opus 4.5 only)
 * Takes a cropped screenshot centered on the coordinate
 */
export async function handleZoom(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const coords = validateAndExtractCoords(
    input,
    context.displayWidth,
    context.displayHeight
  );
  if (!coords.valid) {
    return { content: coords.error, success: false, error: coords.error };
  }

  const centerX = coords.x;
  const centerY = coords.y;
  // Calculate region bounds, clamped to screen dimensions
  const x = Math.max(0, Math.floor(centerX - ZOOM_REGION_WIDTH / 2));
  const y = Math.max(0, Math.floor(centerY - ZOOM_REGION_HEIGHT / 2));

  // Try region screenshot first, fall back to full screenshot if not supported
  let result = await computer.screenshotRegion(
    x,
    y,
    ZOOM_REGION_WIDTH,
    ZOOM_REGION_HEIGHT
  );

  // Retry once on failure, then fall back to full screenshot
  if (!result.success || !result.base64_image) {
    await sleep(RETRY_DELAY_MS);
    result = await computer.screenshotRegion(
      x,
      y,
      ZOOM_REGION_WIDTH,
      ZOOM_REGION_HEIGHT
    );
  }
  if (!result.success || !result.base64_image) {
    result = await computer.screenshot();
  }

  if (result.success && result.base64_image) {
    return {
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: result.base64_image,
          },
        },
      ],
      success: true,
      result: `Zoomed to region around (${centerX}, ${centerY})`,
    };
  }
  return {
    content: `Zoom screenshot failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

// ==========================================
// Mouse Actions
// ==========================================

/**
 * Move cursor to specified coordinates
 */
export async function handleMouseMove(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const coords = validateAndExtractCoords(
    input,
    context.displayWidth,
    context.displayHeight
  );
  if (!coords.valid) {
    return { content: coords.error, success: false, error: coords.error };
  }
  const result = await computer.moveCursor(coords.x, coords.y);
  if (result.success) {
    return { content: `Cursor moved to (${coords.x}, ${coords.y})`, success: true };
  }
  return {
    content: `Move cursor failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Left click at specified coordinates
 */
export async function handleLeftClick(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const coords = validateAndExtractCoords(
    input,
    context.displayWidth,
    context.displayHeight
  );
  if (!coords.valid) {
    return { content: coords.error, success: false, error: coords.error };
  }
  const result = await computer.leftClick(coords.x, coords.y);
  if (result.success) {
    return { content: `Left click at (${coords.x}, ${coords.y})`, success: true };
  }
  return {
    content: `Left click failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Right click at specified coordinates
 */
export async function handleRightClick(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const coords = validateAndExtractCoords(
    input,
    context.displayWidth,
    context.displayHeight
  );
  if (!coords.valid) {
    return { content: coords.error, success: false, error: coords.error };
  }
  const result = await computer.rightClick(coords.x, coords.y);
  if (result.success) {
    return { content: `Right click at (${coords.x}, ${coords.y})`, success: true };
  }
  return {
    content: `Right click failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Double click at specified coordinates
 */
export async function handleDoubleClick(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const coords = validateAndExtractCoords(
    input,
    context.displayWidth,
    context.displayHeight
  );
  if (!coords.valid) {
    return { content: coords.error, success: false, error: coords.error };
  }
  const result = await computer.doubleClick(coords.x, coords.y);
  if (result.success) {
    return { content: `Double click at (${coords.x}, ${coords.y})`, success: true };
  }
  return {
    content: `Double click failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Triple click at specified coordinates (select line/paragraph)
 */
export async function handleTripleClick(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const coords = validateAndExtractCoords(
    input,
    context.displayWidth,
    context.displayHeight
  );
  if (!coords.valid) {
    return { content: coords.error, success: false, error: coords.error };
  }
  const result = await computer.tripleClick(coords.x, coords.y);
  if (result.success) {
    return { content: `Triple click at (${coords.x}, ${coords.y})`, success: true };
  }
  return {
    content: `Triple click failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Middle click at specified coordinates
 */
export async function handleMiddleClick(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const coords = validateAndExtractCoords(
    input,
    context.displayWidth,
    context.displayHeight
  );
  if (!coords.valid) {
    return { content: coords.error, success: false, error: coords.error };
  }
  const result = await computer.middleClick(coords.x, coords.y);
  if (result.success) {
    return { content: `Middle click at (${coords.x}, ${coords.y})`, success: true };
  }
  return {
    content: `Middle click failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Click and drag from start to end coordinates
 */
export async function handleLeftClickDrag(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  // Drag from start_coordinate to coordinate (end)
  const startCoord = input.start_coordinate || input.coordinate;
  const endCoord = input.coordinate;

  if (!startCoord || !endCoord) {
    return {
      content: "left_click_drag requires start_coordinate and coordinate",
      success: false,
      error: "left_click_drag requires start_coordinate and coordinate",
    };
  }

  // Validate both start and end coordinates
  const startValidation = validateCoordinates(
    startCoord[0],
    startCoord[1],
    context.displayWidth,
    context.displayHeight
  );
  if (!startValidation.valid) {
    return {
      content: `Start ${startValidation.error}`,
      success: false,
      error: startValidation.error,
    };
  }

  const endValidation = validateCoordinates(
    endCoord[0],
    endCoord[1],
    context.displayWidth,
    context.displayHeight
  );
  if (!endValidation.valid) {
    return {
      content: `End ${endValidation.error}`,
      success: false,
      error: endValidation.error,
    };
  }

  const result = await computer.drag(
    startCoord[0],
    startCoord[1],
    endCoord[0],
    endCoord[1]
  );
  if (result.success) {
    return {
      content: `Dragged from (${startCoord[0]}, ${startCoord[1]}) to (${endCoord[0]}, ${endCoord[1]})`,
      success: true,
    };
  }
  return {
    content: `Drag failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Press and hold left mouse button
 */
export async function handleLeftMouseDown(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  await computer.mouseDown();
  return { content: "Mouse button pressed down", success: true };
}

/**
 * Release left mouse button
 */
export async function handleLeftMouseUp(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  await computer.mouseUp();
  return { content: "Mouse button released", success: true };
}

// ==========================================
// Keyboard Actions
// ==========================================

/**
 * Type text
 */
export async function handleType(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.text) {
    return {
      content: "type requires text",
      success: false,
      error: "type requires text",
    };
  }
  const result = await computer.typeText(input.text);
  if (result.success) {
    return { content: "Text typed", success: true };
  }
  return {
    content: `Type failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Press key or key combination
 */
export async function handleKey(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.text) {
    return {
      content: "key requires text",
      success: false,
      error: "key requires text",
    };
  }

  // Handle key combinations like "ctrl+c"
  let result;
  if (input.text.includes("+")) {
    const keys = input.text.split("+").map((k) => k.trim());
    result = await computer.hotkey(keys);
  } else {
    result = await computer.pressKey(input.text);
  }

  if (result.success) {
    return { content: `Key pressed: ${input.text}`, success: true };
  }
  return {
    content: `Key press failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Hold a modifier key down
 */
export async function handleHoldKey(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const keyToHold = input.key || input.text;
  if (!keyToHold) {
    return {
      content: "hold_key requires key",
      success: false,
      error: "hold_key requires key",
    };
  }
  await computer.keyDown(keyToHold);
  return {
    content: `Key held down: ${keyToHold}. Will remain held until released.`,
    success: true,
  };
}

/**
 * Release a held key
 */
export async function handleReleaseKey(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const keyToRelease = input.key || input.text;
  if (!keyToRelease) {
    return {
      content: "release_key requires key",
      success: false,
      error: "release_key requires key",
    };
  }
  await computer.keyUp(keyToRelease);
  return { content: `Key released: ${keyToRelease}`, success: true };
}

// ==========================================
// Scroll Actions
// ==========================================

/**
 * Scroll in a direction, optionally at a specific position
 */
export async function handleScroll(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const direction = input.scroll_direction || "down";
  const amount = input.scroll_amount || 3;

  // Move to scroll position first (if coordinate provided)
  if (input.coordinate) {
    const [x, y] = input.coordinate;
    const validation = validateCoordinates(
      x,
      y,
      context.displayWidth,
      context.displayHeight
    );
    if (!validation.valid) {
      return {
        content: validation.error!,
        success: false,
        error: validation.error,
      };
    }
    const moveResult = await computer.moveCursor(x, y);
    if (!moveResult.success) {
      return {
        content: `Move cursor for scroll failed: ${moveResult.error || "Unknown error"}`,
        success: false,
        error: moveResult.error,
      };
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
      return {
        content: `Unknown scroll direction: ${direction}`,
        success: false,
        error: `Unknown scroll direction: ${direction}`,
      };
  }

  if (scrollResult.success) {
    const coordInfo = input.coordinate
      ? ` at (${input.coordinate[0]}, ${input.coordinate[1]})`
      : "";
    return { content: `Scrolled ${direction}${coordInfo}`, success: true };
  }
  return {
    content: `Scroll failed: ${scrollResult.error || "Unknown error"}`,
    success: false,
    error: scrollResult.error,
  };
}

// ==========================================
// Cursor Position
// ==========================================

/**
 * Get current cursor position
 */
export async function handleCursorPosition(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const result = await computer.getCursorPosition();
  return {
    content: result.content || "Unknown position",
    success: true,
  };
}

// ==========================================
// Wait Action
// ==========================================

/**
 * Wait for a specified duration
 */
export async function handleWait(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const waitMs = (input.duration as number) || 1000;
  // Cap at maximum wait time
  await sleep(Math.min(waitMs, MAX_WAIT_MS));
  return { content: `Waited ${waitMs}ms`, success: true };
}

// ==========================================
// Shell Commands
// ==========================================

/**
 * Execute a shell command
 */
export async function handleRunCommand(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.command) {
    return {
      content: "run_command requires command",
      success: false,
      error: "run_command requires command",
    };
  }
  const result = await computer.runCommand(input.command);
  if (result.success) {
    return {
      content: result.content || "Command executed successfully",
      success: true,
    };
  }
  return {
    content: `Command failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

// ==========================================
// File Operations
// ==========================================

/**
 * Read file contents
 */
export async function handleReadFile(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.path) {
    return {
      content: "read_file requires path",
      success: false,
      error: "read_file requires path",
    };
  }
  const result = await computer.readText(input.path);
  if (result.success) {
    return { content: result.content || "(empty file)", success: true };
  }
  return {
    content: `Read failed: ${result.error || "File not found"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Write file contents
 */
export async function handleWriteFile(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.path || input.content === undefined) {
    return {
      content: "write_file requires path and content",
      success: false,
      error: "write_file requires path and content",
    };
  }
  const result = await computer.writeText(input.path, input.content);
  if (result.success) {
    return { content: `File written: ${input.path}`, success: true };
  }
  return {
    content: `Write failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * List directory contents
 */
export async function handleListDirectory(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.path) {
    return {
      content: "list_directory requires path",
      success: false,
      error: "list_directory requires path",
    };
  }
  const result = await computer.listDir(input.path);
  if (result.success) {
    return { content: result.content || "(empty directory)", success: true };
  }
  return {
    content: `List failed: ${result.error || "Directory not found"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Check if file exists
 */
export async function handleFileExists(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.path) {
    return {
      content: "file_exists requires path",
      success: false,
      error: "file_exists requires path",
    };
  }
  const result = await computer.fileExists(input.path);
  return {
    content: result.content || (result.success ? "true" : "false"),
    success: true,
  };
}

/**
 * Create directory
 */
export async function handleCreateDirectory(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.path) {
    return {
      content: "create_directory requires path",
      success: false,
      error: "create_directory requires path",
    };
  }
  const result = await computer.createDir(input.path);
  if (result.success) {
    return { content: `Directory created: ${input.path}`, success: true };
  }
  return {
    content: `Create failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Delete file
 */
export async function handleDeleteFile(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.path) {
    return {
      content: "delete_file requires path",
      success: false,
      error: "delete_file requires path",
    };
  }
  const result = await computer.deleteFile(input.path);
  if (result.success) {
    return { content: `File deleted: ${input.path}`, success: true };
  }
  return {
    content: `Delete failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

// ==========================================
// Clipboard Operations
// ==========================================

/**
 * Get clipboard contents
 */
export async function handleGetClipboard(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const result = await computer.copyToClipboard();
  if (result.success) {
    return { content: result.content || "(clipboard empty)", success: true };
  }
  return {
    content: `Get clipboard failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Set clipboard contents
 */
export async function handleSetClipboard(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  if (!input.text) {
    return {
      content: "set_clipboard requires text",
      success: false,
      error: "set_clipboard requires text",
    };
  }
  const result = await computer.setClipboard(input.text);
  if (result.success) {
    return { content: "Clipboard set", success: true };
  }
  return {
    content: `Set clipboard failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

// ==========================================
// Accessibility
// ==========================================

/**
 * Get accessibility tree
 */
export async function handleGetAccessibilityTree(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const result = await computer.getAccessibilityTree();
  if (result.success) {
    return { content: result.content || "(no accessibility tree)", success: true };
  }
  return {
    content: `Get accessibility tree failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}

/**
 * Find UI element by role and title
 */
export async function handleFindElement(
  input: ActionInput,
  computer: CuaComputerClient,
  context: ActionContext
): Promise<ActionResult> {
  const role = input.text; // Use text field for role
  const title = input.content; // Use content field for title
  const result = await computer.findElement(role, title);
  if (result.success) {
    return { content: result.content || "(element not found)", success: true };
  }
  return {
    content: `Find element failed: ${result.error || "Unknown error"}`,
    success: false,
    error: result.error,
  };
}
