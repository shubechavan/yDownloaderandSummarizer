import express from "express";
import youtubedl from "youtube-dl-exec";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const ytdlpPath = process.env.YTDLP_PATH || path.join(__dirname, "..", "yt-dlp.exe");
const ffmpegPath = process.env.FFMPEG_PATH || "C:\\ffmpeg\\ffmpeg-2025-10-21-git-535d4047d3-full_build\\bin\\ffmpeg.exe";

// Video metadata preview
router.get("/meta", async (req, res) => {
  const { videoUrl } = req.query;
  if (!videoUrl) return res.status(400).json({ message: "Missing videoUrl" });

  try {
    const info = await youtubedl(
      videoUrl,
      { dumpSingleJson: true, noWarnings: true, noCheckCertificates: true, noPlaylist: true, quiet: true },
      { ytDlpPath: ytdlpPath }
    );
    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      channel: info.channel || info.uploader,
    });
  } catch (err) {
    console.error("Meta fetch error:", err.message);
    res.status(500).json({ message: "Could not fetch video info" });
  }
});

// Download
router.get("/", async (req, res) => {
  try {
    const { videoUrl, downloadType = "video", format = "mp4" } = req.query;
    if (!videoUrl) return res.status(400).send("Missing videoUrl");

    const downloadsDir = path.resolve("downloads");
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    const isAudio = downloadType === "audio";
    const ext = isAudio ? "mp3" : format;
    const finalOutputPath = path.join(downloadsDir, `media_${Date.now()}.${ext}`);

    if (!fs.existsSync(ytdlpPath)) return res.status(500).send("yt-dlp not found");

    const options = {
      output: finalOutputPath,
      ffmpegLocation: ffmpegPath,
      noCheckCertificates: true,
      noWarnings: true,
      noPart: true,
      noPlaylist: true,
    };

    if (isAudio) {
      options.extractAudio = true;
      options.audioFormat  = "mp3";
      options.audioQuality = 0;
      options.format       = "bestaudio/best";
    } else {
      options.format            = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";
      options.mergeOutputFormat = format;
    }

    await youtubedl(videoUrl, options, { ytDlpPath: ytdlpPath });

    res.download(finalOutputPath, `media.${ext}`, () => {
      fs.unlink(finalOutputPath, () => {});
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Download failed");
  }
});

export default router;
