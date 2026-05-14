import Firecrawl from "@mendable/firecrawl-js";
const app = new Firecrawl({ apiKey: "test" });
let obj = app;
while (obj) {
    console.log("Keys:", Object.getOwnPropertyNames(obj));
    obj = Object.getPrototypeOf(obj);
}
