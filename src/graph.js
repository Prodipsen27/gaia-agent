import "./env.js";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGroq } from "@langchain/groq";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { HuggingFaceInference } from "@langchain/community/llms/hf";
import { allTools } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.resolve(__dirname, "../tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const githubEndpoint = "https://models.inference.ai.azure.com";

const github = new ChatOpenAI({
  modelName: "gpt-4o",
  apiKey: process.env.GITHUB_TOKEN,
  configuration: { baseURL: githubEndpoint },
  temperature: 0,
});

const githubMini = new ChatOpenAI({
  modelName: "gpt-4o-mini",
  apiKey: process.env.GITHUB_TOKEN,
  configuration: { baseURL: githubEndpoint },
  temperature: 0,
});

const groq = new ChatGroq({
  model: "openai/gpt-oss-20b",
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0,
  maxRetries: 1,
});

const hf = new ChatOpenAI({
  modelName: "Qwen/Qwen2.5-72B-Instruct",
  apiKey: process.env.HF_TOKEN,
  configuration: {
    baseURL: "https://router.huggingface.co/v1",
    defaultHeaders: {
      "X-HF-Provider": "novita",
    },
  },
  temperature: 0,
});
const gemini = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash",
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 0,
  maxRetries: 1,
});

const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: (curr, update) => curr.concat(update),
    default: () => [],
  }),
  task_id: Annotation({
    reducer: (_curr, update) => update,
    default: () => "",
  }),
  question: Annotation({
    reducer: (_curr, update) => update,
    default: () => "",
  }),
  file_path: Annotation({
    reducer: (_curr, update) => update,
    default: () => null,
  }),
  final_answer: Annotation({
    reducer: (_curr, update) => update,
    default: () => "",
  }),
  current_model_key: Annotation({
    reducer: (_curr, update) => update,
    default: () => "github",
  }),
  tool_rounds: Annotation({
    reducer: (curr, update) => curr + update,
    default: () => 0,
  }),
});

function sanitizeMessages(messages, targetModelId) {
  return messages.map((m) => {
    const type = m._getType ? m._getType() : m.type;

    if (type === "ai") {
      const additionalKwargs = { ...(m.additional_kwargs || {}) };
      delete additionalKwargs.function_call;
      delete additionalKwargs.functionCall;
      return m;
    }

    if (type === "human") {
      let content = m.content;
      // Only Gemini receives multimodal arrays; other models get text only.
      if (Array.isArray(content) && targetModelId !== "gemini") {
        const textPart = content.find((p) => p.type === "text");
        content = textPart ? textPart.text : JSON.stringify(content);
      }
      return new HumanMessage({ content, name: m.name });
    }

    if (type === "system") {
      return new SystemMessage({ content: m.content, name: m.name });
    }

    return m;
  });
}

function buildModelPool(question, filePath) {
  const q = String(question || "").toLowerCase();
  const isImage = !!filePath && /\.(png|jpg|jpeg|gif|webp)$/i.test(filePath);
  const isVideo = q.includes("youtube.com") || q.includes("youtu.be");

  const pool = [];

  // Vision or video tasks: Gemini is the primary choice if the key is available
  if ((isImage || isVideo) && process.env.GOOGLE_API_KEY) {
    pool.push({ id: "gemini", model: gemini });
  }

  // Add the high-quality text + tool models to the pool as primary or robust fallbacks
  if (process.env.GITHUB_TOKEN) pool.push({ id: "github", model: github });
  if (process.env.GROQ_API_KEY) pool.push({ id: "groq", model: groq });
  if (process.env.HF_TOKEN) pool.push({ id: "hf", model: hf });

  // If pool is empty but we have Gemini, add Gemini as fallback
  if (pool.length === 0 && process.env.GOOGLE_API_KEY) {
    pool.push({ id: "gemini", model: gemini });
  }

  return pool;
}

const agent = async (state) => {
  const pool = buildModelPool(state.question, state.file_path);
  if (pool.length === 0) {
    throw new Error(
      "No models available. Set GITHUB_TOKEN and/or GROQ_API_KEY and/or HF_TOKEN (and GOOGLE_API_KEY for vision).",
    );
  }

  const hasSystem = state.messages[0]?._getType?.() === "system";
  const baseMessages = hasSystem
    ? state.messages
    : [new SystemMessage(SYSTEM_PROMPT), ...state.messages];

  const qPreview = String(state.question || "").replace(/\s+/g, " ").slice(0, 160);

  let lastErr = null;
  for (const { id, model } of pool) {
    console.log(`🧠 Thinking (${id}) task=${state.task_id || "?"} q="${qPreview}"`);
    const bound = model.bindTools(allTools);
    const messages = sanitizeMessages(baseMessages, id);

    try {
      const response = await bound.invoke(messages);
      const toolNames = response?.tool_calls?.map((tc) => tc.name).filter(Boolean) ?? [];
      if (toolNames.length > 0) {
        console.log(`🛠️ Tool calls requested: ${toolNames.join(", ")}`);
      } else {
        const contentPreview = String(response?.content ?? "").replace(/\s+/g, " ").slice(0, 160);
        console.log(`💬 Direct response preview: "${contentPreview}"`);
      }
      return { messages: [response], current_model_key: id };
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      const status = err?.status;
      const looksLikeQuota =
        status === 429 || /429|quota|rate|limit|too many requests|insufficient_quota/i.test(msg);
      console.log(`⚠️ Model failed (${id})${looksLikeQuota ? " [quota/rate]" : ""}: ${msg.slice(0, 180)}`);
      continue;
    }
  }

  throw lastErr || new Error("All models in pool failed.");
};

