import "dotenv/config";
import { app } from "../../src/graph.js";
import { HumanMessage } from "@langchain/core/messages";

async function testAgent() {
  console.log("🧪 Testing Gemini Agent with gemini-3-flash-preview...");
  
  const initialState = {
    messages: [
      new HumanMessage("Search for the current price of Bitcoin and then calculate how much 0.5 BTC is worth in USD.")
    ],
    task_id: "test-task-1",
    question: "Search for the current price of Bitcoin and then calculate how much 0.5 BTC is worth in USD.",
  };

  try {
    const result = await app.invoke(initialState, { recursionLimit: 20 });
    console.log("\n✨ Final Result:");
    console.log(result.final_answer);
  } catch (err) {
    console.error("💥 Agent execution failed:", err);
  }
}

testAgent();
