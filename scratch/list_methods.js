import Firecrawl from "@mendable/firecrawl-js";
const app = new Firecrawl({ apiKey: "test" });
console.log("Methods:", Object.keys(app).filter(k => typeof app[k] === "function"));
console.log("Proto Methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(app)).filter(k => typeof app[k] === "function"));
