import OpenAI from "openai";
import { createLogger } from "@penpotos/shared";
import { PenpotMcp } from "../mcp-client.ts";
import { extFor, toolLabel, type Provider, type RunOptions, type TaskResult } from "./types.ts";

const log = createLogger("openai-compatible");

interface OpenAIState {
  provider: "openai-compatible";
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
}

/** Agent loop for OpenAI-compatible chat-completions APIs (OpenRouter, Ollama, OpenAI, …). */
export class OpenAICompatibleProvider implements Provider {
  async run(opts: RunOptions): Promise<TaskResult> {
    const { settings } = opts;
    const client = new OpenAI({ baseURL: settings.llm.openaiBaseUrl, apiKey: settings.llm.openaiApiKey || "none" });
    const mcp = new PenpotMcp(opts.actor, opts.storageKey);
    try {
      const tools: OpenAI.Chat.ChatCompletionTool[] = (await mcp.tools()).map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema },
      }));
      const prev = (opts.state as OpenAIState | undefined)?.provider === "openai-compatible" ? (opts.state as OpenAIState) : undefined;
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = prev ? [...prev.messages] : [{ role: "system", content: opts.systemPrompt }];
      const userParts: OpenAI.Chat.ChatCompletionContentPart[] = opts.input.imageUrls.map((url) => ({ type: "image_url", image_url: { url } }));
      userParts.push({ type: "text", text: opts.input.text });
      messages.push({ role: "user", content: userParts });

      const images: TaskResult["images"] = [];
      let finalText = "";
      for (let turn = 0; turn < settings.llm.maxTurns; turn++) {
        const res = await client.chat.completions.create({ model: settings.llm.openaiModel, messages, tools }, { signal: opts.signal });
        const msg = res.choices[0]?.message;
        if (!msg) break;
        messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
        if (msg.content) finalText = msg.content;
        const calls = msg.tool_calls ?? [];
        if (!calls.length) break;
        if (msg.content) opts.onProgress({ kind: "text", message: msg.content });
        const followUpImages: OpenAI.Chat.ChatCompletionContentPart[] = [];
        for (const call of calls) {
          if (call.type !== "function") continue;
          opts.onProgress({ kind: "tool", message: toolLabel(call.function.name) });
          let content: string;
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            const out = await mcp.call(call.function.name, args);
            content = (out.isError ? "ERROR: " : "") + (out.text || (out.images.length ? "(image attached below)" : "(no output)"));
            for (const img of out.images) {
              followUpImages.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
              if (call.function.name === "export_shape") {
                images.push({ data: Buffer.from(img.data, "base64"), mimeType: img.mimeType, name: `nahled-${images.length + 1}.${extFor(img.mimeType)}` });
              }
            }
          } catch (err: any) {
            log.warn(`tool ${call.function.name} failed: ${err.message}`);
            content = `ERROR: ${err.message}`;
          }
          messages.push({ role: "tool", tool_call_id: call.id, content });
        }
        // Tool messages cannot carry images in the chat-completions format; show them in a user message.
        if (followUpImages.length) messages.push({ role: "user", content: [{ type: "text", text: "Exported images:" }, ...followUpImages] });
      }
      return { text: finalText || "Hotovo.", images, state: { provider: "openai-compatible", messages } satisfies OpenAIState };
    } finally {
      await mcp.close();
    }
  }
}
