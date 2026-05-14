import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
dotenv.config();

const test = async (modelName) => {
  const model = new ChatOpenAI({
    modelName: modelName,
    apiKey: process.env.GITHUB_TOKEN,
    configuration: {
      baseURL: "https://models.inference.ai.azure.com",
    },
  });

  const longPrompt = "A".repeat(30000); // approx 7.5k tokens
  try {
    const res = await model.invoke(longPrompt);
    console.log(`${modelName} Response length:`, res.content.length);
  } catch (err) {
    console.error(`${modelName} Error:`, err.message);
  }
};

const run = async () => {
    await test("gpt-4o");
    await test("gpt-4o-mini");
}

run();
