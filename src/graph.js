import "./env.js";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import ModelClient, { isUnexpected } from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { allTools } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

// SYSTEM_PROMPT is now imported from ./prompts.js

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
  current_model_key: Annotation({
    reducer: (_curr, update) => update,
    default: () => "groq",
  }),
});

// Global state to persist across tasks (questions)
let persistent_model_key = "gemini";

// ── Model Pool (Free Tier Optimization) ──────────────────────────────
const groqModel = new ChatGroq({
  model: "llama-3.3-70b-versatile",
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0,
});

const geminiModel = new ChatGoogleGenerativeAI({
  model: "gemini-3-flash-preview", // Use 2.0 Flash for speed and capabilities
  apiKey: process.env.GOOGLE_API_KEY,
  maxRetries: 1, // Let our own loop handle retries/fallbacks
  temperature: 0,
});

// Initialize GitHub Model Client
const githubToken = process.env.GITHUB_TOKEN;
const githubEndpoint = "https://models.inference.ai.azure.com";
const githubClient = ModelClient(githubEndpoint, new AzureKeyCredential(githubToken));

// Legacy ChatOpenAI instance for other models or as a fallback
const githubModel = new ChatOpenAI({
  modelName: "gpt-4o",
  apiKey: githubToken,
  configuration: { baseURL: githubEndpoint },
  temperature: 0, 
});

const hfModel = new ChatOpenAI({
  modelName: "Qwen/Qwen2.5-72B-Instruct",
  apiKey: process.env.HF_TOKEN,
  configuration: { baseURL: "https://api-inference.huggingface.co/models/Qwen/Qwen2.5-72B-Instruct/v1" },
  temperature: 0,
});

const nvidiaModel = new ChatOpenAI({
  modelName: "minimaxai/minimax-m2.7",
  apiKey: process.env.NVIDIA_API_KEY,
  configuration: { baseURL: "https://integrate.api.nvidia.com/v1" },
  temperature: 0.1, // Slight temperature for better reasoning flexibility
  maxTokens: 8192,
});

// Fast model for formatting
const miniLlm = new ChatGroq({
  model: "llama-3.1-8b-instant",
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0,
});

/** 
 * Clean messages to ensure cross-provider compatibility.
 * Prevents "Invalid value: 'functionCall'" errors when switching between Gemini and OpenAI-style providers.
 */
/** 
 * Clean messages to ensure cross-provider compatibility.
 * Prevents "Invalid value: 'functionCall'" errors and handles vision content.
 */
function sanitizeMessages(messages, targetModelId) {
  return messages.map((m) => {
    const type = m._getType ? m._getType() : m.type;
    
    // 1. Fix tool_calls and additional_kwargs for AI messages
    if (type === "ai") {
      const toolCalls = m.tool_calls || [];
      const additionalKwargs = { ...m.additional_kwargs };
      
      delete additionalKwargs.function_call;
      delete additionalKwargs.functionCall;

      return new AIMessage({
        content: m.content,
        tool_calls: toolCalls,
        additional_kwargs: additionalKwargs,
        name: m.name,
      });
    }
    
    // 2. Fix Human messages (ensure content is valid for target model)
    if (type === "human") {
        let content = m.content;
        
        // If content is an array (vision) but target model is not Gemini, extract text only
        if (Array.isArray(content) && targetModelId !== "gemini") {
            const textPart = content.find(p => p.type === "text");
            content = textPart ? textPart.text : JSON.stringify(content);
        }

        return new HumanMessage({
            content: content,
            name: m.name,
        });
    }

    // 3. Fix System messages
    if (type === "system") {
        return new SystemMessage({
            content: m.content,
            name: m.name,
        });
    }

    // 4. Fix Tool messages
    if (type === "tool") {
        return new ToolMessage({
            content: m.content,
            tool_call_id: m.tool_call_id,
            name: m.name,
        });
    }
    
    return m;
  });
}

/** Router: Picks the prioritized list of models per question */
export function getModelPool(question = "", filePath = "") {
  const q = question.toLowerCase();
  
  // Vision tasks - ONLY models that support vision
  if (filePath && /\.(png|jpg|jpeg|gif|webp)$/i.test(filePath)) {
    return [
      { id: "gemini", model: geminiModel },
      { id: "nvidia", model: nvidiaModel }, // Some Nvidia models might support text-only, but we'll try Gemini first
      { id: "hf", model: hfModel }
    ];
  }

  // YouTube/Large Files
  if (q.includes("youtube.com") || q.includes("youtu.be") || (filePath && /\.(pdf|xlsx|csv|xls|docx)$/i.test(filePath))) {
    return [
      { id: "gemini", model: geminiModel },
      { id: "groq", model: groqModel },
      { id: "nvidia", model: nvidiaModel },
      { id: "hf", model: hfModel }
    ];
  }

  // General Reasoning (Tiered) - Gemini is fast and handles tools well
  return [
    { id: "gemini", model: geminiModel },
    { id: "groq", model: groqModel },
    { id: "nvidia", model: nvidiaModel },
    { id: "hf", model: hfModel }
  ];
}

