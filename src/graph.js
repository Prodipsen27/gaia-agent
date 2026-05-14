import dotenv from "dotenv";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { allTools } from "./tools.js";
dotenv.config();
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

// ── Step 2: Initialize Models (Gemini) ──────────────────────────────
const llm = new ChatGoogleGenerativeAI({
  model: "gemini-3-flash-preview",
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 0,
  maxOutputTokens: 8192,
});

const miniLlm = new ChatGoogleGenerativeAI({
  model: "gemini-3-flash-preview",
  apiKey: process.env.GOOGLE_API_KEY,
  temperature: 0,
  maxOutputTokens: 1024,
});

const chatWithTools = llm.bindTools(allTools);

// ── Step 3: Node implementations ─────────────────────────────────────

/** Thinking Node: Calls LLM to decide next steps. */
const agent = async (state) => {
  // Prune messages to stay within a reasonable limit (e.g. 100k chars ~ 25k tokens)
  let prunedMessages = [...state.messages];
  const totalChars = prunedMessages.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0);
  
  if (totalChars > 100000) {
    console.log(`✂️ Pruning messages (current total: ${totalChars} chars)...`);
    // Keep System (0) and original Human (1)
    const fixed = [prunedMessages[0], prunedMessages[1]];
    
    // Grab the last few messages, but ensure we don't start with a ToolMessage
    // whose AIMessage was pruned.
    let tailStart = prunedMessages.length - 15; // Increased to 15 for more context
    if (tailStart < 2) tailStart = 2;
    
    // If the tail starts with a ToolMessage, move back until we find the AIMessage
    while (tailStart > 2 && (prunedMessages[tailStart]._getType() === "tool" || prunedMessages[tailStart].tool_calls?.length > 0)) {
      tailStart--;
    }
    
    prunedMessages = [
      ...fixed,
      ...prunedMessages.slice(tailStart)
    ];
  } else if (totalChars > 80000) {
    console.warn(`⚠️ Token Warning: Message history is getting large (${totalChars} chars).`);
  }

  console.log(`🧠 Agent is thinking... (${prunedMessages.length} messages, ${totalChars} chars)`);
  const response = await chatWithTools.invoke(prunedMessages);
  
  const content = typeof response.content === "string" 
    ? response.content 
    : JSON.stringify(response.content);
    
  if (content && content.trim()) {
    console.log(`🤖 Agent thought: ${content.substring(0, 150)}...`);
  }

  if (response.tool_calls?.length > 0) {
    console.log(`🛠️ Agent called tools: ${response.tool_calls.map(tc => tc.name).join(", ")}`);
  } else {
    console.log(`💭 Agent is formulating final response...`);
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
