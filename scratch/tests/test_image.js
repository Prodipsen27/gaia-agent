import "dotenv/config";
import { analyzeImage } from "../../src/tools.js";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function run() {
  console.log("🧪 Testing analyze_image with GitHub Inference...");
  
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const imagePath = path.resolve(__dirname, "../../tmp/test_cat.png");
  
  const llm = new ChatOpenAI({
    configuration: { baseURL: "https://models.inference.ai.azure.com" },
    apiKey: process.env.GITHUB_TOKEN,
    modelName: "gpt-4o-mini", // Using gpt-4o-mini for agent reasoning
  }).bindTools([analyzeImage]);

  const res = await llm.invoke([new HumanMessage(`What is in the image at ${imagePath}?`)]);
  
  console.log("🤖 Agent Call:");
  console.log(JSON.stringify(res.tool_calls, null, 2));

  if (res.tool_calls?.[0]) {
    // This will use Gemini if GOOGLE_API_KEY is set, otherwise GitHub Inference, or Ollama
    const toolRes = await analyzeImage.invoke(res.tool_calls[0].args);
    console.log("\n🛠️ Tool Result:");
    console.log(toolRes);
  }
}

run().catch(console.error);
