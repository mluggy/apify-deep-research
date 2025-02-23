// Simple tokenizer utility based on GPT-3 tokenizer approximation
// This is a rough estimate - actual token counts may vary by model

import { encode } from "gpt-tokenizer";

export function estimateTokens(text) {
  if (!text) return 0;
  return encode(text).length;
}

export function truncateContentsToFit(prompt, contents, contextWindow) {
  const baseTokens = estimateTokens(prompt);
  let availableTokens = contextWindow - baseTokens;

  // If we already exceed the context window with just the base prompt, return empty contents
  if (availableTokens <= 0) {
    return [];
  }

  const truncatedContents = [];
  let totalTokens = baseTokens;

  for (const content of contents) {
    const contentText = `<content${truncatedContents.length + 1}>\n${
      content.text
    }\n</content${truncatedContents.length + 1}>`;
    const contentTokens = estimateTokens(contentText);

    if (totalTokens + contentTokens <= contextWindow) {
      truncatedContents.push(content);
      totalTokens += contentTokens;
    } else {
      break;
    }
  }

  return truncatedContents;
}
