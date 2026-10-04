import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@penpotos/shared";
import { PenpotMcp } from "../mcp-client.ts";
import { extFor, toolLabel, type Provider, type RunOptions, type TaskResult } from "./types.ts";

const log = createLogger("anthropic");

/** Models that support the server-side refusal fallback ("default" routing). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

interface AnthropicState {
  provider: "anthropic";
  messages: Anthropic.Beta.BetaMessageParam[];
}

/**
 * Agent loop on the Anthropic Messages API with the PenpotOS MCP tools.
 * History is append-only (assistant turns are stored exactly as returned).
 */
export class AnthropicProvider implements Provider {
  async run(opts: RunOptions): Promise<TaskResult> {
    const { settings } = opts;
    if (!settings.llm.anthropicApiKey) throw new Error("V admin dashboardu chybí Anthropic API klíč.");
    const client = new Anthropic({ apiKey: settings.llm.anthropicApiKey });
    const mcp = new PenpotMcp(opts.actor, opts.storageKey);
    try {
      const mcpTools = await mcp.tools();
      const tools: Anthropic.Beta.BetaTool[] = mcpTools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      }));
      const prev = (opts.state as AnthropicState | undefined)?.provider === "anthropic" ? (opts.state as AnthropicState) : undefined;
      const messages: Anthropic.Beta.BetaMessageParam[] = prev ? [...prev.messages] : [];

      const userContent: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const url of opts.input.imageUrls) userContent.push({ type: "image", source: { type: "url", url } });
      userContent.push({ type: "text", text: opts.input.text });
      messages.push({ role: "user", content: userContent });

      const images: TaskResult["images"] = [];
      const model = settings.llm.model;
      const useFallback = FALLBACK_MODELS.has(model);
      const isHaiku = model.startsWith("claude-haiku");
      let finalText = "";

      for (let turn = 0; turn < settings.llm.maxTurns; turn++) {
        const params: any = {
          model,
          max_tokens: 64000,
          system: [{ type: "text", text: opts.systemPrompt, cache_control: { type: "ephemeral" } }],
          tools,
          messages,
          ...(isHaiku ? {} : { thinking: { type: "adaptive" }, output_config: { effort: settings.llm.effort } }),
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        };
        const stream = client.beta.messages.stream(params, { signal: opts.signal });
        const response = await stream.finalMessage();

        if (response.stop_reason === "refusal") {
          messages.push({ role: "assistant", content: response.content as any });
          finalText = "Model tento požadavek odmítl zpracovat (bezpečnostní filtr). Zkus ho prosím přeformulovat.";
          break;
        }
        messages.push({ role: "assistant", content: response.content as any });
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (text) {
          finalText = text;
          if (response.stop_reason === "tool_use") opts.onProgress({ kind: "text", message: text });
        }
        if (response.stop_reason === "pause_turn") continue;
        if (response.stop_reason === "max_tokens") {
          finalText = (finalText ? finalText + "\n\n" : "") + "(Odpověď byla zkrácena – dosažen limit délky.)";
          break;
        }
        if (response.stop_reason !== "tool_use") break;

        const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
        const results = await Promise.all(
          toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
            opts.onProgress({ kind: "tool", message: toolLabel(tu.name) });
            try {
              const out = await mcp.call(tu.name, (tu.input ?? {}) as Record<string, unknown>);
              const content: Anthropic.Beta.BetaToolResultBlockParam["content"] = [];
              if (out.text) content.push({ type: "text", text: out.text });
              for (const img of out.images) {
                content.push({ type: "image", source: { type: "base64", media_type: img.mimeType as any, data: img.data } });
                if (tu.name === "export_shape") {
                  images.push({ data: Buffer.from(img.data, "base64"), mimeType: img.mimeType, name: `nahled-${images.length + 1}.${extFor(img.mimeType)}` });
                }
              }
              if (!content.length) content.push({ type: "text", text: "(no output)" });
              return { type: "tool_result", tool_use_id: tu.id, content, is_error: out.isError || undefined };
            } catch (err: any) {
              log.warn(`tool ${tu.name} failed: ${err.message}`);
              return { type: "tool_result", tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true };
            }
          }),
        );
        // All tool results of one assistant turn go back in a single user message.
        messages.push({ role: "user", content: results });
        if (turn === settings.llm.maxTurns - 1) {
          finalText = (finalText ? finalText + "\n\n" : "") + "(Dosažen maximální počet kroků – úkol možná není dokončený.)";
        }
      }
      // History stays append-only (editing earlier turns would invalidate preserved thinking blocks).
      const state: AnthropicState = { provider: "anthropic", messages };
      return { text: finalText || "Hotovo.", images, state };
    } finally {
      await mcp.close();
    }
  }
}
