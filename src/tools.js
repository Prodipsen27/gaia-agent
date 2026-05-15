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
        if ([401, 402, 403].includes(scrapeResult.status)) {
          console.warn(`⚠️ Firecrawl error ${scrapeResult.status}. Falling back to basic scraper...`);
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
      if ([401, 402, 403].includes(err.status) || /401|402|403/.test(err.message)) {
        console.warn(`⚠️ Firecrawl error ${err.status || 'API'}. Falling back to basic scraper...`);
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

// ── Tool 2: Web Search (Firecrawl + DuckDuckGo Fallback) ─────────────
export const webSearch = tool(
  async ({ query }) => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    try {
      if (!apiKey || apiKey === "YOUR_FIRECRAWL_KEY" || apiKey.length < 10) {
        console.log(`🔍 Searching DuckDuckGo (No Firecrawl key): "${query}"...`);
        return await fallbackSearch(query);
      }


      console.log(`🔍 Searching Firecrawl for: "${query}"...`);
      const app = new Firecrawl({ apiKey });
      const searchResult = await app.search(query, { limit: 5 });

      const results = searchResult.data || searchResult.web || [];
      if (results.length === 0 && searchResult.error) {
        console.warn(`⚠️ Firecrawl error/no results. Falling back to DuckDuckGo...`);
        return await fallbackSearch(query);
      }

      console.log(`✅ Found ${results.length} results via Firecrawl.`);
      return results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description || r.snippet || r.text || ""}`)
        .join("\n\n");
    } catch (err) {
      if (err.message?.includes("402") || err.status === 402) {
        console.warn(`💰 Firecrawl Payment Required (402). Falling back to DuckDuckGo...`);
      } else {
        console.warn(`⚠️ Firecrawl failed (${err.message}). Using DuckDuckGo fallback...`);
      }
      return await fallbackSearch(query);
    }

  },
  {
    name: "web_search",
    description: "Search the web for current information. Uses Firecrawl with a robust DuckDuckGo fallback.",
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
      const cmd = `python -m yt_dlp --skip-download --write-auto-subs --sub-lang en --output "${tmpSubFile}" "${video_url}"`;
      execSync(cmd, { encoding: "utf-8", timeout: 60000 });
      
      // Find the generated subtitle file (srt or vtt)
      const files = fs.readdirSync(TMP_DIR);
      const subFile = files.find(f => f.startsWith(path.basename(tmpSubFile)) && (f.endsWith(".srt") || f.endsWith(".vtt")));
      
      if (!subFile) {
        console.warn("⚠️ No English transcript found. Fetching video description as fallback...");
        try {
          const descCmd = `python -m yt_dlp --get-description "${video_url}"`;
          const description = execSync(descCmd, { encoding: "utf-8", timeout: 30000 }).trim();
          if (description) {
            return `TRANSCRIPT NOT AVAILABLE.\n\nFallback Video Description:\n${description.slice(0, 5000)}\n\n(Note: If this description doesn't answer the question, try searching for summaries of this video online.)`;
          }
        } catch (descErr) {
          console.error("💥 Failed to fetch video description:", descErr.message);
        }
        return "ERROR: No English transcript or description found. The video might be private, deleted, or have subtitles disabled.";
      }

      const subPath = path.join(TMP_DIR, subFile);
      let content = fs.readFileSync(subPath, "utf-8");
      
      // Cleanup
      content = content
        .replace(/WEBVTT/g, "")
        .replace(/Kind: captions/g, "")
        .replace(/Language: .*/g, "")
        .replace(/<[^>]*>/g, "")
        .replace(/^\d+$/gm, "")
        .replace(/^[\d:.,]+ --> [\d:.,]+.*/gm, "")
        .replace(/\n\s*\n/g, "\n")
        .trim();

      console.log(`✅ Fetched ${content.length} characters of transcript.`);
      try { fs.unlinkSync(subPath); } catch {}

      return content.slice(0, 15000); 
    } catch (err) {
      console.error(`💥 YouTube transcript error:`, err);
      return `YouTube transcript error: ${err.message}. If transcript fails, try searching the web for the video title/content.`;
    }
  },
  {
    name: "yt_transcript",
    description: "MANDATORY for any YouTube video URL. Use this tool IMMEDIATELY to get the transcript/description. DO NOT use web_search for YouTube links unless this tool fails.",
    schema: z.object({
      video_url: z.string().describe("Full YouTube video URL"),
    }),
  }
);

