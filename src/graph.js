import dotenv from "dotenv";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { allTools } from "./tools.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });


// ── Step 1: Define the State ────────────────────────────────────────
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
});

// ── Model Pool (Free Tier Optimization) ──────────────────────────────
const groqModel = new ChatGroq({
  model: "llama-3.3-70b-versatile",
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0,
});

const geminiModel = new ChatGoogleGenerativeAI({
  model: "gemini-3-flash-preview",
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 0,
});

const githubModel = new ChatOpenAI({
  modelName: "gpt-4o",
  apiKey: process.env.GITHUB_TOKEN,
  configuration: { baseURL: "https://models.inference.ai.azure.com" },
  temperature: 0,
});

const hfModel = new ChatOpenAI({
  modelName: "Qwen/Qwen2.5-72B-Instruct",
  apiKey: process.env.HF_TOKEN,
  configuration: { baseURL: "https://api-inference.huggingface.co/v1" },
  temperature: 0,
});

// Fast model for formatting (using Groq mini or GitHub mini)
const miniLlm = new ChatGroq({
  model: "llama-3.1-8b-instant",
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0,
});

/** Router: Picks the prioritized list of models per question */
export function getModelPool(question = "", filePath = "") {
  const q = question.toLowerCase();
  
  // Vision tasks
  if (filePath && /\.(png|jpg|jpeg|gif|webp)$/i.test(filePath)) {
    return [geminiModel, githubModel]; // GitHub GPT-4o also has vision
  }

  // YouTube/Large Files
  if (q.includes("youtube.com") || q.includes("youtu.be") || (filePath && /\.(pdf|xlsx|csv|xls|docx)$/i.test(filePath))) {
    return [geminiModel, hfModel]; // HF Qwen also has long context
  }

  // General Reasoning (Tiered)
  return [groqModel, githubModel, hfModel];
}

/** Router: Picks the right model per question */
export function pickModel(question = "", filePath = "") {
  const q = question.toLowerCase();

  // 1. Images → Gemini (Superior vision)
  if (filePath && /\.(png|jpg|jpeg|gif|webp)$/i.test(filePath)) {
    console.log(`  🎨 Routing to Gemini (Image task detected)`);
    return geminiModel;
  }

  // 2. YouTube/Video → Gemini (Native multimodal/long context)
  if (q.includes("youtube.com") || q.includes("youtu.be")) {
    console.log(`  📺 Routing to Gemini (YouTube task detected)`);
    return geminiModel;
  }

  // 3. Complex Files (PDF, Excel) → Gemini (Long context window)
  if (filePath && /\.(pdf|xlsx|csv|xls|docx)$/i.test(filePath)) {
    console.log(`  📄 Routing to Gemini (File analysis task detected)`);
    return geminiModel;
  }

  // 4. Hard Reasoning / Exact Math / Counting → GitHub GPT-4o (Most reliable)
  if (q.includes("calculate") || q.includes("how many") ||
    q.includes("exact") || q.includes("list") ||
    q.includes("math") || q.length > 500) {
    console.log(`  🧠 Routing to GitHub (High-precision reasoning task)`);
    return githubModel;
  }

  // 5. Default / Search → Groq (Extreme speed)
  console.log(`  🌐 Routing to Groq (General reasoning/Search task)`);
  return groqModel;
}





// Tools will be bound dynamically in the agent node

// ── Step 3: Node implementations ─────────────────────────────────────

/** Thinking Node: Calls LLM with automatic fallback logic. */
const agent = async (state) => {
  const pool = getModelPool(state.question, state.file_path);
  let response = null;
  let lastError = null;

  // Prune messages to stay within limits
  let prunedMessages = [...state.messages];
  const totalChars = prunedMessages.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0);
  if (totalChars > 100000) {
    const fixed = [prunedMessages[0], prunedMessages[1]];
    let tailStart = Math.max(2, prunedMessages.length - 15);
    while (tailStart > 2 && prunedMessages[tailStart]._getType() === "tool") tailStart--;
    prunedMessages = [...fixed, ...prunedMessages.slice(tailStart)];
  }

  // Iterate through available models in the pool
  for (const model of pool) {
    try {
      const modelName = model.modelName || model.model || "Primary";
      console.log(`🧠 Agent is thinking using ${modelName}...`);
      
      const boundModel = model.bindTools(allTools);
      response = await boundModel.invoke(prunedMessages);
      break; // Success! Exit the pool loop
    } catch (err) {
      lastError = err;
      if (err.status === 429 || err.message.includes("429") || err.message.includes("quota") || err.message.includes("limit")) {
        console.warn(`⚠️ Model limit hit. Switching to next available model in pool...`);
        continue; // Try next model
      }
      throw err; // Critical error, don't fall back
    }
  }

  if (!response) throw lastError || new Error("All models in pool failed.");

  const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  if (content && content.trim()) {
    console.log(`🤖 Agent thought: ${content.substring(0, 150)}...`);
  }

  if (response.tool_calls?.length > 0) {
    console.log(`🛠️ Agent called tools: ${response.tool_calls.map(tc => tc.name).join(", ")}`);
  }
  return { messages: [response] };
};



/** Tool Execution Node: Built-in handler for tool calls. */
const toolNode = new ToolNode(allTools);

/** Formatting Node: Distills the final answer for GAIA exact-match. */
const formatter = async (state) => {
  const lastMessage = state.messages.at(-1);
  const rawContent = Array.isArray(lastMessage.content)
    ? lastMessage.content.map((b) => b.text ?? "").join("\n")
    : lastMessage.content;

  const extractionPrompt = `You are a GAIA benchmark grader. Extract the BARE FINAL ANSWER from the text below. 

Rules:
1. Respond ONLY with the exact answer string.
2. No conversational filler (no "The answer is...", no "Here is...").
3. No units unless required for a numeric match.
4. If the answer is a date, use YYYY-MM-DD or the format requested.
5. If the answer is a list, separate with commas.

Response to extract from:
${rawContent}`;

  const response = await miniLlm.invoke([new HumanMessage(extractionPrompt)]);
  return { final_answer: response.content.trim() };
};

// ── Step 4: Router — decides "keep going" or "we're done" ───────────
const router = (state) => {
  const last = state.messages.at(-1);
  const calls = last?.tool_calls ?? [];
  return calls.length > 0 ? "tools" : "formatter";
};

// ── Step 5: Build & compile the graph ───────────────────────────────
const graph = new StateGraph(AgentState)
  .addNode("agent", agent)
  .addNode("tools", toolNode)
  .addNode("formatter", formatter)

  .addEdge(START, "agent")
  .addConditionalEdges("agent", router)
  .addEdge("tools", "agent")
  .addEdge("formatter", END);

const app = graph.compile();

export { app, AgentState };
