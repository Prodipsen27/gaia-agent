import Firecrawl from "@mendable/firecrawl-js";
import dotenv from "dotenv";
dotenv.config();

async function test() {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  const app = new Firecrawl({ apiKey });
  try {
    const res = await app.search("Mercedes Sosa discography", { limit: 5 });
    console.log("Response:", JSON.stringify(res, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
