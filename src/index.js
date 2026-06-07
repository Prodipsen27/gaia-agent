import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage } from "@langchain/core/messages";

import { fetchQuestions, fetchFile, submitAnswers } from "./api.js";
import { app } from "./graph.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.resolve(__dirname, "../tmp");
const RESULTS_PATH = path.resolve(__dirname, "../results.jsonl");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function flattenMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => b.text ?? "").join("\n");
  return JSON.stringify(content);
}

async function main() {
  console.log("Starting GAIA Solver...");

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  try {
    console.log("Fetching questions...");
    const questions = await fetchQuestions();
    console.log(`Received ${Array.isArray(questions) ? questions.length : 0} questions.`);
    if (!Array.isArray(questions) || questions.length === 0) return;

    const answers = [];
    const results = [];
    const stats = { github: 0, groq: 0, hf: 0, gemini: 0 };

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      console.log(`\n[${i + 1}/${questions.length}] Task: ${q.task_id}`);

      let localFilePath = null;
      if (q.file_name) {
        try {
          const res = await fetchFile(q.task_id, q.file_name);
          if (res) {
            localFilePath = path.join(TMP_DIR, q.file_name);
            const buffer = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(localFilePath, buffer);
            console.log(`Attachment saved: ${localFilePath}`);
          }
        } catch (err) {
          console.error(`Download failed for ${q.task_id}: ${err.message}`);
        }
      }

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
        messages: [new HumanMessage(humanContent)],
        task_id: q.task_id,
        question: q.question,
        file_path: localFilePath,
      };

      try {
        const result = await app.invoke(initialState, { recursionLimit: 50 });
        const finalAnswer = result.final_answer;
        console.log(`✨ Final Answer: ${finalAnswer}`);

        const used = result.current_model_key || "unknown";
        if (stats[used] !== undefined) stats[used]++;

        answers.push({ task_id: q.task_id, submitted_answer: finalAnswer });

        const trace =
          result.messages
            ?.filter((m) => m._getType?.() === "ai")
            ?.map((m) => flattenMessageContent(m.content))
            ?.join("\n---\n") ?? "";

        results.push({ task_id: q.task_id, model_answer: finalAnswer, reasoning_trace: trace });
      } catch (err) {
        const errorMsg = `ERROR: ${err.message}`;
        console.log(`❌ ${errorMsg}`);
        answers.push({ task_id: q.task_id, submitted_answer: errorMsg });
        results.push({ task_id: q.task_id, model_answer: errorMsg, reasoning_trace: "Failed" });
      }

      try {
        fs.writeFileSync(RESULTS_PATH, results.map((r) => JSON.stringify(r)).join("\n"));
      } catch (saveErr) {
        console.error(`Failed to write ${RESULTS_PATH}: ${saveErr.message}`);
      }

      if (i < questions.length - 1) await sleep(2000);
    }

    console.log(`Saved results.jsonl -> ${RESULTS_PATH}`);

    console.log("\nSubmitting answers...");
    const username = process.env.HF_USERNAME || "anonymous";
    const agentUrl = process.env.AGENT_CODE_URL || "https://huggingface.co/spaces/zxpr27/gaia-agent";
    const scoreReport = await submitAnswers(username, agentUrl, answers);

    console.log("\n--- SCORE REPORT ---");
    console.log(`Total Attempted: ${scoreReport.total_attempted || scoreReport.total}`);
    console.log(`Correct Answers: ${scoreReport.correct_count || scoreReport.correct} out of 20`);
    console.log(`Score:           ${(scoreReport.score * 100).toFixed(2)}%`);
    console.log(`Message:         ${scoreReport.message || "No message"}`);

    // Log which specific answers were correct if details are provided (server formats vary).
    const answerByTaskId = new Map(answers.map((a) => [a.task_id, a.submitted_answer]));

    const details = scoreReport.details;
    const normalized = [];
    if (Array.isArray(details)) {
      for (const d of details) {
        if (!d) continue;
        const taskId = d.task_id || d.id || d.task || d.taskId;
        if (!taskId) continue;
        const correct = Boolean(d.is_correct ?? d.correct ?? d.isCorrect);
        normalized.push({
          task_id: taskId,
          correct,
          expected: d.expected_answer ?? d.expected ?? d.answer,
          submitted: d.submitted_answer ?? d.submitted ?? answerByTaskId.get(taskId),
        });
      }
    } else if (details && typeof details === "object") {
      for (const [taskId, v] of Object.entries(details)) {
        if (v && typeof v === "object") {
          normalized.push({
            task_id: taskId,
            correct: Boolean(v.is_correct ?? v.correct ?? v.isCorrect),
            expected: v.expected_answer ?? v.expected ?? v.answer,
            submitted: v.submitted_answer ?? v.submitted ?? answerByTaskId.get(taskId),
          });
        } else {
          normalized.push({
            task_id: taskId,
            correct: Boolean(v),
            expected: undefined,
            submitted: answerByTaskId.get(taskId),
          });
        }
      }
    }

    if (normalized.length > 0) {
      normalized.sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)));
      console.log("\n--- PER-TASK RESULTS ---");
      for (const r of normalized) {
        const tag = r.correct ? "[OK]   " : "[WRONG]";
        const submitted = r.submitted != null ? String(r.submitted) : "(missing)";
        const expected =
          r.expected != null && String(r.expected).length > 0 ? ` expected="${String(r.expected)}"` : "";
        console.log(`${tag} ${r.task_id} submitted="${submitted}"${expected}`);
      }
    }

    console.log("\nModel usage summary:");
    console.log(`  GitHub: ${stats.github}`);
    console.log(`  Groq:   ${stats.groq}`);
    console.log(`  HF:     ${stats.hf}`);
    console.log(`  Gemini: ${stats.gemini}`);
  } catch (err) {
    console.error("Critical Failure:", err);
  }
}

main();
