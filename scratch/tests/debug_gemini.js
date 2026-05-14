import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import dotenv from "dotenv";
dotenv.config();

async function testGemini() {
  try {
    console.log("Initializing Gemini...");
    console.log("API Key length:", process.env.GOOGLE_API_KEY?.length);
    
    const model = new ChatGoogleGenerativeAI({
      model: "gemini-1.5-flash",
      apiKey: process.env.GOOGLE_API_KEY,
    });
    
    console.log("Invoking model...");
    const response = await model.invoke("Say hello");
    console.log("Response:", response.content);
  } catch (err) {
    console.error("Caught error:", err);
  }
}

testGemini();
