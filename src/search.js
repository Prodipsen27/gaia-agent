import "./env.js";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY,
});

const groundingTool = {
    googleSearch: {},
};

const config = {
    tools: [groundingTool],
};

const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: "How many studio albums were published by Mercedes Sosa between 2000 and 2009 (included)? just give me the number",
    config,
});

console.log(response.text);