/** Router: Picks the right model per question (Legacy/Reference) */
export function pickModel(question = "", filePath = "") {
  const q = question.toLowerCase();

  if (filePath && /\.(png|jpg|jpeg|gif|webp)$/i.test(filePath)) {
    return geminiModel;
  }

  if (q.includes("youtube.com") || q.includes("youtu.be")) {
    return geminiModel;
  }

  if (filePath && /\.(pdf|xlsx|csv|xls|docx)$/i.test(filePath)) {
    return geminiModel;
  }

  if (q.includes("calculate") || q.includes("how many") ||
    q.includes("exact") || q.includes("list") ||
    q.includes("math") || q.length > 500) {
    return githubModel;
  }

  return groqModel;
}

// ── Step 3: Node implementations ─────────────────────────────────────

/** Helper to prune messages if they exceed character limits */
function pruneMessages(messages, charLimit = 25000) {
  const getLen = (m) => typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  const totalChars = messages.reduce((acc, m) => acc + getLen(m), 0);
  
  if (totalChars <= charLimit) return messages;

  console.warn(`✂️ Pruning message history (${totalChars} chars)...`);
  
  // Always keep:
  // 1. The System Message (index 0)
  // 2. The FIRST Human Message (the actual question/task)
  const sysMsg = messages[0];
  const firstHumanMsg = messages.find(m => (m._getType ? m._getType() : m.type) === "human");
  
  const others = messages.filter(m => m !== sysMsg && m !== firstHumanMsg);
  const prunedOthers = [];
  let currentChars = getLen(sysMsg) + (firstHumanMsg ? getLen(firstHumanMsg) : 0);
  
  // Add messages from the end (most recent) until we hit the limit
  for (let i = others.length - 1; i >= 0; i--) {
    const m = others[i];
    const len = getLen(m);
    if (currentChars + len > charLimit) {
      if (prunedOthers.length > 0) break;
    }
    prunedOthers.unshift(m);
    currentChars += len;
  }
  
  // Reconstruct
  const result = [sysMsg];
  if (firstHumanMsg) result.push(firstHumanMsg);
  
  // Ensure we don't start the 'others' list with a ToolMessage without its corresponding AI message
  while (prunedOthers.length > 0 && (prunedOthers[0]._getType ? prunedOthers[0]._getType() : prunedOthers[0].type) === "tool") {
      prunedOthers.shift();
  }
  
  result.push(...prunedOthers);
  console.log(`✅ Pruned to ${result.length} messages (~${currentChars} chars). Task preserved.`);
  return result;
}

