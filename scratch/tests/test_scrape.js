import dotenv from "dotenv";
dotenv.config();

import { scrapeWebsite } from "../../src/tools.js";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

async function run() {
  try {
    console.log("🧪 Testing scrape_website with GitHub Inference...");

    const llm = new ChatOpenAI({
      configuration: {
        baseURL: "https://models.inference.ai.azure.com",
      },
      apiKey: process.env.GITHUB_TOKEN,
      modelName: "gpt-4o-mini",
      temperature: 0,
    });

    // Bind tools separately
    const llmWithTools = llm.bindTools([scrapeWebsite]);

    const response = await llmWithTools.invoke([
      new HumanMessage(
        "Scrape the content of https://example.com and summarize it."
      ),
    ]);

    console.log("\n🤖 Full Response:");
    console.log(response);

    // Check tool calls safely
    if (response.tool_calls && response.tool_calls.length > 0) {
      console.log("\n🔧 Tool Calls:");
      console.log(JSON.stringify(response.tool_calls, null, 2));

      const toolCall = response.tool_calls[0];

      // Execute tool manually
      const toolResult = await scrapeWebsite.invoke(toolCall.args);

      console.log("\n🛠️ Tool Result (snippet):");
      console.log(toolResult.slice(0, 500) + "...");
    } else {
      console.log("\n⚠️ No tool calls were made.");
      console.log("Model Response:", response.content);
    }
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

run();