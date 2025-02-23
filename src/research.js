import fs from "fs-extra";
import { createHash } from "crypto";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createXai } from "@ai-sdk/xai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { input } from "@inquirer/prompts";
import path from "path";
import MarkdownIt from "markdown-it";
import { z } from "zod";
import supportedModels from "./models.js";
import { estimateTokens, truncateContentsToFit } from "./tokenizer.js";

// Schemas
export const QuestionsSchema = z.object({
  questions: z.array(z.string()).describe("Follow-up yes/no questions"),
});

export const QueriesSchema = z.object({
  queries: z.array(z.string()).describe("Search queries"),
});

export const ChaptersSchema = z.object({
  chapters: z
    .array(
      z.object({
        number: z.number().describe("Chapter number"),
        title: z.string().describe("Chapter title"),
      })
    )
    .describe("Chapters with numbers and titles"),
});

export const ChapterContentSchema = z.object({
  summary: z.string().describe("Chapter summary"),
  paragraphs: z
    .array(
      z.object({
        text: z.string().describe("Paragraph text"),
        references: z
          .array(z.number().describe("Content reference number"))
          .describe("Array of content reference numbers used in the paragraph"),
      })
    )
    .describe(
      "Array of paragraph texts with references to the provided contents"
    ),
});

export const ResearchSummarySchema = z.object({
  abstract: z.string().describe("Abstract"),
  conclusions: z.string().describe("Conclusions"),
});

export class Research {
  constructor(config, apifyClient, stats, showStats) {
    this.config = config;
    this.apifyClient = apifyClient;
    this.stats = stats;
    this.showStats = showStats;
    this.cache = {};
    this.references = new Map();
    this.usedReferences = [];
    this.lastRunId = null;

    // Initialize the appropriate AI provider
    const provider = this.getProviderKey();
    this.provider = provider;
  }

  getProviderKey() {
    return Object.entries(supportedModels).find(([_, info]) =>
      Object.keys(info.models).includes(this.config.selected_model)
    )[0];
  }

  getAIProvider() {
    const apiKey = this.config[`${this.provider}_api_key`];
    if (!apiKey) {
      throw new Error(`API key for ${this.provider} is missing`);
    }

    switch (this.provider) {
      case "openai":
        const openai = createOpenAI({ apiKey });
        return openai(this.config.selected_model);
      case "anthropic":
        const anthropicAI = createAnthropic({ apiKey });
        return anthropicAI(this.config.selected_model);
      case "google":
        const googleAI = createGoogleGenerativeAI({ apiKey });
        return googleAI(this.config.selected_model);
      case "xai":
        const xaiAI = createXai({ apiKey });
        return xaiAI(this.config.selected_model);
      case "deepseek":
        const deepseekAI = createDeepSeek({ apiKey });
        return deepseekAI(this.config.selected_model);
      default:
        throw new Error(`Unsupported AI provider: ${this.provider}`);
    }
  }

  updateTokenUsage(usage) {
    if (usage) {
      const modelPricing =
        supportedModels[this.getProviderKey()].models[
          this.config.selected_model
        ];

      this.stats.inputTokens += usage.promptTokens || 0;
      this.stats.outputTokens += usage.completionTokens || 0;

      // Calculate costs in dollars (divide by 1M tokens and multiply by cost)
      this.stats.llmCost +=
        ((usage.promptTokens || 0) / 1_000_000) * modelPricing.input +
        ((usage.completionTokens || 0) / 1_000_000) * modelPricing.output;
    }
  }

  async generateQuestions(subject) {
    const prompt = `Generate up to ${this.config.breadth} yes/no follow-up questions aimed at clarifying the research direction, what to include and exclude when researching: ${subject}.`;

    try {
      const { object, usage } = await generateObject({
        model: this.getAIProvider(),
        schema: QuestionsSchema,
        prompt,
      });

      this.updateTokenUsage(usage);
      // Add a static open-ended question
      return [
        ...object.questions,
        "What other aspects of this topic would you like to explore in depth?",
      ];
    } catch (error) {
      throw new Error(`Error generating follow-up questions: ${error.message}`);
    }
  }

  async askQuestions(questions) {
    const answers = [];
    for (const question of questions) {
      const answer = await input({
        message: question,
      });
      answers.push({ question, answer });
    }
    return answers;
  }

  async generateSearchQueries(subject, followups) {
    const followupText = followups
      .map(
        (f, i) =>
          `<followup${i + 1}>\nQuestion: ${f.question}\nAnswer: ${
            f.answer
          }\n</followup${i + 1}>`
      )
      .join("\n\n");

    const prompt = `Generate ${this.config.breadth} or less search engine queries to aid research on the subject of "${subject}". Queries should address the nuances highlighted in these follow-up questions:\n\n${followupText}`;

    const { object, usage } = await generateObject({
      model: this.getAIProvider(),
      schema: QueriesSchema,
      prompt,
    });

    this.updateTokenUsage(usage);
    return object.queries;
  }

