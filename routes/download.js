import express from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import Job from "../models/Job.js";

const router = express.Router();

const GH_OWNER        = process.env.GITHUB_OWNER || "shubechavan";
const GH_REPO         = process.env.GITHUB_REPO  || "yDownloaderandSummarizer";
const GH_PAT          = process.env.GH_PAT;
const RENDER_URL      = process.env.RENDER_URL    || "http://localhost:5000";
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;

// In-memory fallback when MongoDB is unavailable
const memJobs = new Map();

function dbReady() {
  return mongoose.connection.readyState === 1;
}

async function createJob(jobId) {
  if (dbReady()) {
    await Job.create({ jobId });
  } else {
    memJobs.set(jobId, { jobId, status: "pending" });
  }
}

async function getJob(jobId) {
  if (dbReady()) {
    return Job.findOne({ jobId }).lean();
  }
  return memJobs.get(jobId) || null;
}

async function updateJob(jobId, fields) {
  if (dbReady()) {
    await Job.updateOne({ jobId }, fields);
  } else {
    const job = memJobs.get(jobId) || { jobId };
    memJobs.set(jobId, { ...job, ...fields });
  }
}

// ── Video metadata preview ────────────────────────────────────────────────────
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
      duration:  null,
    });
  } catch (err) {
    console.error("Meta fetch error:", err.message);
    res.status(500).json({ message: "Could not fetch video info" });
  }
});

// ── cobalt API helper ─────────────────────────────────────────────────────────
const COBALT_INSTANCES = [
  "https://api.cobalt.tools/",
  "https://cobalt.api.hsyl.fr/",
  "https://cobalt.pstream.net/",
];

async function tryCobaltInstance(instance, videoUrl, downloadType) {
  const body = {
    url: videoUrl,
    videoQuality: "1080",
    filenameStyle: "basic",
    downloadMode: downloadType === "audio" ? "audio" : "auto",
    audioFormat:  "mp3",
    audioBitrate: "320",
  };

  const res = await fetch(instance, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept":        "application/json",
      "User-Agent":    "Mozilla/5.0 (compatible; YSummarize/1.0)",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });

  const text = await res.text();
  console.log(`[cobalt] ${instance} → HTTP ${res.status}: ${text.slice(0, 200)}`);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);

  const data = JSON.parse(text);
  if (data.status === "error") throw new Error(data.error?.code || "cobalt error");
  if (data.status === "redirect" || data.status === "tunnel") return data.url;
  if (data.status === "picker" && data.picker?.length) return data.picker[0].url;
  throw new Error(`Unexpected status: ${data.status}`);
}

async function tryCobalt(videoUrl, downloadType, format) {
  for (const instance of COBALT_INSTANCES) {
    try {
      const url = await tryCobaltInstance(instance, videoUrl, downloadType);
      console.log(`[cobalt] Success via ${instance}`);
      return url;
    } catch (err) {
      console.warn(`[cobalt] ${instance} failed: ${err.message}`);
    }
  }
  throw new Error("All cobalt instances failed");
}

// ── Trigger download — cobalt first, GitHub Actions fallback ──────────────────
router.post("/trigger", async (req, res) => {
  const { videoUrl, downloadType = "video", format = "mp4" } = req.body;
  if (!videoUrl) return res.status(400).json({ error: "Missing videoUrl" });

  // ── 1. Try cobalt (instant, no job queue needed) ──────────────────────────
  try {
    console.log(`[cobalt] Trying ${downloadType} download for ${videoUrl}`);
    const downloadUrl = await tryCobalt(videoUrl, downloadType, format);
    console.log(`[cobalt] Success: ${downloadUrl}`);
    return res.json({ downloadUrl, instant: true });
  } catch (err) {
    console.warn("[cobalt] Failed, falling back to GitHub Actions:", err.message);
  }

  // ── 2. Fall back to GitHub Actions ───────────────────────────────────────
  if (!GH_PAT) {
    return res.status(503).json({ error: "Download service unavailable — please try again later." });
  }

  const jobId = crypto.randomUUID();

  try {
    await createJob(jobId);
  } catch (err) {
    console.error("Job create error:", err.message);
    return res.status(500).json({ error: "Failed to create job: " + err.message });
  }

  const callbackUrl = `${RENDER_URL}/download/callback`;

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
    const job = await getJob(req.params.jobId);
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
    await updateJob(jobId, { status, downloadUrl, ext, error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update job" });
  }
});

export default router;
