import fs from "node:fs";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger, env } from "@penpotos/shared";
import { internalHeaders, mcpUrl } from "../mcp-client.ts";
import { extFor, toolLabel, type Provider, type RunOptions, type TaskResult } from "./types.ts";

const log = createLogger("claude-subscription");

interface SubscriptionState {
  provider: "claude-subscription";
  sessionId: string;
}

/**
 * Runs the task through the Claude Agent SDK (Claude Code harness) authenticated
 * with a Claude Pro/Max subscription token from `claude setup-token`.
 * Built-in tools are disabled – only the PenpotOS MCP tools are available.
 */
export class ClaudeSubscriptionProvider implements Provider {
  async run(opts: RunOptions): Promise<TaskResult> {
    const { settings } = opts;
    if (!settings.llm.claudeOauthToken) throw new Error("V admin dashboardu chybí OAuth token Claude předplatného (claude setup-token).");
    const prev = (opts.state as SubscriptionState | undefined)?.provider === "claude-subscription" ? (opts.state as SubscriptionState) : undefined;
    const workDir = env.str("PENPOTOS_DATA_DIR", "/data") + "/agent";
    fs.mkdirSync(workDir, { recursive: true });

    async function* prompt(): AsyncIterable<SDKUserMessage> {
      const content: any[] = opts.input.imageUrls.map((url) => ({ type: "image", source: { type: "url", url } }));
      content.push({ type: "text", text: opts.input.text });
      yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, origin: { kind: "human" } } as SDKUserMessage;
    }

    const abort = new AbortController();
    opts.signal?.addEventListener("abort", () => abort.abort());
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ANTHROPIC_")) childEnv[k] = v;
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = settings.llm.claudeOauthToken;
    childEnv.CLAUDE_AGENT_SDK_CLIENT_APP = "penpotos-discord/1.0";

    const run = (resume?: string) =>
      query({
        prompt: prompt(),
        options: {
          model: settings.llm.model,
          maxTurns: settings.llm.maxTurns,
          effort: settings.llm.effort,
          systemPrompt: opts.systemPrompt,
          tools: [],
          mcpServers: { penpot: { type: "http", url: mcpUrl(), headers: internalHeaders(opts.actor, opts.storageKey), timeout: 10 * 60_000 } },
          strictMcpConfig: true,
          allowedTools: ["mcp__penpot"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          cwd: workDir,
          env: childEnv,
          resume,
          abortController: abort,
          stderr: (d) => log.debug(d.trim()),
        },
      });

    const toolNames = new Map<string, string>();
    const images: TaskResult["images"] = [];
    let lastText = "";
    let resultText = "";
    let sessionId = prev?.sessionId ?? "";

    const consume = async (q: ReturnType<typeof query>) => {
      for await (const m of q) {
        if ("session_id" in m && m.session_id) sessionId = m.session_id;
        if (m.type === "assistant") {
          for (const b of m.message.content as any[]) {
            if (b.type === "tool_use") {
              toolNames.set(b.id, b.name);
              opts.onProgress({ kind: "tool", message: toolLabel(b.name) });
            } else if (b.type === "text" && b.text.trim()) {
              lastText = b.text.trim();
              opts.onProgress({ kind: "text", message: lastText });
            }
          }
        } else if (m.type === "user" && Array.isArray(m.message.content)) {
          for (const b of m.message.content as any[]) {
            if (b.type !== "tool_result" || !Array.isArray(b.content)) continue;
            if (!toolNames.get(b.tool_use_id)?.endsWith("export_shape")) continue;
            for (const c of b.content) {
              if (c.type === "image" && c.source?.type === "base64") {
                images.push({ data: Buffer.from(c.source.data, "base64"), mimeType: c.source.media_type, name: `nahled-${images.length + 1}.${extFor(c.source.media_type)}` });
              }
            }
          }
        } else if (m.type === "result") {
          if (m.subtype === "success") resultText = m.result;
          else resultText = `Úkol skončil chybou (${m.subtype}).`;
        }
      }
    };

    try {
      await consume(run(prev?.sessionId));
    } catch (err: any) {
      if (!prev?.sessionId) throw err;
      // The stored session may be gone (e.g. container recreated without the data volume) – start fresh.
      log.warn(`resume failed (${err.message}), starting a new session`);
      sessionId = "";
      await consume(run(undefined));
    }
    const state: SubscriptionState = { provider: "claude-subscription", sessionId };
    return { text: resultText || lastText || "Hotovo.", images, state };
  }
}