  async searchQueries(queries) {
    const [languageCode, countryCode] = this.config.locale.split("-");

    const results = [];
    const run = await this.apifyClient
      .actor("apify/google-search-scraper")
      .call({
        queries: queries.join("\n"),
        // google uses iw for hebrew
        languageCode: languageCode === "he" ? "iw" : languageCode,
        countryCode: countryCode.toLowerCase(),
        resultsPerPage: this.config.depth,
        maxPagesPerQuery: 1,
      });

    this.lastRunId = run.id;

    const dataset = await this.apifyClient
      .dataset(run.defaultDatasetId)
      .listItems();
    this.stats.apifyCost += run.usageTotalUsd || 0;

    results.push(...dataset.items.flatMap((d) => d.organicResults || []));

    return [...new Set(results.map((r) => r.url))];
  }

  async crawlUrls(urls) {
    await fs.ensureDir("cache");
    const uncachedUrls = [];

    for (const url of urls) {
      const md5 = createHash("md5")
        .update(url.toLowerCase().trim())
        .digest("hex");
      const cachePath = path.join("cache", `url_${md5}.json`);

      if (await fs.pathExists(cachePath)) {
        const cached = await fs.readJSON(cachePath);
        this.cache[url] = cached;
        this.references.set(url, {
          title: cached.metadata?.title || url,
          url: url,
        });
      } else {
        uncachedUrls.push(url);
      }
    }

    if (uncachedUrls.length > 0) {
      const run = await this.apifyClient
        .actor("apify/website-content-crawler")
        .call({
          startUrls: uncachedUrls.map((url) => ({ url })),
          maxCrawlDepth: 0,
          maxCrawlPages: uncachedUrls.length,
          initialConcurrency: 10,
          requestTimeoutSecs: 30,
          maxRequestRetries: 1,
          saveScreenshots: false,
          saveHtml: false,
          saveMarkdown: false,
        });

      this.lastRunId = run.id;

      const dataset = await this.apifyClient
        .dataset(run.defaultDatasetId)
        .listItems();
      this.stats.apifyCost += run.usageTotalUsd || 0;

      for (const item of dataset.items) {
        const md5 = createHash("md5")
          .update(item.url.toLowerCase().trim())
          .digest("hex");
        await fs.writeJSON(path.join("cache", `url_${md5}.json`), item);
        this.cache[item.url] = item;
        this.references.set(item.url, {
          title: item.metadata?.title || item.url,
          url: item.url,
        });
      }
    }

    return Object.values(this.cache);
  }

  async generateChapters(subject, followups, contents) {
    const followupText = followups
      .map(
        (f, i) =>
          `<followup${i + 1}>\nQuestion: ${f.question}\nAnswer: ${
            f.answer
          }\n</followup${i + 1}>`
      )
      .join("\n\n");

    const contentText = contents
      .map((c, i) => `<content${i + 1}>\n${c.text}\n</content${i + 1}>`)
      .join("\n\n");

    const prompt = `Generate a list of up to ${this.config.breadth} numbered chapters for a deep research paper on the subject of "${subject}". Each chapter should have a number and title. Chapters should cover the entire subject, including followups, based on the contents provided. Note that the locale is ${this.config.locale}.\n\n${followupText}\n\n${contentText}`;

    const { object, usage } = await generateObject({
      model: this.getAIProvider(),
      schema: ChaptersSchema,
      prompt,
    });

    this.updateTokenUsage(usage);
    return object.chapters;
  }

  async generateChapterContent(
    subject,
    chapter,
    chapters,
    contents,
    previousChapter = ""
  ) {
    const chaptersText = chapters
      .map((c) => `${c.number}. ${c.title}`)
      .join("\n");

    const basePrompt = `For a comprehensive research paper on "${subject}" that covers the following chapters, generate the complete text for chapter ${chapter.number}. You will receive a list of chapters, extensive contents to work with, and previous chapter text (previous_chapter). Use the provided contents and previous_chapter as your basis, ensuring that previous_chapter is only repeated when absolutely necessary. The chapter should be written in the ${this.config.locale} locale and cover the chapter in its entirety.

Your response should include:
1. A summary of the chapter
2. An array of paragraphs, where each paragraph has:
   - The paragraph text
   - An array of reference numbers (1-based) to the content items used in that paragraph

Don't include the chapter title or number in your responses.

<chapters>
${chaptersText}
</chapters>

<previous_chapter>
${previousChapter}
</previous_chapter>`;

    // Get model's context window
    const modelInfo =
      supportedModels[this.getProviderKey()].models[this.config.selected_model];
    const contextWindow = modelInfo.contextWindow;

    // Truncate contents to fit within context window
    const truncatedContents = truncateContentsToFit(
      basePrompt,
      contents,
      contextWindow
    );

    const contentsText = truncatedContents
      .map((c, i) => `<content${i + 1}>\n${c.text}\n</content${i + 1}>`)
      .join("\n\n");

    const prompt = `${basePrompt}\n\n${contentsText}`;

    const { object, usage } = await generateObject({
      model: this.getAIProvider(),
      schema: ChapterContentSchema,
      prompt,
    });

    // Process references and build content in one pass
    const processedParagraphs = object.paragraphs.map((para) => {
      // Track references and build reference links
      const refs = para.references
        .map((refNum) => {
          const contentIndex = refNum - 1;
          if (contentIndex >= 0 && contentIndex < truncatedContents.length) {
            const url = truncatedContents[contentIndex].url;
            // Add to global references if not already there
            if (!this.usedReferences.includes(url)) {
              this.usedReferences.push(url);
            }
            const refIndex = this.usedReferences.indexOf(url) + 1;
            return `[(${refIndex})](${url})`;
          }
          return null;
        })
        .filter(Boolean);

      // Return paragraph text with references
      return para.text + (refs.length > 0 ? ` ${refs.join("")}` : "");
    });

    this.updateTokenUsage(usage);
    return {
      summary: object.summary,
      text: processedParagraphs.join("\n\n"),
    };
  }

