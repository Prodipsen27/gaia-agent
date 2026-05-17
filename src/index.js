// src/index.js — GAIA orchestrator
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { fetchQuestions, fetchFile, submitAnswers } from "./api.js";
import { app, getModelPool } from "./graph.js";

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
    const total = Array.isArray(questions) ? questions.length : 0;
    console.log(`✅ Received ${total} questions.`);

    if (total === 0) {
      console.warn("⚠️ No questions received. Exiting.");
      return;
    }

    const answers = [];
    const resultsJsonl = [];

    // 3. Loop through all questions
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      console.log(`\n[${i + 1}/${questions.length}] Solving Task: ${q.task_id}`);
      console.log(`Question: ${q.question.substring(0, 100)}${q.question.length > 100 ? "..." : ""}`);

      try {
        let localFilePath = null;

        // 4. Download file if attached
        if (q.file_name) {
          console.log(`📎 Downloading attachment: ${q.file_name}...`);
          try {
            const res = await fetchFile(q.task_id, q.file_name);
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
          ? `\n\nIMPORTANT: A file for this task has been downloaded. The EXACT path is: "${localFilePath}". You MUST use this exact path when calling any file tool. Do not guess or modify the path.`
          : "";

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
            new HumanMessage(humanContent)
          ],
          task_id: q.task_id,
          question: q.question,
          file_path: localFilePath,
        };

        let success = false;
        console.log(`  📁 File path being passed to graph: ${localFilePath || "none"}`);

        const pool = getModelPool(q.question, localFilePath);

        // Determine the primary model to cycle through each AI API for each question
        const allApis = ["gemini", "groq", "nvidia", "hf"];
        const primaryApiId = allApis[i % allApis.length];

        // Reorder the pool to try the cycled primary API first, followed by others in the pool
        let reorderedPool = [...pool];
        const primaryIndex = reorderedPool.findIndex(m => m.id === primaryApiId);
        if (primaryIndex > -1) {
          const [primaryModel] = reorderedPool.splice(primaryIndex, 1);
          reorderedPool.unshift(primaryModel);
          console.log(`🔄 Cycled primary starting API to: ${primaryApiId} for Question ${i + 1}`);
        } else {
          console.log(`🔌 Starting model pool fallback to: ${reorderedPool[0]?.id || "none"} for Question ${i + 1}`);
        }

        for (const modelInfo of reorderedPool) {
          const modelId = modelInfo.id;
          console.log(`🔌 Attempting task with starting model: ${modelId}`);

          const stateForModel = {
            ...initialState,
            current_model_key: modelId,
          };

          try {
            const result = await app.invoke(stateForModel, { recursionLimit: 50 });
            const finalAnswer = result.final_answer;
            
            console.log(`✨ Final Answer: ${finalAnswer}`);
            
            answers.push({
              task_id: q.task_id,
              submitted_answer: finalAnswer,
            });

            // Collect reasoning trace (all AI messages)
            const trace = result.messages
              .filter(m => m._getType() === "ai")
              .map(m => m.content)
              .join("\n\n");

            resultsJsonl.push({
              task_id: q.task_id,
              model_answer: finalAnswer,
              reasoning_trace: trace
            });

            success = true;
            break; // Succeeded! Break the pool loop and proceed.
          } catch (err) {
            console.error(`❌ Error solving ${q.task_id} using starting model ${modelId}:`, err.message);
            console.log("🔄 Falling back to next model in pool after a short pause...");
            await sleep(2000);
          }
        }

        if (!success) {
          const errorMsg = `ERROR: All models in pool failed.`;
          answers.push({
            task_id: q.task_id,
            submitted_answer: errorMsg,
          });
          resultsJsonl.push({
            task_id: q.task_id,
            model_answer: errorMsg,
            reasoning_trace: "Failed for all models in the pool"
          });
        }
      } catch (innerErr) {
        console.error(`💥 Unexpected error while solving ${q.task_id}:`, innerErr.message);
        const errorMsg = `ERROR: Question failed due to an unexpected error.`;
        answers.push({
          task_id: q.task_id,
          submitted_answer: errorMsg,
        });
        resultsJsonl.push({
          task_id: q.task_id,
          model_answer: errorMsg,
          reasoning_trace: `Unexpected failure: ${innerErr.message}`
        });
      }

      // 6. Save intermediate results to file
      try {
        fs.writeFileSync("results.jsonl", resultsJsonl.map(r => JSON.stringify(r)).join("\n"));
      } catch (saveErr) {
        console.error("⚠️ Failed to save results.jsonl:", saveErr.message);
      }

      // 7. Rate limiting (1 second between questions)
      if (i < questions.length - 1) {
        console.log(`⏲️ Waiting 2 seconds before next task...`);
        await sleep(2000);
      }
    }

    // 8. Submit all answers
    console.log("\n📤 Submitting all answers to scoring server...");
    const username = process.env.HF_USERNAME || "anonymous";
    const agentUrl = process.env.AGENT_CODE_URL || "https://huggingface.co/spaces/zxpr27/gaia-agent";
    
    const scoreReport = await submitAnswers(username, agentUrl, answers);
    
    console.log("\n🏆 --- SCORE REPORT ---");
    console.log(`Total Attempted: ${scoreReport.total_attempted}`);
    console.log(`Correct Count:   ${scoreReport.correct_count}`);
    console.log(`Score:           ${(scoreReport.score * 100).toFixed(2)}%`);
    console.log(`Message:         ${scoreReport.message || "No message"}`);
    console.log("------------------------");

    console.log("\n✅ Done! Detailed results saved to results.jsonl");

  } catch (err) {
    console.error("💥 Critical Failure:", err);
  }
}

main();
