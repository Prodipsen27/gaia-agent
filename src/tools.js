// src/tools.js — GAIA agent tools
// Tools: scrape_website, web_search, execute_python, read_file, yt_transcript, analyze_image
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ChatOpenAI } from "@langchain/openai";
import { GoogleGenAI } from "@google/genai";
import { HumanMessage } from "@langchain/core/messages";
import { fileURLToPath } from "node:url";

dotenv.config();

import Firecrawl from "@mendable/firecrawl-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.resolve(__dirname, "../tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Tool 1: Scrape Website (Firecrawl) ──────────────────────────────
export const scrapeWebsite = tool(
  async ({ url }) => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) return "ERROR: FIRECRAWL_API_KEY not set in .env";

    try {
      console.log(`🌐 Scraping URL: ${url}...`);
      const app = new Firecrawl({ apiKey });
      const scrapeResult = await app.scrape(url, {
        formats: ["markdown"],
      });

      let content = scrapeResult.markdown || scrapeResult.data?.markdown || "";
      if (!content && scrapeResult.error) {
        if (scrapeResult.status === 402) {
          console.warn("⚠️ Firecrawl credit limit reached. Falling back to basic scraper...");
          return await fallbackScrape(url);
        }
        console.error(`❌ Scrape failed: ${scrapeResult.error}`);
        return `Scrape failed: ${scrapeResult.error}`;
      }

      console.log(`✅ Scraped ${content.length} characters.`);

      const limit = 25_000;
      if (content.length > limit) {
        content = content.slice(0, limit) + `\n\n[TRUNCATED — showing first ${limit} characters]`;
      }
      
      return content || "No content found.";
    } catch (err) {
      if (err.status === 402 || err.message?.includes("402")) {
        console.warn("⚠️ Firecrawl credit limit reached. Falling back to basic scraper...");
        return await fallbackScrape(url);
      }
      console.error(`💥 Scrape error for ${url}:`, err);
      return `Scrape error: ${err.message}`;
    }
  },
  {
    name: "scrape_website",
    description: "Scrape a website URL and return its content in markdown format.",
    schema: z.object({
      url: z.string().describe("The URL of the website to scrape"),
    }),
  }
);

// ── Tool 2: Web Search (Firecrawl) ──────────────────────────────────
export const webSearch = tool(
  async ({ query }) => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) return "ERROR: FIRECRAWL_API_KEY not set in .env";

    try {
      console.log(`🔍 Searching for: "${query}"...`);
      const app = new Firecrawl({ apiKey });
      const searchResult = await app.search(query, { limit: 5 });

      const results = searchResult.data || searchResult.web || [];
      if (results.length === 0 && searchResult.error) {
        if (searchResult.status === 402) {
          console.warn("⚠️ Firecrawl credit limit reached. Falling back to DuckDuckGo...");
          return await fallbackSearch(query);
        }
        return `Search failed: ${searchResult.error}`;
      }

      console.log(`✅ Found ${results.length} results.`);
      if (results.length === 0) return "No results found.";

      return results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description || r.snippet || r.text || ""}`)
        .join("\n\n");
    } catch (err) {
      if (err.status === 402 || err.message?.includes("402")) {
        console.warn("⚠️ Firecrawl credit limit reached. Falling back to DuckDuckGo...");
        return await fallbackSearch(query);
      }
      console.error(`💥 Search error for "${query}":`, err);
      return `Search error: ${err.message}`;
    }
  },
  {
    name: "web_search",
    description: "Search the web for current information using Firecrawl.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  }
);

// ── Tool 3: Execute Python (Upgraded) ────────────────────────────────
export const executePython = tool(
  async ({ code }) => {
    const tmpFile = path.join(TMP_DIR, `gaia_exec_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmpFile, code, "utf-8");

      let output = execSync(`python "${tmpFile}"`, {
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });

      output = output.trim() || "(no output)";
      const limit = 25_000;
      if (output.length > limit) {
        output = output.slice(0, limit) + `\n\n[TRUNCATED — showing first ${limit} characters]`;
      }
      return output;
    } catch (err) {
      return `Python error:\n${err.stderr || err.message}`;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  },
  {
    name: "execute_python",
    description: "Execute a Python script. Now supports pdfplumber, openpyxl, pillow, and pandas for binary file parsing.",
    schema: z.object({
      code: z.string().describe("Complete Python code to execute. Must print the result."),
    }),
  }
);

