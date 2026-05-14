// src/api.js — GAIA Benchmark API client
// Endpoints: questions, file downloads, answer submission

const BASE_URL = "https://agents-course-unit4-scoring.hf.space";

/**
 * Fetch all 20 GAIA benchmark questions.
 * @returns {Promise<Array<{task_id: string, question: string, file_name?: string}>>}
 */
export async function fetchQuestions() {
  const res = await fetch(`${BASE_URL}/questions`);
  if (!res.ok) {
    throw new Error(`Failed to fetch questions: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Download the attached file for a given task (if one exists).
 * Returns the raw Response so callers can decide how to consume it
 * (e.g. .text(), .arrayBuffer(), .blob()).
 * @param {string} taskId — The task_id of the question
 * @returns {Promise<Response>}
 */
export async function fetchFile(taskId) {
  const res = await fetch(`${BASE_URL}/files/${taskId}`);
  if (res.status === 404) return null; // no file for this task — that's fine
  if (!res.ok) {
    throw new Error(`Failed to fetch file for task ${taskId}: ${res.status} ${res.statusText}`);
  }
  return res;
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
  return res.json();
}
