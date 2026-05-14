import dotenv from "dotenv";
dotenv.config();
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: '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',
  baseURL: 'https://integrate.api.nvidia.com/v1',
})
 
async function main() {
  console.log("🚀 Testing simple NVIDIA call...");
  const completion = await openai.chat.completions.create({
    model: "z-ai/glm4.7",
    messages: [{"role":"user","content":"Hello, who are you?"}],
    temperature: 1,
    top_p: 1,
    max_tokens: 16384,
    stream: true
  })
   
  for await (const chunk of completion) {
    const reasoning = chunk.choices[0]?.delta?.reasoning_content;
    if (reasoning) process.stdout.write(`[Thinking] ${reasoning}`);
    process.stdout.write(chunk.choices[0]?.delta?.content || '')
  }
}

main().catch(console.error);