// ── Tool 4: Read File (Upgraded with binary guard) ───────────────────
export const readFile = tool(
  async ({ file_path, max_chars }) => {
    try {
      if (!fs.existsSync(file_path)) return `File not found: ${file_path}`;

      const buffer = fs.readFileSync(file_path);
      const isBinary = buffer.slice(0, 512).some((b) => b === 0);
      if (isBinary) {
        const ext = path.extname(file_path).toLowerCase();
        return `Binary file at ${file_path} (${ext}, ${buffer.length} bytes). Use execute_python with pdfplumber (PDF), openpyxl (xlsx), or PIL (images) to read it.`;
      }

      const content = buffer.toString("utf-8");
      const limit = max_chars ?? 25_000;
      if (content.length > limit) {
        return content.slice(0, limit) + `\n\n[TRUNCATED — file is ${content.length} chars, showing first ${limit}]`;
      }
      return content;
    } catch (err) {
      return `Error reading file: ${err.message}`;
    }
  },
  {
    name: "read_file",
    description: "Read the contents of a local file. Returns binary warning for PDFs/Excel/Images.",
    schema: z.object({
      file_path: z.string().describe("Absolute or relative path to the file"),
      max_chars: z.number().optional().describe("Maximum characters to read."),
    }),
  }
);

// ── Tool 5: YouTube Transcript (yt_transcript) ───────────────────────
export const ytTranscript = tool(
  async ({ video_url }) => {
    const tmpSubFile = path.join(TMP_DIR, `subs_${Date.now()}`);

    try {
      console.log(`📺 Fetching transcript for: ${video_url}...`);
      // Use python -m yt_dlp for Windows compatibility
      // Removed --convert-subs srt to avoid ffmpeg dependency
      const cmd = `python -m yt_dlp --skip-download --write-auto-subs --sub-lang en --output "${tmpSubFile}" "${video_url}"`;
      execSync(cmd, { encoding: "utf-8", timeout: 60000 });
      
      // Find the generated subtitle file (srt or vtt)
      const files = fs.readdirSync(tmpDir);
      const subFile = files.find(f => f.startsWith(path.basename(tmpSubFile)) && (f.endsWith(".srt") || f.endsWith(".vtt")));
      
      if (!subFile) {
        return "No English transcript found for this video. It might not have subtitles enabled or YouTube is rate-limiting.";
      }

      const subPath = path.join(tmpDir, subFile);
      let content = fs.readFileSync(subPath, "utf-8");
      
      // Robust cleanup of SRT/VTT headers, tags, and timestamps
      content = content
        .replace(/WEBVTT/g, "")
        .replace(/Kind: captions/g, "")
        .replace(/Language: .*/g, "")
        .replace(/<[^>]*>/g, "") // Remove HTML tags
        .replace(/^\d+$/gm, "") // Remove SRT line numbers
        .replace(/^[\d:.,]+ --> [\d:.,]+.*/gm, "") // Remove timestamps and positioning
        .replace(/\n\s*\n/g, "\n") // Remove extra blank lines
        .trim();

      console.log(`✅ Fetched ${content.length} characters of transcript.`);
      
      // Cleanup
      try { fs.unlinkSync(subPath); } catch {}

      return content.slice(0, 10000); // 10k limit
    } catch (err) {
      console.error(`💥 YouTube transcript error:`, err);
      return `YouTube transcript error: ${err.message}. Make sure yt-dlp is installed and the video is public.`;
    }
  },
  {
    name: "yt_transcript",
    description: "Get the spoken transcript of a YouTube video. Use whenever a question references a YouTube URL.",
    schema: z.object({
      video_url: z.string().describe("Full YouTube video URL"),
    }),
  }
);

