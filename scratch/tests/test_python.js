import "dotenv/config";
import { executePython } from "../../src/tools.js";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

async function run() {
  console.log("🧪 Testing execute_python with GitHub Inference...");
  
  const llm = new ChatOpenAI({
    configuration: { baseURL: "https://models.inference.ai.azure.com" },
    apiKey: process.env.GITHUB_TOKEN,
    modelName: "gpt-4o-mini",
  }).bindTools([executePython]);

  const res = await llm.invoke([new HumanMessage("Calculate the 10th Fibonacci number using Python.")]);
  
  console.log("🤖 Agent Call:");
  console.log(JSON.stringify(res.tool_calls, null, 2));

  if (res.tool_calls?.[0]) {
    const toolRes = await executePython.invoke(res.tool_calls[0].args);
    console.log("\n🛠️ Tool Result:");
    console.log(toolRes);
  }
}

run().catch(console.error);