/** Thinking Node: Calls LLM with automatic fallback logic. */
const agent = async (state) => {
  const pool = getModelPool(state.question, state.file_path);
  let response = null;
  let lastError = null;

  // 1. Ensure a SINGLE SystemMessage is at the very top
  const systemMessages = state.messages.filter(m => (m._getType ? m._getType() : m.type) === "system");
  const nonSystemMessages = state.messages.filter(m => (m._getType ? m._getType() : m.type) !== "system");
  const activeSystemMessage = systemMessages.length > 0 ? systemMessages[0] : new SystemMessage(SYSTEM_PROMPT);
  const baseMessages = [activeSystemMessage, ...nonSystemMessages];

  // Find where to start in the pool
  const preferredKey = state.current_model_key || persistent_model_key;
  let startIndex = pool.findIndex(m => m.id === preferredKey);
  if (startIndex === -1) startIndex = 0;

  let finalKey = preferredKey;
  const CHAR_LIMIT = 25000;

  for (let i = 0; i < pool.length; i++) {
    const idx = (startIndex + i) % pool.length;
    const { id, model } = pool[idx];
    
    // 2. Sanitize and Prune for THIS specific model
    let processedMessages = sanitizeMessages(baseMessages, id);
    processedMessages = pruneMessages(processedMessages, CHAR_LIMIT);

    try {
      const modelName = model.modelName || model.model || id;
      console.log(`🧠 Agent is thinking using ${modelName} (Pool Index: ${idx})...`);
      
      // Bind tools with tool_choice: 'auto' so the LLM can freely decide
      // whether to use tools or answer directly from its own knowledge
      const boundModel = model.bindTools(allTools);
      const start = Date.now();
      
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => 
        timeoutId = setTimeout(() => reject(new Error(`Model ${id} timed out after 120s`)), 120000)
    );

      response = await Promise.race([
        boundModel.invoke(processedMessages),
        timeoutPromise
      ]);
      
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`⏱️ ${id} responded in ${duration}s.`);
      
      if (response && (response.content || response.tool_calls?.length > 0)) {
        // Repair JSON content tool call
        if (typeof response.content === "string" && response.content.trim().startsWith("{") && (!response.tool_calls || response.tool_calls.length === 0)) {
          try {
            const parsed = JSON.parse(response.content);
            if (parsed.recipient_name && parsed.parameters) {
              console.warn(`🔧 Repairing JSON content tool call: ${parsed.recipient_name}`);
              response.tool_calls = [{
                id: "call_" + Math.random().toString(36).substring(2, 11),
                name: parsed.recipient_name,
                args: parsed.parameters
              }];
              response.content = ""; 
            }
          } catch (e) { }
        }

        finalKey = id;
        persistent_model_key = id; 
        break; 
      }
    } catch (err) {
      lastError = err;
      const errMsg = err.message || String(err);
      
      if (err.status === 429 || errMsg.includes("limit") || errMsg.includes("quota") || errMsg.includes("429")) {
        console.warn(`⚠️ Model limit hit for ${id}. Waiting 2s before switching...`);
        await new Promise(r => setTimeout(r, 2000));
        continue; 
      }
      
      console.error(`❌ Error with ${id}:`, errMsg.substring(0, 200));
      continue; 
    }
  }

  if (!response) {
    console.error("💀 ALL MODELS IN POOL EXHAUSTED.");
    throw lastError || new Error("All models in pool failed.");
  }

  const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
  const hasToolCalls = response.tool_calls?.length > 0;
  
  if (hasToolCalls) {
    console.log(`🛠️ Agent decided to use tools: ${response.tool_calls.map(tc => tc.name).join(", ")}`);
  } else if (content && content.trim()) {
    console.log(`💡 Agent answering directly (no tools needed)`);
    console.log(`🤖 Response preview: ${content.substring(0, 150)}...`);
  }
  return { 
    messages: [response],
    current_model_key: finalKey
  };
};

/** Tool Execution Node: Built-in handler for tool calls. */
const toolNode = new ToolNode(allTools);

/** Formatting Node: Distills the final answer for GAIA exact-match. */
const formatter = async (state) => {
  const lastMessage = state.messages.at(-1);
  const rawContent = Array.isArray(lastMessage.content)
    ? lastMessage.content.map((b) => b.text ?? "").join("\n")
    : lastMessage.content;

  // 1. Attempt regex extraction for official GAIA template
  const finalAnswerRegex = /FINAL\s*ANSWER:\s*\[?(.*?)\]?$/im;
  const match = rawContent.match(finalAnswerRegex);
  
  if (match && match[1]) {
    const extracted = match[1].trim();
    if (extracted) {
      console.log(`🎯 Extracted template answer: ${extracted}`);
      return { final_answer: extracted };
    }
  }

  // 2. Fallback to LLM extraction if template missing or empty
  console.log("⚠️ FINAL ANSWER template missing. Falling back to LLM extraction...");
  const extractionPrompt = `You are a GAIA benchmark grader. Extract the BARE FINAL ANSWER from the text below. 

Rules:
1. Respond ONLY with the exact answer string.
2. No conversational filler (no "The answer is...", no "Here is...").
3. No units unless required for a numeric match.
4. If the answer is a list, separate with commas.

Response to extract from:
${rawContent}`;

  const response = await miniLlm.invoke([new HumanMessage(extractionPrompt)]);
  return { final_answer: response.content.trim() };
};

// ── Step 4: Router — decides "use tools" or "format final answer" ────
const router = (state) => {
  const last = state.messages.at(-1);
  const calls = last?.tool_calls ?? [];
  
  if (calls.length > 0) {
    console.log(`🔀 Router → tools (${calls.length} tool call(s) pending)`);
    return "tools";
  }
  
  console.log(`🔀 Router → formatter (agent provided direct answer)`);
  return "formatter";
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
