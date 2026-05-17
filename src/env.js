// src/env.js - single source of truth for loading environment variables
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Always load the project-root .env, regardless of current working directory.
dotenv.config({ path: path.resolve(__dirname, "../.env") });

