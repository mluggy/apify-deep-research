export default {
  openai: {
    name: "OpenAI",
    link: "https://platform.openai.com/",
    models: {
      "o3-mini": {
        input: 1.1,
        output: 4.4,
        contextWindow: 200_000,
      },
    },
  },
  google: {
    name: "Google",
    link: "https://ai.google.dev/",
    models: {
      "gemini-2.0-flash": {
        input: 0.075,
        output: 0.3,
        contextWindow: 1_048_576,
      },
      "gemini-1.5-pro": {
        input: 1.25,
        output: 5.0,
        contextWindow: 2_097_152,
      },
    },
  },
  anthropic: {
    name: "Anthropic",
    link: "https://www.anthropic.com/api",
    models: {
      "claude-3-5-haiku-20241022": {
        input: 0.8,
        output: 4.0,
        contextWindow: 200_000,
      },
      "claude-3-5-sonnet-20241022": {
        input: 3.0,
        output: 15.0,
        contextWindow: 200_000,
      },
    },
  },
  deepseek: {
    name: "Deepseek",
    link: "https://platform.deepseek.com/api_keys",
    models: {
      "deepseek-chat": {
        input: 0.014,
        output: 0.28,
        contextWindow: 64_000,
      },
    },
  },
  xai: {
    name: "xAI",
    link: "https://x.ai/api",
    models: {
      "grok-2-1212": {
        input: 2.0,
        output: 10.0,
        contextWindow: 131_072,
      },
    },
  },
};
