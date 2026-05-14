import Firecrawl from "@mendable/firecrawl-js";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  const app = new Firecrawl({ apiKey });
  try {
    const res = await app.scrapeUrl("https://en.wikipedia.org/wiki/Mercedes_Sosa", { formats: ["markdown"] });
    console.log("Response Keys:", Object.keys(res));
    console.log("Success:", res.success);
    console.log("Markdown length:", res.markdown?.length);
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