  async generateSummary(subject, chapters) {
    const chaptersText = chapters
      .map(
        (c, i) =>
          `<chapter${i + 1}>\nTitle: ${c.title}\nSummary: ${
            c.summary
          }\n</chapter${i + 1}>`
      )
      .join("\n\n");

    const prompt = `Generate an abstract and conclusions for a research paper on "${subject}" based on the following chapter summaries. Texts should be written in the ${this.config.locale} locale.\n\n${chaptersText}`;

    const { object, usage } = await generateObject({
      model: this.getAIProvider(),
      schema: ResearchSummarySchema,
      prompt,
    });

    this.updateTokenUsage(usage);
    return object;
  }

  async generateDocument(subject, abstract, chapters, conclusions) {
    await fs.ensureDir("reports");

    const slug = subject
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/(^_|_$)/g, "");

    const toc = [
      ...chapters.map((c) => `${c.number}. [${c.title}](#chapter-${c.number})`),
    ].join("\n");

    const orderedReferences = this.usedReferences
      .map((url, index) => {
        const ref = this.references.get(url);
        return `- [(${index + 1})](${url}) ${ref.title}`;
      })
      .join("\n");

    const content = [
      `# ${subject}`,
      `\n*Generated on ${
        new Date().toISOString().split("T")[0]
      } by [apify-deep-research](https://github.com/mluggy/apify-deep-research) (not for commercial use)*\n`,
      toc,
      "\n",
      `*${abstract}*`,
      ...chapters.map(
        (c) =>
          `\n<h2 id='chapter-${c.number}'>${c.title}</h2>\n\n*${c.summary}*\n\n${c.content}`
      ),
      "\n---\n",
      `*${conclusions}*`,
      "\n---\n",
      orderedReferences,
    ].join("\n");

    const mdPath = path.join("reports", `${slug}.md`);
    await fs.writeFile(mdPath, content);

    // Configure markdown-it
    const md = new MarkdownIt({
      html: true,
      breaks: true,
      linkify: true,
      typographer: true,
    });

    // Process the content to convert markdown reference links to HTML superscript links
    let htmlContent = content;
    // Replace inline references [(X)](url) with superscript links
    htmlContent = htmlContent.replace(
      /\[\((\d+)\)\]\(([^)]+)\)/g,
      '<sup><a href="$2">$1</a></sup>'
    );

    // Convert markdown to HTML
    htmlContent = md.render(htmlContent);

    // Check if the locale is RTL
    const [languageCode] = this.config.locale.split("-");
    const rtlLanguages = ["ar", "he", "iw"]; // iw is the old code for Hebrew
    const isRtl = rtlLanguages.includes(languageCode);
    const dirAttribute = isRtl ? ' dir="rtl"' : "";

    const html = `<!DOCTYPE html>
<html${dirAttribute}>
<head>
  <meta charset="UTF-8">
  <title>${subject}</title>
  <style>
    body { max-width: 800px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, system-ui, sans-serif; line-height: 1.6; }
    code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
    pre { background: #f4f4f4; padding: 1em; overflow-x: auto; }
    a { color: #0366d6; text-decoration: underline; }
    h1, h2 { border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
    .markdown-body { padding: 2em; }
    em { color: #666; }
    ul, ol { padding-left: 2em; }
    li { margin: 0.5em 0; }
    :target { 
      scroll-margin-top: 2em;
      background: #ffffd8;
      padding: 0.2em;
    }
    hr {
      border: 0;
      height: 1px;
      background: #eaecef;
      margin: 2em 0;
    }
    sup a {
      text-decoration: none;
      padding: 0 2px;
    }
  </style>
</head>
<body class="markdown-body">
  ${htmlContent}
</body>
</html>`;

    const htmlPath = path.join("reports", `${slug}.html`);
    await fs.writeFile(htmlPath, html);

    return {
      content,
      paths: {
        markdown: mdPath,
        html: htmlPath,
      },
    };
  }
}
