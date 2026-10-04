import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { INTERNAL_HEADER, env } from "@penpotos/shared";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolOutput {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
  /** Raw MCP content blocks (for providers that pass them through). */
  content: any[];
}

export function mcpUrl() {
  return env.str("PENPOTOS_MCP_URL", `${env.mcpInternalUrl}/mcp`);
}

export function internalHeaders(actor: string, storage: string): Record<string, string> {
  return { [INTERNAL_HEADER]: env.internalToken, "x-penpotos-actor": actor, "x-penpotos-storage": storage };
}

/** Connection to the PenpotOS MCP server on behalf of a Discord user. */
export class PenpotMcp {
  private client?: Client;

  constructor(
    private readonly actor: string,
    private readonly storage: string,
    private readonly opts: { url?: string; headers?: Record<string, string> } = {},
  ) {}

  async connect() {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url ?? mcpUrl()), {
      requestInit: { headers: this.opts.headers ?? internalHeaders(this.actor, this.storage) },
    });
    const client = new Client({ name: "penpotos-discord", version: "1.0.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async tools(): Promise<McpTool[]> {
    const client = await this.connect();
    const res = await client.listTools();
    return res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
    const client = await this.connect();
    const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 10 * 60_000 });
    const content: any[] = res.content ?? [];
    return {
      content,
      text: content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      images: content.filter((c) => c.type === "image").map((c) => ({ data: c.data, mimeType: c.mimeType })),
      isError: !!res.isError,
    };
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = undefined;
  }
}
