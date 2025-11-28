/**
 * CUA Cloud API Client
 * Handles sandbox lifecycle management and computer control
 */

const CUA_API_BASE = process.env.CUA_API_BASE || "https://api.cua.ai";

export interface Sandbox {
  name: string;
  password?: string;
  status: "pending" | "running" | "stopped" | "stopping" | "restarting" | "deleting";
  host?: string;
  api_url?: string;
  vnc_url?: string;
  os_type?: string;
}

export interface CommandResult {
  success: boolean;
  content?: string;
  error?: string;
  base64_image?: string;
}

/**
 * CUA Cloud Sandbox Management API
 */
export class CuaSandboxClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${CUA_API_BASE}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`CUA API error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * List all sandboxes
   */
  async listSandboxes(): Promise<Sandbox[]> {
    return this.request<Sandbox[]>("GET", "/v1/vms");
  }

  /**
   * Get sandbox details
   */
  async getSandbox(name: string): Promise<Sandbox> {
    return this.request<Sandbox>("GET", `/v1/vms/${name}`);
  }

  /**
   * Start a sandbox
   */
  async startSandbox(name: string): Promise<{ name: string; status: string }> {
    return this.request("POST", `/v1/vms/${name}/start`);
  }

  /**
   * Stop a sandbox
   */
  async stopSandbox(name: string): Promise<{ name: string; status: string }> {
    return this.request("POST", `/v1/vms/${name}/stop`);
  }

  /**
   * Restart a sandbox
   */
  async restartSandbox(name: string): Promise<{ name: string; status: string }> {
    return this.request("POST", `/v1/vms/${name}/restart`);
  }
}

/**
 * CUA Computer Server API Client
 * Controls the sandbox via REST API
 */
export class CuaComputerClient {
  private sandboxName: string;
  private host: string;
  private apiKey: string;

  constructor(sandboxName: string, host: string, apiKey: string) {
    this.sandboxName = sandboxName;
    this.host = host;
    this.apiKey = apiKey;
  }

  private getApiUrl(): string {
    return `https://${this.host}:8443`;
  }

  private async sendCommand(command: string, params: Record<string, unknown> = {}): Promise<CommandResult> {
    const url = `${this.getApiUrl()}/cmd`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Container-Name": this.sandboxName,
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ command, params }),
      });
    } catch (fetchErr) {
      return {
        success: false,
        error: `Network error connecting to ${url}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
      };
    }

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Computer Server error (${response.status}): ${error}`,
      };
    }

    // Handle streaming response
    const text = await response.text();
    const lines = text.split("\n").filter((line) => line.startsWith("data: "));

    for (const line of lines) {
      try {
        const data = JSON.parse(line.substring(6));
        if (data.success !== undefined) {
          // Normalize field names - CUA API uses 'image_data'
          if (data.image_data && !data.base64_image) {
            data.base64_image = data.image_data;
          } else if (data.image && !data.base64_image) {
            data.base64_image = data.image;
          }
          return data;
        }
      } catch {
        // Continue to next line
      }
    }

    // If no structured response found, check if raw response looks like success
    if (text.includes("base64") || text.length > 1000) {
      return { success: true, content: text };
    }

    return { success: false, error: `Unexpected response format: ${text.substring(0, 200)}` };
  }

  /**
   * Take a screenshot
   */
  async screenshot(): Promise<CommandResult> {
    return this.sendCommand("screenshot");
  }

  /**
   * Take a screenshot of a specific region (for zoom functionality)
   * @param x - Left coordinate of region
   * @param y - Top coordinate of region
   * @param width - Width of region
   * @param height - Height of region
   */
  async screenshotRegion(x: number, y: number, width: number, height: number): Promise<CommandResult> {
    return this.sendCommand("screenshot", { region: { x, y, width, height } });
  }

  /**
   * Run a shell command
   */
  async runCommand(cmd: string): Promise<CommandResult> {
    return this.sendCommand("run_command", { command: cmd });
  }

  /**
   * Type text
   */
  async typeText(text: string): Promise<CommandResult> {
    return this.sendCommand("type_text", { text });
  }

  /**
   * Press a key
   */
  async pressKey(key: string): Promise<CommandResult> {
    return this.sendCommand("press_key", { key });
  }

  /**
   * Press a hotkey combination
   */
  async hotkey(keys: string[]): Promise<CommandResult> {
    return this.sendCommand("hotkey", { keys });
  }

  /**
   * Hold a key down (for modifier keys like Shift, Ctrl, Alt)
   */
  async keyDown(key: string): Promise<CommandResult> {
    return this.sendCommand("key_down", { key });
  }

  /**
   * Release a held key
   */
  async keyUp(key: string): Promise<CommandResult> {
    return this.sendCommand("key_up", { key });
  }

  /**
   * Left click at coordinates (moves cursor first, then clicks)
   */
  async leftClick(x: number, y: number): Promise<CommandResult> {
    // CUA API requires move_cursor first, then left_click (which takes no params)
    await this.sendCommand("move_cursor", { x, y });
    return this.sendCommand("left_click", {});
  }

  /**
   * Right click at coordinates (moves cursor first, then clicks)
   */
  async rightClick(x: number, y: number): Promise<CommandResult> {
    await this.sendCommand("move_cursor", { x, y });
    return this.sendCommand("right_click", {});
  }

  /**
   * Double click at coordinates (moves cursor first, then clicks)
   */
  async doubleClick(x: number, y: number): Promise<CommandResult> {
    await this.sendCommand("move_cursor", { x, y });
    return this.sendCommand("double_click", {});
  }

  /**
   * Triple click at coordinates (moves cursor first, then clicks)
   */
  async tripleClick(x: number, y: number): Promise<CommandResult> {
    await this.sendCommand("move_cursor", { x, y });
    return this.sendCommand("triple_click", {});
  }

  /**
   * Middle click at coordinates (moves cursor first, then clicks)
   */
  async middleClick(x: number, y: number): Promise<CommandResult> {
    await this.sendCommand("move_cursor", { x, y });
    return this.sendCommand("middle_click", {});
  }

  /**
   * Press and hold left mouse button
   */
  async mouseDown(): Promise<CommandResult> {
    return this.sendCommand("mouse_down", {});
  }

  /**
   * Release left mouse button
   */
  async mouseUp(): Promise<CommandResult> {
    return this.sendCommand("mouse_up", {});
  }

  /**
   * Click and drag from current position to target coordinates
   */
  async drag(startX: number, startY: number, endX: number, endY: number): Promise<CommandResult> {
    await this.sendCommand("move_cursor", { x: startX, y: startY });
    await this.sendCommand("mouse_down", {});
    await this.sendCommand("move_cursor", { x: endX, y: endY });
    return this.sendCommand("mouse_up", {});
  }

  /**
   * Move cursor to coordinates
   */
  async moveCursor(x: number, y: number): Promise<CommandResult> {
    return this.sendCommand("move_cursor", { x, y });
  }

  /**
   * Scroll down
   */
  async scrollDown(clicks: number = 3): Promise<CommandResult> {
    return this.sendCommand("scroll_down", { clicks });
  }

  /**
   * Scroll up
   */
  async scrollUp(clicks: number = 3): Promise<CommandResult> {
    return this.sendCommand("scroll_up", { clicks });
  }

  /**
   * Scroll left (horizontal)
   */
  async scrollLeft(clicks: number = 3): Promise<CommandResult> {
    return this.sendCommand("scroll_left", { clicks });
  }

  /**
   * Scroll right (horizontal)
   */
  async scrollRight(clicks: number = 3): Promise<CommandResult> {
    return this.sendCommand("scroll_right", { clicks });
  }

  /**
   * Get screen size
   */
  async getScreenSize(): Promise<CommandResult> {
    return this.sendCommand("get_screen_size");
  }

  /**
   * Get cursor position
   */
  async getCursorPosition(): Promise<CommandResult> {
    return this.sendCommand("get_cursor_position");
  }

  /**
   * Set clipboard content
   */
  async setClipboard(text: string): Promise<CommandResult> {
    return this.sendCommand("set_clipboard", { text });
  }

  /**
   * Copy to clipboard (get clipboard content)
   */
  async copyToClipboard(): Promise<CommandResult> {
    return this.sendCommand("copy_to_clipboard");
  }

  /**
   * Check if file exists
   */
  async fileExists(path: string): Promise<CommandResult> {
    return this.sendCommand("file_exists", { path });
  }

  /**
   * Read text from file
   */
  async readText(path: string): Promise<CommandResult> {
    return this.sendCommand("read_text", { path });
  }

  /**
   * Write text to file
   */
  async writeText(path: string, content: string): Promise<CommandResult> {
    return this.sendCommand("write_text", { path, content });
  }

  /**
   * List directory contents
   */
  async listDir(path: string): Promise<CommandResult> {
    return this.sendCommand("list_dir", { path });
  }

  /**
   * Create directory
   */
  async createDir(path: string): Promise<CommandResult> {
    return this.sendCommand("create_dir", { path });
  }

  /**
   * Delete file
   */
  async deleteFile(path: string): Promise<CommandResult> {
    return this.sendCommand("delete_file", { path });
  }

  /**
   * Get accessibility tree of current window
   */
  async getAccessibilityTree(): Promise<CommandResult> {
    return this.sendCommand("get_accessibility_tree");
  }

  /**
   * Find element by role or title
   */
  async findElement(role?: string, title?: string): Promise<CommandResult> {
    return this.sendCommand("find_element", { role, title });
  }
}
