// tests/api_connectivity.js
import "../src/env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQuestions, fetchFile, submitAnswers } from "../src/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.resolve(__dirname, "../tmp");

async function runTests() {
  console.log("Starting API connectivity tests (with HF fallback)...\n");

  let questions = [];
  try {
    console.log("Step 1: Fetching questions...");
    questions = await fetchQuestions();
    console.log(`Success: received ${questions.length} questions.`);
    console.table(
      questions.map((q) => ({
        task_id: q.task_id,
        file_name: q.file_name,
        question: q.question.substring(0, 50) + "...",
      })),
    );
  } catch (err) {
    console.error("Step 1 failed:", err.message);
    process.exit(1);
  }

  console.log("\nStep 2: Testing file downloads...");
  const questionsWithFiles = questions.filter((q) => q.file_name);
  console.log(`Found ${questionsWithFiles.length} questions with files.`);
  if (questionsWithFiles.length > 0) {
    console.log("Sample question with file:", JSON.stringify(questionsWithFiles[0], null, 2));
  }

  let downloadSuccess = false;
  for (const q of questionsWithFiles) {
    console.log(`Trying to download: ${q.file_name} (Task ID: ${q.task_id})...`);
    try {
      const res = await fetchFile(q.task_id, q.file_name);
      if (res && res.ok) {
        if (!fs.existsSync(TMP_DIR)) {
          fs.mkdirSync(TMP_DIR, { recursive: true });
        }
        const localFilePath = path.join(TMP_DIR, `test_${q.file_name}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(localFilePath, buffer);
        console.log(`Success: file saved to: ${localFilePath} (${buffer.length} bytes)`);
        downloadSuccess = true;
        break;
      } else {
        console.log(`Status ${res?.status} for task ${q.task_id}`);
      }
    } catch (err) {
      console.error(`Failed for ${q.task_id}:`, err.message);
    }
  }

  if (!downloadSuccess && questionsWithFiles.length > 0) {
    console.error("All file downloads failed!");
  }

  console.log("\nStep 3: Testing answer submission (mock)...");
  try {
    const mockAnswers = [
      {
        task_id: questions[0]?.task_id || "test-id",
        submitted_answer: "test-answer",
      },
    ];
    console.log("Submitting mock answer for task:", mockAnswers[0].task_id);

    const report = await submitAnswers("test_user", "https://example.com/agent", mockAnswers);

    console.log("Success: scoring server responded.");
    console.log(
      "Report Summary:",
      JSON.stringify(
        {
          total: report.total,
          correct: report.correct,
          score: report.score,
          message: report.message,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("Step 3 failed:", err.message);
  }

  console.log("\nAll tests completed.");
}

runTests();