const toolByName = new Map(allTools.map((t) => [t.name, t]));

function clampToolOutput(out, { taskId, toolName } = {}) {
  const text = out == null ? "" : typeof out === "string" ? out : JSON.stringify(out);
  const limit = 4000;
  if (text.length <= limit) return text;

  const safeTask = String(taskId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const safeTool = String(toolName || "tool").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const filePath = path.join(TMP_DIR, `tool_output_${safeTask}_${safeTool}_${Date.now()}.txt`);
  try {
    fs.writeFileSync(filePath, text, "utf-8");
  } catch {
    // If persisting fails, we still truncate.
  }

  return `${text.slice(0, limit)}\n\n[TRUNCATED: ${text.length} chars total. Full output saved to: ${filePath}]`;
}

const toolsNode = async (state) => {
  const nextRounds = (state.tool_rounds ?? 0) + 1;
  console.log(`🔁 Tool round ${nextRounds}`);
  const last = state.messages.at(-1);
  const calls = last?.tool_calls ?? [];
  console.log(`🔧 Executing ${calls.length} tool call(s)...`);

  const toolMessages = [];
  for (const call of calls) {
    const tool = toolByName.get(call.name);
    if (!tool) {
      console.log(`⚠️ Unknown tool: ${call.name}`);
      toolMessages.push(
        new ToolMessage({
          tool_call_id: call.id,
          content: `ERROR: Unknown tool "${call.name}"`,
        }),
      );
      continue;
    }

    const started = Date.now();
    console.log(`➡️ Tool start: ${call.name}`);
    try {
      const out = await tool.invoke(call.args ?? {});
      const duration = ((Date.now() - started) / 1000).toFixed(1);
      const outPreview = String(out ?? "").replace(/\s+/g, " ").slice(0, 160);
      console.log(`✅ Tool done: ${call.name} (${duration}s) preview="${outPreview}"`);
      const content = clampToolOutput(out, { taskId: state.task_id, toolName: call.name });
      toolMessages.push(new ToolMessage({ tool_call_id: call.id, content }));
    } catch (err) {
      const duration = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`❌ Tool error: ${call.name} (${duration}s) err="${err.message}"`);
      toolMessages.push(
        new ToolMessage({
          tool_call_id: call.id,
          content: `ERROR: ${err.message}`,
        }),
      );
    }
  }

  return { messages: toolMessages, tool_rounds: 1 };
};

const formatter = async (state) => {
  const last = state.messages.at(-1);
  const raw = Array.isArray(last?.content)
    ? last.content.map((b) => b.text ?? "").join("\n")
    : String(last?.content ?? "");

  const match = raw.match(/FINAL ANSWER:\s*(.+?)(?:\n|$)/i);
  if (match) {
    const extracted = match[1].trim();
    console.log(`✅ Final answer extracted: ${extracted}`);
    return { final_answer: extracted };
  }

  const isBad =
    raw.length < 3 ||
    raw.toLowerCase().includes("i cannot") ||
    raw.toLowerCase().includes("i am unable") ||
    raw.match(/^[a-zA-Z0-9_-]{11}$/);

  const prompt = isBad
    ? `Failed to answer: '${state.question}'. Best guess? FINAL ANSWER: [answer]`
    : `Extract final answer only. FINAL ANSWER: [answer]\n\n${raw}`;

  let recovery;
  try {
    recovery = await githubMini.invoke([new HumanMessage(prompt)]);
  } catch (e) {
    recovery = await groq.invoke([new HumanMessage(prompt)]);
  }

  const text =
    typeof recovery.content === "string"
      ? recovery.content
      : recovery.content.map((b) => b.text ?? "").join("");

  const m = text.match(/FINAL ANSWER:\s*(.+?)(?:\n|$)/i);
  const finalAnswer = m ? m[1].trim() : text.trim();
  console.log(`✅ Final answer formatted: ${finalAnswer}`);
  return { final_answer: finalAnswer };
};

const router = (state) => {
  const last = state.messages.at(-1);
  const calls = last?.tool_calls ?? [];
  const rounds = state.tool_rounds ?? 0;
  if (rounds >= 6) {
    console.log(`🛑 Tool budget reached (${rounds}). Forcing formatter.`);
    return "formatter";
  }
  if (calls.length > 0) {
    console.log(`🔀 Router -> tools (${calls.length} pending)`);
    return "tools";
  }
  console.log("🔀 Router -> formatter");
  return "formatter";
};

const graph = new StateGraph(AgentState)
  .addNode("agent", agent)
  .addNode("tools", toolsNode)
  .addNode("formatter", formatter)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", router)
  .addEdge("tools", "agent")
  .addEdge("formatter", END);

const app = graph.compile();

export { app, AgentState };
