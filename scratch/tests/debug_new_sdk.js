import { createGenerativeAI } from "@google/genai"; // Wait, check the correct import for @google/genai
import dotenv from "dotenv";
dotenv.config();

// The new SDK usually has a different initialization.
// Let's check common patterns for @google/genai
// Based on typical Google AI SDKs:
import { GenAI } from "@google/genai"; 

async function testNewSDK() {
  try {
    console.log("Initializing New SDK (@google/genai)...");
    const ai = new GenAI({
      apiKey: process.env.GOOGLE_API_KEY,
    });
    
    // User's snippet:
    // const response = await ai.models.generateContent({
    //   model: "gemini-3-flash-preview",
    //   contents: contents,
    // });
    
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash", // Try 2.0 or 1.5
      contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
    });
    
    console.log("Response:", response.text);
  } catch (err) {
    console.error("Caught error:", err);
    console.log("Trying alternative import/init...");
  }
}

testNewSDK();
