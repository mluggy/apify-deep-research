import { ApifyClient } from "apify-client";
import { input, select, password } from "@inquirer/prompts";
import fs from "fs-extra";
import ora from "ora";
import { Research } from "./research.js";
import supportedModels from "./models.js";

// Global state
let stats = {
  startTime: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
  llmCost: 0,
  apifyCost: 0,
};

const spinner = ora();

// Status bar update function
function showStats() {
  const duration = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;
  const timeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}:${String(seconds).padStart(2, "0")}`;

  const totalCost = (stats.llmCost + stats.apifyCost).toFixed(3);

  const statsLine = `Tokens: ${stats.inputTokens.toLocaleString()} input & ${stats.outputTokens.toLocaleString()} output | LLM: $${stats.llmCost.toFixed(
    3
  )} | Apify: $${stats.apifyCost.toFixed(
    3
  )} | Total: $${totalCost} | Duration: ${timeStr}`;

  process.stdout.write(`\x1b[90m${statsLine}\x1b[0m\n\n`);
}

// Main function
async function main() {
  let config = await loadConfig();

  // Get Apify token
  while (!config.apify_api_token) {
    config.apify_api_token = await password({
      message: "Enter your Apify API token (https://www.apify.com?fpr=prsmf):",
      mask: "*",
    });
    await saveConfig(config);
  }

  // Create array of all models with their info
  const modelChoices = [];
  for (const [provider, info] of Object.entries(supportedModels)) {
    for (const [model, pricing] of Object.entries(info.models)) {
      modelChoices.push({
        provider,
        providerName: info.name,
        model,
        pricing,
      });
    }
  }

  // Format model choices for display
  const modelOptions = modelChoices.map((choice) => ({
    name: `[${choice.providerName}] ${choice.model}: $${choice.pricing.input}/M input & $${choice.pricing.output}/M output tokens`,
    value: choice.model,
    description:
      choice.model === config.selected_model ? "(current)" : undefined,
  }));

  // Select AI model
  console.log("\nAvailable AI Models:");
  const selectedModel = await select({
    message: "Select AI model:",
    choices: modelOptions,
    default: config.selected_model,
  });

  config.selected_model = selectedModel;
  await saveConfig(config);

  // Get provider API key if needed
  const provider = Object.entries(supportedModels).find(([_, info]) =>
    Object.keys(info.models).includes(config.selected_model)
  )[0];

  const providerKey = `${provider}_api_key`;
  const providerInfo = supportedModels[provider];
  while (!config[providerKey]) {
    config[providerKey] = await password({
      message: `Enter your ${providerInfo.name} API key (${providerInfo.link}):`,
      mask: "*",
      validate: (value) => {
        if (!value) {
          return `${providerInfo.name} API key is required to continue.`;
        }
        return true;
      },
    });
    await saveConfig(config);
  }

  // Get research subject (mandatory)
  let subject = await input({
    message: "\nEnter research subject:",
    validate: (value) => {
      if (!value.trim()) {
        return "Research subject is required to continue.";
      }
      return true;
    },
  });

  // Get research parameters
  const newBreadth = await input({
    message: `Number of search queries (1-20, default ${config.breadth || 5}):`,
    default: String(config.breadth || 5),
    validate: (value) => {
      const num = parseInt(value);
      if (isNaN(num) || num < 1 || num > 20) {
        return "Please enter a number between 1 and 20";
      }
      return true;
    },
  });
  config.breadth = parseInt(newBreadth);
  await saveConfig(config);

  const newDepth = await input({
    message: `Number of results per query (1-100, default ${
      config.depth || 10
    }):`,
    default: String(config.depth || 10),
    validate: (value) => {
      const num = parseInt(value);
      if (isNaN(num) || num < 1 || num > 100) {
        return "Please enter a number between 1 and 100";
      }
      return true;
    },
  });
  config.depth = parseInt(newDepth);
  await saveConfig(config);

  const newLocale = await input({
    message: `Research locale (default ${config.locale || "en-US"}):`,
    default: config.locale || "en-US",
    validate: (value) => {
      if (!/^[a-z]{2}-[A-Z]{2}$/.test(value)) {
        return "Please enter a valid locale (e.g. en-US)";
      }
      return true;
    },
  });
  config.locale = newLocale;
  await saveConfig(config);

  // Initialize clients
  const apifyClient = new ApifyClient({ token: config.apify_api_token });
  const research = new Research(config, apifyClient, stats, showStats);

  // Handle Ctrl+C to cancel last Apify run
  process.on("SIGINT", async () => {
    if (research.lastRunId) {
      console.log("\nCancelling current Apify run...");
      try {
        await apifyClient.run(research.lastRunId).abort({ gracefully: false });
        console.log(`Successfully cancelled Apify run ${research.lastRunId}`);
      } catch (error) {
        console.error(
          `Failed to cancel Apify run ${research.lastRunId}:`,
          error.message
        );
      }
    } else {
      console.log("\nNo active Apify run to cancel");
    }

    process.exit(0);
  });

  try {
    // Generate and ask follow-up questions
    spinner.start();
    spinner.text = "Generating follow-up questions";
    const questions = await research.generateQuestions(subject);
    spinner.stop();

    console.log(`\nGenerated ${questions.length} questions`);
    const answers = await research.askQuestions(questions);
    showStats();

    // Generate and execute search queries
    spinner.start();
    spinner.text = "Generating search queries";
    const queries = await research.generateSearchQueries(subject, answers);
    spinner.stop();

    console.log(`Generated ${queries.length} search queries`);
    queries.forEach((q) => {
      process.stdout.write(`\x1b[2K\r\x1b[32m✓\x1b[0m \x1b[1m${q}\x1b[0m\n`);
    });

    showStats();

    spinner.start();
    spinner.text = `Searching ${queries.length} queries for unique URLs`;
    const urls = await research.searchQueries(queries);
    spinner.stop();

    // Display URLs
    console.log(`Found ${urls.length} URLs`);
    urls.forEach((u) => {
      process.stdout.write(`\x1b[2K\r\x1b[32m✓\x1b[0m \x1b[1m${u}\x1b[0m\n`);
    });

    showStats();

    // Crawl URLs and gather content
    spinner.start();
    spinner.text = `Fetching ${urls.length} URLs`;
    const contents = await research.crawlUrls(urls);
    spinner.stop();

    console.log(`Fetched ${contents.length} URLs`);

    showStats();

    // Generate chapters
    spinner.start();
    spinner.text = "Generating list of chapters";
    const chapters = await research.generateChapters(
      subject,
      answers,
      contents
    );
    spinner.stop();

    // Display chapters
    console.log("Generated list of chapters");
    chapters.forEach((c) => {
      process.stdout.write(
        `\x1b[2K\r\x1b[32m✓\x1b[0m ${c.number}. ${c.title}\n`
      );
    });

    showStats();

    // Generate chapters content
    const chapterContents = [];
    let previousText = "";
    for (const chapter of chapters) {
      spinner.start();
      spinner.text = `Generating chapter ${chapter.number} of ${chapters.length}`;
      const content = await research.generateChapterContent(
        subject,
        chapter,
        chapters,
        contents,
        previousText
      );
      previousText += content.text;
      chapterContents.push({
        number: chapter.number,
        title: chapter.title,
        content: content.text,
        summary: content.summary,
      });
      spinner.stop();

      process.stdout.write(
        `\x1b[2K\r\x1b[32m✓\x1b[0m \x1b[1m${chapter.number}. ${chapter.title}\x1b[0m\n${content.summary}\n`
      );

      showStats();
    }

    // Generate final summary
    spinner.start();
    spinner.text = "Generating final summary";
    const summary = await research.generateSummary(subject, chapterContents);
    spinner.stop();

    showStats();

    // Generate documents
    spinner.start();
    spinner.text = "Generating final documents";
    const { paths } = await research.generateDocument(
      subject,
      summary.abstract,
      chapterContents,
      summary.conclusions
    );
    spinner.stop();

    spinner.succeed(
      `Research complete! Files saved:\n` +
        `  - ${paths.markdown}\n` +
        `  - ${paths.html}`
    );

    showStats();
  } catch (error) {
    spinner.fail("Research failed");
    console.error(error);
    showStats();
  }
}

// Load or create config
async function loadConfig() {
  try {
    return await fs.readJSON(".config.json");
  } catch {
    return {};
  }
}

// Save config
async function saveConfig(config) {
  await fs.writeJSON(".config.json", config, { spaces: 2 });
}

main().catch(console.error);
