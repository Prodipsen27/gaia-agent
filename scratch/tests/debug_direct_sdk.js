import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

async function testDirectSDK() {
  try {
    console.log("Initializing Direct SDK...");
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    console.log("Generating content...");
    const result = await model.generateContent("Say hello");
    const response = await result.response;
    console.log("Response:", response.text());
  } catch (err) {
    console.error("Caught error:", err);
  }
}

testDirectSDK();
