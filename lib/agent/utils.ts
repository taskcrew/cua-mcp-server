/**
 * Agent Utilities
 *
 * Common utility functions for the agent module.
 */

import { CuaSandboxClient } from "../cua-client.js";

/**
 * Sleep for a specified duration
 *
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a unique task ID
 *
 * @returns Task ID in format: task_{timestamp}_{random}
 */
export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get the host URL for a sandbox by name
 *
 * @param sandboxName - Name of the sandbox
 * @param cuaApiKey - CUA API key for authentication
 * @returns Host URL or null if sandbox not found
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
