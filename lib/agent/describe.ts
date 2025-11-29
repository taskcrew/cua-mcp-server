/**
 * Screen Description
 *
 * Vision-based screen description using Claude.
 * Takes a screenshot and returns a text description based on focus mode.
 */

import Anthropic from "@anthropic-ai/sdk";
import { CuaComputerClient } from "../cua-client.js";
import type { ScreenDescription } from "./types.js";
import { getModelConfig, RETRY_DELAY_MS } from "./config.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Describe what's on the screen using vision
 *
 * @param sandboxName - Name of the CUA sandbox
 * @param host - API host URL for the sandbox
 * @param cuaApiKey - CUA Cloud API key
 * @param anthropicApiKey - Anthropic API key for vision processing
 * @param focus - Type of description: "ui" for clickable elements, "text" for readable content, "full" for comprehensive
 * @param question - Optional specific question to answer about the screen
 * @returns Screen description result with success status
 */
export async function describeScreen(
  sandboxName: string,
  host: string,
  cuaApiKey: string,
  anthropicApiKey: string,
  focus: "ui" | "text" | "full" = "ui",
  question?: string
): Promise<ScreenDescription> {
  const anthropic = new Anthropic({
    apiKey: anthropicApiKey,
    maxRetries: 4, // Default is 2, increase for reliability
  });
  const computer = new CuaComputerClient(sandboxName, host, cuaApiKey);

  const modelConfig = getModelConfig();

  try {
    // Take screenshot with retry
    let screenshotResult = await computer.screenshot();
    if (!screenshotResult.success || !screenshotResult.base64_image) {
      // Retry once after delay
      await sleep(RETRY_DELAY_MS);
      screenshotResult = await computer.screenshot();
    }
    if (!screenshotResult.success || !screenshotResult.base64_image) {
      return {
        success: false,
        focus,
        error: screenshotResult.error || "Failed to capture screenshot",
      };
    }

    // Build prompt based on focus
    const prompts = {
      ui: "Describe clickable elements, buttons, inputs, links, and their approximate positions. Be precise about what can be interacted with.",
      text: "Extract and transcribe all readable text, organized by visual hierarchy.",
      full: "Provide comprehensive description: layout, UI elements, text content, visual state.",
    };

    const systemPrompt = question
      ? `Answer this question about the screenshot: ${question}`
      : prompts[focus];

    // Call Claude for description
    const response = await anthropic.messages.create({
      model: modelConfig.model,
      max_tokens: 1500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshotResult.base64_image,
              },
            },
            {
              type: "text",
              text: systemPrompt,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    return {
      success: true,
      description:
        textBlock?.type === "text" ? textBlock.text : "No description generated",
      focus,
    };
  } catch (err) {
    return {
      success: false,
      focus,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
