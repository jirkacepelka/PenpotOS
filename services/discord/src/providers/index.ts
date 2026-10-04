import type { Settings } from "@penpotos/shared";
import { AnthropicProvider } from "./anthropic.ts";
import { ClaudeSubscriptionProvider } from "./claude-subscription.ts";
import { OpenAICompatibleProvider } from "./openai.ts";
import type { Provider } from "./types.ts";

export function providerFor(settings: Settings): Provider {
  switch (settings.llm.provider) {
    case "claude-subscription":
      return new ClaudeSubscriptionProvider();
    case "openai-compatible":
      return new OpenAICompatibleProvider();
    default:
      return new AnthropicProvider();
  }
}

export * from "./types.ts";
