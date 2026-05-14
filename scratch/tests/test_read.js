import "dotenv/config";
import { readFile } from "../../src/tools.js";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";

async function run() {
  console.log("🧪 Testing read_file with GitHub Inference...");

  const testFile = path.resolve("tmp/test.txt");
  fs.writeFileSync(testFile, "GAIA Benchmark Test Content", "utf-8");
  
  const llm = new ChatOpenAI({
    configuration: { baseURL: "https://models.inference.ai.azure.com" },
    apiKey: process.env.GITHUB_TOKEN,
    modelName: "gpt-4o-mini",
  }).bindTools([readFile]);

  const res = await llm.invoke([new HumanMessage(`Read the file at ${testFile}`)]);
  
  console.log("🤖 Agent Call:");
  console.log(JSON.stringify(res.tool_calls, null, 2));

  if (res.tool_calls?.[0]) {
    const toolRes = await readFile.invoke(res.tool_calls[0].args);
    console.log("\n🛠️ Tool Result:");
    console.log(toolRes);
  }
}

run().catch(console.error);
