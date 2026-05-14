import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

async function listModels() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    // There is no direct listModels in the main export of @google/generative-ai for standard API?
    // Actually there is a listModels method in the GenerativeAI instance if it was there?
    // No, it's usually part of the admin/service client.
    
    // Let's try some common variations
    const models = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro", "gemini-1.5-flash-8b"];
    for (const m of models) {
      try {
        const model = "gemini-3-flash-preview";
        const result = await model.generateContent("test");
        console.log(`✅ Model ${m} works!`);
        break;
      } catch (e) {
        console.log(`❌ Model ${m} failed: ${e.message}`);
      }
    }
  } catch (err) {
    console.error("Caught error:", err);
  }
}

listModels();
