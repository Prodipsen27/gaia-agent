import "dotenv/config";
import { ytTranscript } from "../../src/tools.js";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

async function run() {
  console.log("🧪 Testing yt_transcript with GitHub Inference...");
  
  const llm = new ChatOpenAI({
    configuration: { baseURL: "https://models.inference.ai.azure.com" },
    apiKey: process.env.GITHUB_TOKEN,
    modelName: "gpt-4o-mini",
  }).bindTools([ytTranscript]);

  const res = await llm.invoke([new HumanMessage("What is the transcript of https://www.youtube.com/watch?v=dQw4w9WgXcQ?")]);
  
  console.log("🤖 Agent Call:");
  console.log(JSON.stringify(res.tool_calls, null, 2));

  if (res.tool_calls?.[0]) {
    const toolRes = await ytTranscript.invoke(res.tool_calls[0].args);
    console.log("\n🛠️ Tool Result (snippet):");
    console.log(toolRes.substring(0, 500) + "...");
  }
}

run().catch(console.error);
