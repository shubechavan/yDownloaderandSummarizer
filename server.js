import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";

import authRoutes from "./routes/auth.js";
import downloadRoute from "./routes/download.js";
import summarizeRoute from "./routes/summarize.js";
import { summarizeUrl } from "./lib/summarize-core.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, "public")));

// Rate-limit the expensive AI endpoints
const summarizeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests — please wait 15 minutes before summarizing again." },
});
const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { message: "Download limit reached — please wait 10 minutes." },
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "API rate limit reached — please wait 15 minutes." },
});

app.use("/auth", authRoutes);
app.use("/download", downloadLimiter, downloadRoute);
app.use("/summarize/stream", summarizeLimiter);
app.use("/summarize", summarizeRoute);

// ── Public REST API ───────────────────────────────────────────────────────────
// POST /api/summarize  { "url": "https://youtube.com/watch?v=..." }
// Returns: { keywords: [...], summary: [...] }
app.post("/api/summarize", apiLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url in request body" });
  try {
    const result = await summarizeUrl(url);
    res.json(result);
  } catch (err) {
    console.error("API summarize error:", err.message);
    res.status(500).json({ error: err.message || "Summarization failed" });
  }
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.warn("MongoDB connection failed (non-fatal):", err.message));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/summarizer", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "summarizer.html"));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
