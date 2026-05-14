import "dotenv/config";
import { 
  webSearch, 
  scrapeWebsite, 
  executePython, 
  readFile, 
  ytTranscript, 
  analyzeImage 
} from "../src/tools.js";
import fs from "node:fs";
import path from "node:path";

async function testTools() {
  console.log("🧪 Testing GAIA Tools...\n");

  // 1. Test execute_python
  console.log("--- Testing execute_python ---");
  try {
    const result = await executePython.invoke({ code: "print(1 + 1)" });
    console.log("Result:", result);
    if (result.trim() === "2") console.log("✅ Python works.");
    else console.log("❌ Python output mismatch.");
  } catch (e) {
    console.log("❌ Python failed:", e.message);
  }

  // 2. Test web_search
  console.log("\n--- Testing web_search ---");
  try {
    const result = await webSearch.invoke({ query: "current weather in Tokyo" });
    console.log("Result snippet:", result.substring(0, 100) + "...");
    if (result.length > 50) console.log("✅ Search works.");
    else console.log("❌ Search returned too little info.");
  } catch (e) {
    console.log("❌ Search failed:", e.message);
  }

  // 3. Test scrape_website
  console.log("\n--- Testing scrape_website ---");
  try {
    const result = await scrapeWebsite.invoke({ url: "https://example.com" });
    console.log("Result snippet:", result.substring(0, 100) + "...");
    if (result.includes("Example Domain")) console.log("✅ Scrape works.");
    else console.log("❌ Scrape content mismatch.");
  } catch (e) {
    console.log("❌ Scrape failed:", e.message);
  }

  // 4. Test read_file
  console.log("\n--- Testing read_file ---");
  const testFile = "tmp/test.txt";
  if (!fs.existsSync("tmp")) fs.mkdirSync("tmp");
  fs.writeFileSync(testFile, "Hello GAIA");
  try {
    const result = await readFile.invoke({ file_path: testFile });
    console.log("Result:", result);
    if (result === "Hello GAIA") console.log("✅ Read works.");
    else console.log("❌ Read mismatch.");
  } catch (e) {
    console.log("❌ Read failed:", e.message);
  }

  // 5. Test yt_transcript
  console.log("\n--- Testing yt_transcript ---");
  try {
    const result = await ytTranscript.invoke({ video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    console.log("Result snippet:", result.substring(0, 100) + "...");
    if (result.length > 10) console.log("✅ YT Transcript works.");
    else console.log("❌ YT Transcript empty.");
  } catch (e) {
    console.log("❌ YT Transcript failed:", e.message);
  }

  console.log("\n--- Finished Tool Tests ---");
}

testTools();
