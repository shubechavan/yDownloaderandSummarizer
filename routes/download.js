import express from "express";
import crypto from "crypto";
import Job from "../models/Job.js";

const router = express.Router();

const GH_OWNER  = process.env.GITHUB_OWNER || "shubechavan";
const GH_REPO   = process.env.GITHUB_REPO  || "yDownloaderandSummarizer";
const GH_PAT    = process.env.GH_PAT;
const RENDER_URL = process.env.RENDER_URL   || "http://localhost:5000";
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;

// ── Video metadata preview (YouTube oEmbed — no yt-dlp needed) ───────────────
router.get("/meta", async (req, res) => {
  const { videoUrl } = req.query;
  if (!videoUrl) return res.status(400).json({ message: "Missing videoUrl" });

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
    const r = await fetch(oembedUrl);
    if (!r.ok) return res.status(404).json({ message: "Video not found" });
    const data = await r.json();
    res.json({
      title:     data.title,
      thumbnail: data.thumbnail_url,
      channel:   data.author_name,
      duration:  null, // oEmbed doesn't provide duration
    });
  } catch (err) {
    console.error("Meta fetch error:", err.message);
    res.status(500).json({ message: "Could not fetch video info" });
  }
});

// ── Trigger a download job (offloaded to GitHub Actions) ──────────────────────
router.post("/trigger", async (req, res) => {
  const { videoUrl, downloadType = "video", format = "mp4" } = req.body;
  if (!videoUrl) return res.status(400).json({ error: "Missing videoUrl" });

  if (!GH_PAT) {
    return res.status(503).json({ error: "Download service not configured (GH_PAT missing)" });
  }

  const jobId = crypto.randomUUID();

  try {
    await Job.create({ jobId });
  } catch (err) {
    return res.status(500).json({ error: "Failed to create job" });
  }

  const callbackUrl = `${RENDER_URL}/download/callback`;

  // Fire-and-forget — trigger GitHub Actions via repository_dispatch
  fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GH_PAT}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "download-request",
      client_payload: { videoUrl, downloadType, format, jobId, callbackUrl },
    }),
  }).catch((err) => console.error("Failed to trigger GH Actions:", err.message));

  res.json({ jobId });
});

// ── Poll job status ───────────────────────────────────────────────────────────
router.get("/status/:jobId", async (req, res) => {
  try {
    const job = await Job.findOne({ jobId: req.params.jobId }).lean();
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ status: job.status, downloadUrl: job.downloadUrl, ext: job.ext, error: job.error });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch job status" });
  }
});

// ── Callback from GitHub Actions ──────────────────────────────────────────────
router.post("/callback", async (req, res) => {
  const secret = req.headers["x-callback-secret"];
  if (!CALLBACK_SECRET || secret !== CALLBACK_SECRET) {
    return res.status(401).end();
  }

  const { jobId, status, downloadUrl, ext, error } = req.body;
  if (!jobId) return res.status(400).end();

  try {
    await Job.updateOne({ jobId }, { status, downloadUrl, ext, error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update job" });
  }
});

export default router;
