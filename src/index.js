// src/index.js — GAIA orchestrator
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { fetchQuestions, fetchFile, submitAnswers } from "./api.js";
import { app } from "./graph.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.resolve(__dirname, "../tmp");

// Helper to sleep for rate limiting
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("🚀 Starting GAIA Solver...");

  // 1. Ensure tmp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    console.log(`📁 Created temporary directory: ${TMP_DIR}`);
  }

  try {
    // 2. Fetch all 20 questions
    console.log("📥 Fetching questions from GAIA API...");
    const questions = await fetchQuestions();
    console.log(`✅ Received ${questions.length} questions.`);

    const answers = [];

    // 3. Loop through all questions
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      console.log(`\n[${i + 1}/${questions.length}] Solving Task: ${q.task_id}`);
      console.log(`Question: ${q.question.substring(0, 100)}${q.question.length > 100 ? "..." : ""}`);

      let localFilePath = null;

      // 4. Download file if attached
      if (q.file_name) {
        console.log(`📎 Downloading attachment: ${q.file_name}...`);
        try {
          const res = await fetchFile(q.task_id);
          if (res) {
            localFilePath = path.join(TMP_DIR, q.file_name);
            const buffer = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(localFilePath, buffer);
            console.log(`💾 Saved to: ${localFilePath}`);
          }
        } catch (err) {
          console.error(`⚠️ Failed to download file for ${q.task_id}: ${err.message}`);
        }
      }

      // 5. Run the graph with a retry mechanism
      const filePrompt = localFilePath 
        ? `\n\nNote: A file related to this task has been downloaded to: ${localFilePath}` 
        : "";

      // Fix 1: Detect if file is an image and use multimodal message
      const isImage = localFilePath && /\.(png|jpg|jpeg|gif|webp)$/i.test(localFilePath);

      const humanContent = isImage
        ? [
            { type: "text", text: `${q.question}${filePrompt}` },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${fs.readFileSync(localFilePath).toString("base64")}`,
              },
            },
          ]
        : `${q.question}${filePrompt}`;

      const initialState = {
        messages: [
          new SystemMessage(
            "You are an elite GAIA benchmark solver. Use your tools (search, python, file_read, yt_transcript, analyze_image) to find the answer. " +
            "Work step-by-step. When you have the final answer, state it clearly. " +
            "The answer must be as concise as possible for exact-match grading.\n\n" +
            "STRATEGY RULES:\n" +
            "1. NEVER say you cannot find information after only 1-2 searches. GAIA answers are often buried.\n" +
            "2. Try at least 3-5 different search queries with different keywords before giving up.\n" +
            "3. If search snippets are insufficient, use scrape_website on the most relevant URLs to find details.\n" +
            "4. MANDATORY: If a question contains a YouTube link, you MUST call yt_transcript immediately. Do NOT search for video summaries unless yt_transcript reports failure.\n" +
            "5. If a question involves an image (chess, charts, diagrams), use analyze_image.\n" +
            "6. If read_file reports a binary file (PDF, Excel, Docx), use execute_python. ALWAYS use the EXACT ABSOLUTE PATH provided for the file. NEVER assume filenames like 'sales_data.xlsx' or 'data.csv'.\n" +
            "7. For any math, counting, or complex data processing, ALWAYS use execute_python. Use the provided file_path directly in your code.\n" +
            "8. Final answers should be BARE strings (e.g., '42', 'Paris', '2023-01-01'). No units or extra words unless requested."
          ),
          new HumanMessage(humanContent)
        ],
        task_id: q.task_id,
        question: q.question,
        file_path: localFilePath,
      };

      let attempt = 0;
      let success = false;
      while (attempt < 2 && !success) {
        try {
          const result = await app.invoke(initialState, { recursionLimit: 50 });
          const finalAnswer = result.final_answer;
          
          console.log(`✨ Final Answer: ${finalAnswer}`);
          
          answers.push({
            task_id: q.task_id,
            submitted_answer: finalAnswer,
          });
          success = true;
        } catch (err) {
          attempt++;
          console.error(`❌ Error solving ${q.task_id} (Attempt ${attempt}):`, err.message);
          
          if (attempt < 2) {
            console.log("🔄 Retrying whole graph in 10 seconds...");
            await sleep(10000);
          } else {
            answers.push({
              task_id: q.task_id,
              submitted_answer: `ERROR: ${err.message}`,
            });
          }
        }
      }

      // 6. Rate limiting (1 second between questions)
      if (i < questions.length - 1) {
        await sleep(1000);
      }
    }

    // 7. Submit all answers
    console.log("\n📤 Submitting all answers to scoring server...");
    const username = process.env.HF_USERNAME || "anonymous";
   const agentUrl = process.env.AGENT_CODE_URL || "https://huggingface.co/spaces/zxpr27/gaia-agent/tree/main";// Descriptive URL
    
    const scoreReport = await submitAnswers(username, agentUrl, answers);
    
    console.log("\n🏆 --- SCORE REPORT ---");
    console.log(`Total: ${scoreReport.total}`);
    console.log(`Correct: ${scoreReport.correct}`);
    console.log(`Score: ${(scoreReport.score * 100).toFixed(2)}%`);
    console.log("------------------------");

  } catch (err) {
    console.error("💥 Critical Failure:", err);
  }
}

main();
