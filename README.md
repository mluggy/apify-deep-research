# Apify Deep Research

A tool for generating comprehensive research reports using [Apify](https://www.apify.com?fpr=prsmf) and your favorite LLM model.

![Demo](demo.gif)

## Quick Start

```bash
# Run locally
npm start
```

## Configuration

You'll need to provide:

1. Your [Apify](https://www.apify.com?fpr=prsmf) API key
2. One of the supported LLM API keys (see below)

## Supported LLM Models

### [OpenAI](https://platform.openai.com/)

- O3-Mini

### [Google](https://ai.google.dev/)

- Gemini 2.0 Flash
- Gemini 1.5 Pro

### [Anthropic](https://www.anthropic.com/api)

- Claude 3.5 Haiku
- Claude 3.5 Sonnet

### [Deepseek](https://platform.deepseek.com/api_keys)

- Deepseek V3

### [xAI](https://x.ai/api)

- Grok 2.1212

## Usage

1. Run the tool
2. Enter your [Apify](https://www.apify.com?fpr=prsmf) API key when prompted
3. Choose your preferred LLM provider and enter the corresponding API key
4. Follow the prompts to refine and generate your research report
5. View the report in Markdown or HTML format

## License

This project is free for personal, non-commercial use only. For commercial use, please contact me on [LinkedIn](https://linkedin.com/in/mluggy) or [X/Twitter](https://x.com/mluggy).

## Important Precautions

**Please be aware of the following important considerations:**

⚠️ **Cost Implications**: This tool incurs real costs when running, especially when using high breadth and depth settings.

⚠️ **Keys Storage**: While your API keys are never shared or transmitted elsewhere, please be aware they are locally stored in a `.config.json` file.

## Disclaimer

The generated research reports are for informational purposes only. Always verify the information and consult appropriate experts before making any decisions based on the generated content.
