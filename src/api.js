// src/api.js — GAIA Benchmark API client
// Endpoints: questions, file downloads, answer submission

const BASE_URL = "https://agents-course-unit4-scoring.hf.space";

/**
 * Fetch all 20 GAIA benchmark questions.
 * @returns {Promise<Array<{task_id: string, question: string, file_name?: string}>>}
 */
export async function fetchQuestions() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${BASE_URL}/questions`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch questions: ${res.status} ${res.statusText}`);
    }
    // Added timeout for body parsing
    const bodyPromise = res.json();
    return await Promise.race([
      bodyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout parsing questions JSON")), 15000))
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Download the attached file for a given task (if one exists).
 * Fallback to HF Hub if the scoring server's /files endpoint is 404.
 * @param {string} taskId   — The task_id of the question
 * @param {string} fileName — The file_name from the question metadata (needed for extension)
 * @returns {Promise<Response>}
 */
export async function fetchFile(taskId, fileName) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s for files
  try {
    // Try official scoring endpoint first
    let res = await fetch(`${BASE_URL}/files/${taskId}`, { signal: controller.signal });
    
    if (res.status === 404 && process.env.HF_TOKEN) {
      const ext = fileName?.split(".").pop();
      if (ext) {
        const hfUrl = `https://huggingface.co/datasets/gaia-benchmark/GAIA/resolve/main/2023/validation/${taskId}.${ext}`;
        const fallbackRes = await fetch(hfUrl, {
          headers: { "Authorization": `Bearer ${process.env.HF_TOKEN}` },
          signal: controller.signal
        });
        
        if (fallbackRes.ok) return fallbackRes;
      }
    }
    if (res.status === 404) return null;
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Submit answers to the GAIA scoring endpoint.
 * @param {string}  username     — Your Hugging Face username
 * @param {string}  agentCodeUrl — Public URL to your agent's source code
 * @param {Array<{task_id: string, submitted_answer: string}>} answers
 * @returns {Promise<{score: number, correct: number, total: number, details: Array}>}
 */
export async function submitAnswers(username, agentCodeUrl, answers) {
  const payload = {
    username,
    agent_code: agentCodeUrl,
    answers,
  };

  const res = await fetch(`${BASE_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Submission failed: ${res.status} ${res.statusText}\n${body}`);
  }
  
  const data = await res.json();
  console.log("Submission successful:", data);
  
  // Normalize return object for index.js
  return {
    ...data,
    total: data.total_attempted ?? data.total ?? 0,
    correct: data.correct_count ?? data.correct ?? 0,
    score: data.score ?? (data.correct_count / data.total_attempted) ?? 0
  };
}