// ── Tool 6: Hugging Face Hub (huggingface_hub) ──────────────────────
export const huggingfaceHub = tool(
  async ({ query, type = "models" }) => {
    try {
      console.log(`🤗 Searching HF Hub for ${type}: "${query}"...`);
      const endpoint = type === "models" ? "models" : "datasets";
      // Use standard fetch to query HF Hub API
      const response = await fetch(`https://huggingface.co/api/${endpoint}?search=${encodeURIComponent(query)}&limit=5&full=true`);
      const data = await response.json();

      if (!data || data.length === 0) return `No ${type} found on Hugging Face for "${query}".`;

      return data.map((item, i) => {
        const id = item.id || item.modelId;
        const author = item.author;
        const downloads = item.downloads || 0;
        const likes = item.likes || 0;
        const description = item.description || (item.cardData?.short_description) || "No description.";
        return `[${i + 1}] ${id} (Author: ${author})\nDownloads: ${downloads}, Likes: ${likes}\n${description}`;
      }).join("\n\n");
    } catch (err) {
      console.error("💥 HF Hub error:", err);
      return `Hugging Face Hub error: ${err.message}`;
    }
  },
  {
    name: "huggingface_hub",
    description: "Search Hugging Face for models or datasets. Use when asked about specific models, authors, or dataset statistics on HF.",
    schema: z.object({
      query: z.string().describe("Search query (model name, author, or keywords)"),
      type: z.enum(["models", "datasets"]).optional().describe("Whether to search for models or datasets. Defaults to models."),
    }),
  }
);

// ── Tool 7: Analyze Image (analyze_image) ────────────────────────────
export const analyzeImage = tool(
  async ({ file_path, question }) => {
    try {
      console.log(`👁️ Analyzing image: ${file_path}...`);
      if (!fs.existsSync(file_path)) return `File not found: ${file_path}`;

      const buffer = fs.readFileSync(file_path);
      const base64 = buffer.toString("base64");
      const ext = path.extname(file_path).slice(1).toLowerCase();
      const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;

      // Use Gemini, then GitHub Inference, then Hugging Face, then local Ollama
      const useGoogle = !!process.env.GOOGLE_API_KEY;
      const useGithub = !!process.env.GITHUB_TOKEN;
      const useHF = !!process.env.HF_TOKEN;
      
      if (useGoogle) {
        const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
        const response = await ai.models.generateContent({
          model: "gemini-1.5-flash",
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
        const baseUrl = useGithub 
          ? "https://models.inference.ai.azure.com" 
          : (useHF ? "https://api-inference.huggingface.co/v1" : "http://localhost:11434/v1");
        
        const apiKey = useGithub 
          ? process.env.GITHUB_TOKEN 
          : (useHF ? process.env.HF_TOKEN : "ollama");
        
        const modelName = useGithub 
          ? "gpt-4o" 
          : (useHF ? "Qwen/Qwen2-VL-7B-Instruct" : "llava");

        const model = new ChatOpenAI({
          configuration: { baseURL: baseUrl },
          apiKey: apiKey,
          modelName: modelName,
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
import sys
import json
import warnings
from duckduckgo_search import DDGS

# Suppress all warnings in fallback
warnings.filterwarnings("ignore")

try:
    with DDGS() as ddgs:

        results = [r for r in ddgs.text("${query.replace(/"/g, '\\"')}", max_results=5)]
        print(json.dumps(results))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

    const tmpFile = path.join(TMP_DIR, `ddg_${Date.now()}.py`);
    fs.writeFileSync(tmpFile, pythonCode);
    // Suppress stderr to hide the RuntimeWarning
    const output = execSync(`python "${tmpFile}" 2>NUL`, { encoding: "utf-8" });
    fs.unlinkSync(tmpFile);
    
    const data = JSON.parse(output.trim());
    if (data.error) return `Search failed: ${data.error}`;
    if (!data.length) return "No results found.";
    
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
  analyzeImage,
  huggingfaceHub
];