// ── Tool 6: Analyze Image (analyze_image) ────────────────────────────
export const analyzeImage = tool(
  async ({ file_path, question }) => {
    try {
      console.log(`👁️ Analyzing image: ${file_path}...`);
      if (!fs.existsSync(file_path)) return `File not found: ${file_path}`;

      const buffer = fs.readFileSync(file_path);
      const base64 = buffer.toString("base64");
      const ext = path.extname(file_path).slice(1).toLowerCase();
      const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;

      // Use Gemini, then GitHub Inference, then local Ollama
      const useGoogle = !!process.env.GOOGLE_API_KEY;
      const useGithub = !!process.env.GITHUB_TOKEN;
      
      let model;
      if (useGoogle) {
        const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            {
              inlineData: {
                mimeType: mediaType,
                data: base64,
              },
            },
            { text: question },
          ],
        });
        return response.text;
      } else {
        const model = new ChatOpenAI({
          configuration: {
            baseURL: useGithub ? "https://models.inference.ai.azure.com" : "http://localhost:11434/v1",
          },
          apiKey: useGithub ? process.env.GITHUB_TOKEN : "ollama",
          modelName: useGithub ? "gpt-4o" : "llava",
          timeout: 180_000,
        });

        const response = await model.invoke([
          new HumanMessage({
            content: [
              { type: "text", text: question },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mediaType};base64,${base64}`,
                },
              },
            ],
          }),
        ]);
        return response.content;
      }
    } catch (err) {
      console.error(`💥 Image analysis error:`, err);
      return `Image analysis error: ${err.message}`;
    }
  },
  {
    name: "analyze_image",
    description: "Analyze an image file and answer a question about it. Use for chess positions, diagrams, charts, etc.",
    schema: z.object({
      file_path: z.string().describe("Path to the image file"),
      question: z.string().describe("What to look for in the image"),
    }),
  }
);

// ── Fallback Helpers ───────────────────────────────────────────────

async function fallbackSearch(query) {
  try {
    const pythonCode = `
from duckduckgo_search import DDGS
import json
try:
    with DDGS() as ddgs:
        results = [r for r in ddgs.text("${query.replace(/"/g, '\\"')}", max_results=5)]
        print(json.dumps(results))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
    const tmpFile = path.join(TMP_DIR, `ddg_${Date.now()}.py`);
    fs.writeFileSync(tmpFile, pythonCode);
    const output = execSync(`python "${tmpFile}"`, { encoding: "utf-8" });
    fs.unlinkSync(tmpFile);
    
    const data = JSON.parse(output);
    if (data.error) return `DuckDuckGo error: ${data.error}`;
    
    return data.map((r, i) => `[${i + 1}] ${r.title}\n${r.href}\n${r.body}`).join("\n\n");
  } catch (err) {
    return `Fallback search failed: ${err.message}`;
  }
}

async function fallbackScrape(url) {
  try {
    const pythonCode = `
import requests
from bs4 import BeautifulSoup
try:
    headers = {'User-Agent': 'Mozilla/5.0'}
    resp = requests.get("${url}", headers=headers, timeout=15)
    soup = BeautifulSoup(resp.text, 'html.parser')
    # Remove script/style
    for s in soup(['script', 'style']): s.decompose()
    text = soup.get_text(separator='\\n')
    print(text[:25000])
except Exception as e:
    print(f"Scrape error: {e}")
`;
    const tmpFile = path.join(TMP_DIR, `scrape_${Date.now()}.py`);
    fs.writeFileSync(tmpFile, pythonCode);
    const output = execSync(`python "${tmpFile}"`, { encoding: "utf-8" });
    fs.unlinkSync(tmpFile);
    return output.trim() || "No content found.";
  } catch (err) {
    return `Fallback scrape failed: ${err.message}`;
  }
}

// ── Export all tools as an array for easy binding ────────────────────
export const allTools = [
  scrapeWebsite, 
  webSearch, 
  executePython, 
  readFile, 
  ytTranscript, 
  analyzeImage
];
