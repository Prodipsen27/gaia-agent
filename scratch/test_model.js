import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
dotenv.config();

const test = async () => {
  const model = new ChatOpenAI({
    modelName: "gpt-4o",
    apiKey: process.env.GITHUB_TOKEN,
    configuration: {
      baseURL: "https://models.inference.ai.azure.com",
    },
  });

  try {
    const res = await model.invoke("say hello");
    console.log("GPT-4o Response:", res.content);
  } catch (err) {
    console.error("GPT-4o Error:", err.message);
  }
};

test();
