import express from "express";
import { summarizeUrl, parseVTT, extractKeywords, groqSummarize } from "../lib/summarize-core.js";
import { create as createYtdl } from "youtube-dl-exec";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

const ytdlpPath = process.env.YTDLP_PATH || path.join(__dirname, "..", "yt-dlp.exe");
const youtubedl = createYtdl(ytdlpPath);

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
  let subsFile = null;
  req.on("close", () => { closed = true; });

  const emit = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const cleanup = () => {
    if (subsFile) { try { fs.unlinkSync(subsFile); } catch {} subsFile = null; }
  };

  try {
    // ── Step 1: fetch captions ────────────────────────────────────────────
    emit("step", { pct: 15, message: "Fetching YouTube captions…" });

    const subsDir = path.join(__dirname, "..", "downloads", "subs");
    fs.mkdirSync(subsDir, { recursive: true });
    const tmpId = `sub_${Date.now()}`;
    const outputTemplate = path.join(subsDir, tmpId);

    await youtubedl(
      url,
      {
        writeAutoSubs: true,
        writeSubs: true,
        subFormat: "vtt",
        subLang: "en",
        skipDownload: true,
        output: outputTemplate,
        noCheckCertificates: true,
        noWarnings: true,
        quiet: true,
      },
    );

    if (closed) { cleanup(); return; }

    const allFiles = fs.readdirSync(subsDir).filter((f) => f.startsWith(tmpId));
    const vttFiles = allFiles.filter((f) => f.endsWith(".vtt"));

    allFiles.filter((f) => !f.endsWith(".vtt"))
      .forEach((f) => { try { fs.unlinkSync(path.join(subsDir, f)); } catch {} });

    if (!vttFiles.length) {
      emit("error", { message: "No captions found for this video. Try a video that has subtitles or auto-generated captions enabled." });
      return res.end();
    }

    subsFile = path.join(subsDir, vttFiles[0]);
    const vttContent = fs.readFileSync(subsFile, "utf-8");
    cleanup();

    const transcript = parseVTT(vttContent);

    if (transcript.length < 100) {
      emit("error", { message: "Transcript too short to summarize." });
      return res.end();
    }

    if (closed) return res.end();

    // ── Step 2: extract keywords locally ─────────────────────────────────
    emit("step", { pct: 45, message: "Extracting keywords…" });
    const keywords = extractKeywords(transcript);

    if (closed) return res.end();

    // ── Step 3: AI summary via Groq ───────────────────────────────────────
    emit("step", { pct: 65, message: "AI is summarizing with Llama 3…" });
    const summary = await groqSummarize(transcript);

    emit("step", { pct: 95, message: "Building your results…" });
    emit("result", { keywords, summary });
    res.end();

  } catch (err) {
    cleanup();
    const detail = err.message || err.stderr || JSON.stringify(err);
    console.error("Summarize error:", detail);
    if (!closed) {
      emit("error", { message: detail || "Summarization failed. Please try again." });
      res.end();
    }
  }
});

export default router;
