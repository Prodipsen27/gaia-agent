// src/tools.js — GAIA agent tools
// Tools: scrape_website, web_search, execute_python, read_file, yt_transcript,
//        analyze_image, huggingface_hub, wikipedia_search, wayback_machine
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
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

      const limit = 15_000;
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
        cwd: TMP_DIR, // Ensure scripts find downloaded files in tmp/
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
      const fullPath = path.isAbsolute(file_path) ? file_path : path.join(TMP_DIR, file_path);
      if (!fs.existsSync(fullPath)) return `File not found: ${file_path} (searched in ${fullPath})`;

      const buffer = fs.readFileSync(fullPath);
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
    const ffmpegPath = "ffmpeg"; // Use from path as verified

    try {
      console.log(`📺 Fetching transcript for: ${video_url}...`);
      
      const env = { ...process.env };
      // Try to get English subtitles (manual or auto)
      const cmd = `python -m yt_dlp --skip-download --write-auto-subs --write-subs --sub-lang "en.*" --convert-subs srt --output "${tmpSubFile}" "${video_url}"`;
      
      try {
          execSync(cmd, { encoding: "utf-8", timeout: 60000, env, cwd: TMP_DIR });
      } catch (execErr) {
          console.warn("⚠️ yt-dlp command failed or timed out. Checking for partial results...");
      }
      
      // Find the generated subtitle file (prefer .srt, then .vtt)
      const files = fs.readdirSync(TMP_DIR);
      const baseName = path.basename(tmpSubFile);
      const subFile = files.find(f => f.startsWith(baseName) && (f.endsWith(".srt") || f.endsWith(".vtt")));
      
      if (!subFile) {
        console.warn("⚠️ No transcript found. Fetching video metadata as fallback...");
        const metaCmd = `python -m yt_dlp --dump-json --skip-download "${video_url}"`;
        const metadata = JSON.parse(execSync(metaCmd, { encoding: "utf-8", timeout: 30000, env }));
        
        let fallbackInfo = `TITLE: ${metadata.title}\nCHANNEL: ${metadata.uploader}\nUPLOAD DATE: ${metadata.upload_date}\n\nDESCRIPTION:\n${metadata.description || "No description."}`;
        
        return `TRANSCRIPT NOT AVAILABLE.\n\nFallback Metadata:\n${fallbackInfo.slice(0, 10000)}\n\n(Note: Search the web for video content or look at comments if this is insufficient.)`;
      }

      const subPath = path.join(TMP_DIR, subFile);
      let content = fs.readFileSync(subPath, "utf-8");
      
      // Better SRT/VTT Cleanup
      content = content
        .replace(/^WEBVTT.*\r?\n/g, "") // Remove VTT header
        .replace(/\d{2}:\d{2}:\d{2}[,.]\d{3} --> \d{2}:\d{2}:\d{2}[,.]\d{3}.*\r?\n/g, "") // Remove timestamps
        .replace(/^\d+\r?\n/gm, "") // Remove line numbers
        .replace(/<[^>]*>/g, "") // Remove HTML tags
        .replace(/\{\\.*?\}/g, "") // Remove subtitle formatting
        .replace(/\r?\n\r?\n+/g, "\n") // Remove extra newlines
        .trim();

      console.log(`✅ Fetched ${content.length} characters of transcript.`);
      // Cleanup all temporary files for this request
      files.forEach(f => {
          if (f.startsWith(baseName)) {
              try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch {}
          }
      });

      return content.slice(0, 20000); 
    } catch (err) {
      console.error(`💥 YouTube tool error:`, err.message);
      return `YouTube tool error: ${err.message}. Try searching the web for the video title.`;
    }
  },
  {
    name: "yt_transcript",
    description: "MANDATORY for YouTube links. Fetches subtitles/transcript or detailed metadata if transcript is unavailable.",
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
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      
      try {
        const response = await fetch(`https://huggingface.co/api/${endpoint}?search=${encodeURIComponent(query)}&limit=5&full=true`, {
          signal: controller.signal
        });
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
      } finally {
        clearTimeout(timeoutId);
      }
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
      
      // Guard against common placeholder hallucinations
      if (file_path === "image_file_path" || file_path.includes("<") || file_path.includes("{")) {
        return `ERROR: You passed a placeholder path "${file_path}". You MUST use the actual absolute path provided in the task notes (it usually starts with D:\\ or C:\\). Check your context for the path.`;
      }

      if (!fs.existsSync(file_path)) return `File not found: ${file_path}. Make sure to use the absolute path provided in the instructions.`;

      const buffer = fs.readFileSync(file_path);
      const base64 = buffer.toString("base64");
      const ext = path.extname(file_path).slice(1).toLowerCase();
      const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;

      // Use Gemini, then GitHub Inference, then Hugging Face, then local Ollama
      const useGoogle = !!process.env.GOOGLE_API_KEY;
      const useGithub = !!process.env.GITHUB_TOKEN;
      const useHF = !!process.env.HF_TOKEN;
      
      if (useGoogle) {
        const ai = new GoogleGenAI(process.env.GOOGLE_API_KEY);
        const model = ai.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent([
          {
            inlineData: {
              mimeType: mediaType,
              data: base64,
            },
          },
          { text: question },
        ]);
        const response = await result.response;
        return response.text();
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

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: question },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mediaType};base64,${base64}`,
                    },
                  },
                ],
              },
            ],
            temperature: 0,
          }),
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        return data.choices[0].message.content;
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

// ── Tool 8: Wikipedia Search (wikipedia_search) ──────────────────────
export const wikipediaSearch = tool(
  async ({ title, revision_date }) => {
    try {
      console.log(`📚 Wikipedia lookup: "${title}"${revision_date ? ` (revisions on ${revision_date})` : ""}...`);

      if (revision_date) {
        // Get revision history for a specific date via MediaWiki API
        const revUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvstart=${revision_date}T23:59:59Z&rvend=${revision_date}T00:00:00Z&rvprop=ids|timestamp|user|comment|size&rvlimit=50&format=json&origin=*`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);
        
        try {
          const revRes = await fetch(revUrl, {
            headers: { "User-Agent": "GAIA-Agent/1.0 (compatible; zxpr27)" },
            signal: controller.signal
          });
          const revData = await revRes.json();

          const pages = revData.query?.pages;
          if (!pages) return `No Wikipedia article found for "${title}".`;

          const pageId = Object.keys(pages)[0];
          if (pageId === "-1") return `Wikipedia article "${title}" does not exist.`;

          const revisions = pages[pageId].revisions;
          if (!revisions || revisions.length === 0) {
            return `No revisions found for "${title}" on ${revision_date}.`;
          }

          const formatted = revisions.map((r, i) =>
            `[${i + 1}] Rev ${r.revid} | ${r.timestamp} | User: ${r.user} | Size: ${r.size} bytes\n    Comment: ${r.comment || "(no comment)"}`
          ).join("\n");

          return `Revisions for "${pages[pageId].title}" on ${revision_date}:\n\n${formatted}`;
        } finally {
          clearTimeout(timeoutId);
        }
      }

      // Standard search logic (no revision date)
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts|revisions&exlimit=1&titles=${encodeURIComponent(title)}&explaintext=1&exsectionformat=plain&rvprop=content&rvslots=main&origin=*`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      
      try {
        const res = await fetch(searchUrl, {
          headers: { "User-Agent": "GAIA-Agent/1.0 (compatible; zxpr27)" },
          signal: controller.signal
        });
        const data = await res.json();

        const pages = data.query?.pages;
        if (!pages) return `No Wikipedia article found for "${title}".`;

        const pageId = Object.keys(pages)[0];
        if (pageId === "-1") return `Wikipedia article "${title}" does not exist.`;

        const page = pages[pageId];
        let content = page.extract || "";

        // If extract is empty, try to get it from revisions (raw wikitext)
        if (!content && page.revisions?.[0]?.slots?.main?.content) {
          content = page.revisions[0].slots.main.content;
        }

        // Check for Discography section specifically
        const hasDiscography = content.toLowerCase().includes("discography");
        const hasListOfWorks = content.toLowerCase().includes("list of works");
        
        console.log(`✅ Wikipedia: got ${content.length} chars for "${page.title}".${hasDiscography ? " (Discography found)" : ""}`);

        let responseText = content;
        const limit = 15_000;
        if (responseText.length > limit) {
          responseText = responseText.slice(0, limit) + `\n\n[TRUNCATED — showing first ${limit} characters]`;
          
          if (hasDiscography || hasListOfWorks) {
              responseText += `\n\nTIP: This article has a ${hasDiscography ? 'Discography' : 'List of works'} section which may be truncated. Try searching for a specific article like "${page.title} discography" or "${page.title} works" for a complete list.`;
          }
        }
        
        return responseText || "No content found in this article.";
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      console.error("💥 Wikipedia error:", err);
      return `Wikipedia error: ${err.message}`;
    }
  },
  {
    name: "wikipedia_search",
    description: "Search Wikipedia for article summaries or revision history. Use for encyclopedic facts, biographical data, or when asked about Wikipedia edit history, contributors, or specific article versions on a date.",
    schema: z.object({
      title: z.string().describe("Wikipedia article title (e.g. 'Albert Einstein', 'Python (programming language)')"),
      revision_date: z.string().optional().describe("YYYY-MM-DD date to get revision history for that specific day"),
    }),
  }
);

// ── Tool 9: Wayback Machine (wayback_machine) ────────────────────────
export const waybackMachine = tool(
  async ({ url, date }) => {
    try {
      console.log(`📼 Wayback Machine lookup: ${url}${date ? ` (target: ${date})` : ""}...`);

      // Check if a snapshot exists
      const timestamp = date ? date.replace(/-/g, "") : "";
      const checkUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}${timestamp ? `&timestamp=${timestamp}` : ""}`;
      const res = await fetch(checkUrl);
      const data = await res.json();

      if (!data.archived_snapshots?.closest) {
        return `No Wayback Machine snapshot found for ${url}${date ? ` near ${date}` : ""}.`;
      }

      const snapshot = data.archived_snapshots.closest;
      const snapshotUrl = snapshot.url;
      console.log(`📼 Found snapshot: ${snapshotUrl} (${snapshot.timestamp})`);

      // Try to scrape the archived page via Firecrawl first, then fallback
      const apiKey = process.env.FIRECRAWL_API_KEY;
      if (apiKey && apiKey.length > 10) {
        try {
          const app = new Firecrawl({ apiKey });
          const scraped = await app.scrape(snapshotUrl, { formats: ["markdown"] });
          const content = scraped.markdown || scraped.data?.markdown;
          if (content) {
            console.log(`✅ Scraped ${content.length} chars from archived page.`);
            return `Archived version (${snapshot.timestamp}):\n\n${content.slice(0, 10000)}`;
          }
        } catch (scrapeErr) {
          console.warn(`⚠️ Firecrawl failed on archive: ${scrapeErr.message}. Trying direct fetch...`);
        }
      }

      // Fallback: basic fetch of the archived page
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        const archiveRes = await fetch(snapshotUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; GAIA-Agent/1.0)" },
          signal: controller.signal
        });
        const html = await archiveRes.text();
        clearTimeout(timeoutId);

        // Quick text extraction via Python
        const tmpFile = path.join(TMP_DIR, `wayback_${Date.now()}.py`);
        const pyCode = `
from bs4 import BeautifulSoup
import sys

html = open(sys.argv[1], 'r', encoding='utf-8', errors='ignore').read()
soup = BeautifulSoup(html, 'html.parser')
for s in soup(['script', 'style', 'header', 'footer', 'nav']): s.decompose()
text = soup.get_text(separator='\\n')
lines = [l.strip() for l in text.split('\\n') if l.strip()]
print('\\n'.join(lines)[:10000])
`;
        const htmlFile = path.join(TMP_DIR, `wayback_${Date.now()}.html`);
        fs.writeFileSync(htmlFile, html, "utf-8");
        fs.writeFileSync(tmpFile, pyCode, "utf-8");

        const output = execSync(`python "${tmpFile}" "${htmlFile}"`, {
          encoding: "utf-8",
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Cleanup
        try { fs.unlinkSync(tmpFile); } catch {}
        try { fs.unlinkSync(htmlFile); } catch {}

        return `Archived version (${snapshot.timestamp}):\n\n${output.trim().slice(0, 10000)}`;
      } catch (fetchErr) {
        return `Snapshot found at ${snapshotUrl} (${snapshot.timestamp}) but content extraction failed: ${fetchErr.message}`;
      }
    } catch (err) {
      console.error("💥 Wayback Machine error:", err);
      return `Wayback Machine error: ${err.message}`;
    }
  },
  {
    name: "wayback_machine",
    description: "Retrieve archived versions of web pages from the Wayback Machine (archive.org). Use when asked about how a website looked in the past, when a current page is unavailable, or when historical web content is needed.",
    schema: z.object({
      url: z.string().describe("The URL to look up in the archive"),
      date: z.string().optional().describe("Target date in YYYY-MM-DD format to find the closest snapshot"),
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
        q = sys.argv[1]
        results = [r for r in ddgs.text(q, max_results=5)]
        print(json.dumps(results))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

    const tmpFile = path.join(TMP_DIR, `ddg_${Date.now()}.py`);
    fs.writeFileSync(tmpFile, pythonCode);
    const output = execSync(`python "${tmpFile}" "${query.replace(/"/g, '\\"')}"`, { 
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    fs.unlinkSync(tmpFile);
    
    const data = JSON.parse(output.trim());
    if (data.error) return `Search failed: ${data.error}`;
    if (!data.length) return "No results found. Try a different query.";
    
    return data.map((r, i) => `[${i + 1}] ${r.title}\n${r.href}\n${r.body}`).join("\n\n");
  } catch (err) {
    console.warn("Search fallback failed:", err.message);
    return `Fallback search failed: ${err.message}`;
  }
}


async function fallbackScrape(url) {
  try {
    const pythonCode = `
import sys
import requests
from bs4 import BeautifulSoup
try:
    url = sys.argv[1]
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    resp = requests.get(url, headers=headers, timeout=15)
    soup = BeautifulSoup(resp.text, 'html.parser')
    for s in soup(['script', 'style', 'header', 'footer', 'nav']): s.decompose()
    text = soup.get_text(separator='\\n')
    lines = [l.strip() for l in text.split('\\n') if l.strip()]
    print('\\n'.join(lines)[:12000])
except Exception as e:
    print(f"Scrape error: {e}")
`;
    const tmpFile = path.join(TMP_DIR, `scrape_${Date.now()}.py`);
    fs.writeFileSync(tmpFile, pythonCode);
    const output = execSync(`python "${tmpFile}" "${url}"`, { encoding: "utf-8" });
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
  huggingfaceHub,
  wikipediaSearch,
  waybackMachine
];
