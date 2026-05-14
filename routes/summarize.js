import express from "express";
import { fetchTranscript, extractKeywords, groqSummarize } from "../lib/summarize-core.js";

const router = express.Router();

// ── Auth check ────────────────────────────────────────────────────────────────
router.get("/check", (req, res) => res.json({ ok: true }));

// ── SSE streaming endpoint ────────────────────────────────────────────────────
router.get("/stream", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let closed = false;
  req.on("close", () => { closed = true; });

  const emit = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // ── Step 1: fetch transcript ──────────────────────────────────────────
    emit("step", { pct: 20, message: "Fetching YouTube captions…" });
    const transcript = await fetchTranscript(url);

    if (closed) return res.end();

    // ── Step 2: extract keywords ──────────────────────────────────────────
    emit("step", { pct: 50, message: "Extracting keywords…" });
    const keywords = extractKeywords(transcript);

    if (closed) return res.end();

    // ── Step 3: AI summary via Groq ───────────────────────────────────────
    emit("step", { pct: 70, message: "AI is summarizing with Llama 3…" });
    const summary = await groqSummarize(transcript);

    emit("step", { pct: 95, message: "Building your results…" });
    emit("result", { keywords, summary });
    res.end();

  } catch (err) {
    const detail = err.message || err.stderr || JSON.stringify(err);
    console.error("Summarize error:", detail);
    if (!closed) {
      emit("error", { message: detail || "Summarization failed. Please try again." });
      res.end();
    }
  }
});

export default router;
