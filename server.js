import express from "express";
import ytdlp from "yt-dlp-exec";
import { spawn } from "child_process";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 10 }));
app.use(express.json());

const jobs = new Map();

const cleanupJob = (jobId) => {
  const job = jobs.get(jobId);
  if (job) {
    job.emitter.removeAllListeners();
    if (job.ytdlp) job.ytdlp.kill();
    if (job.ffmpeg) job.ffmpeg.kill();
    jobs.delete(jobId);
  }
};

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "YouTube downloader backend running" });
});

// Start download
app.post("/start-download", async (req, res) => {
  const { url, format: reqFormat } = req.body;
  const format = (reqFormat || "mp3").toLowerCase();

  if (!url) return res.status(400).json({ error: "No URL provided" });
  if (!["mp3", "mp4"].includes(format)) return res.status(400).json({ error: "Invalid format" });

  const jobId = uuidv4();
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter, status: "initializing", progress: 0, error: null });

  // Get title
  let title = "download";
  try {
    const info = await ytdlp(url, { dumpSingleJson: true });
    if (info?.title) {
      title = info.title.replace(/[^a-zA-Z0-9 ]/g, "").substring(0, 50);
    }
  } catch (err) {
    console.error("Title fetch failed:", err.message);
  }

  res.json({ jobId, title });

  // Start processes
  const ytdlpArgs = {
    output: "-",
    format: format === "mp3"
      ? "bestaudio"
      : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
  };

  const ytdlpProcess = ytdlp(url, ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });

  let ffmpegArgs = ["-i", "pipe:0"];
  if (format === "mp3") ffmpegArgs.push("-f", "mp3", "pipe:1");
  else ffmpegArgs.push("-c", "copy", "-f", "mp4", "pipe:1");

  const ffmpeg = spawn("ffmpeg", ffmpegArgs);

  const job = jobs.get(jobId);
  job.ytdlp = ytdlpProcess;
  job.ffmpeg = ffmpeg;
  job.title = title;
  job.format = format;

  ytdlpProcess.stdout.pipe(ffmpeg.stdin);

  ffmpeg.on("close", (code) => {
    if (code === 0) {
      job.status = "complete";
    } else {
      job.error = `ffmpeg failed with code ${code}`;
    }
    setTimeout(() => cleanupJob(jobId), 60000);
  });
});

// Progress SSE
app.get("/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send("Job not found");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify({ status: job.status, progress: job.progress, error: job.error })}\n\n`);

  const listener = (update) => res.write(`data: ${JSON.stringify(update)}\n\n`);
  job.emitter.on("update", listener);

  req.on("close", () => {
    job.emitter.removeListener("update", listener);
    res.end();
  });
});

// Download
app.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.ffmpeg) return res.status(404).json({ error: "Job not found or not started" });

  const ext = job.format === "mp4" ? "mp4" : "mp3";
  res.setHeader("Content-Disposition", `attachment; filename="${job.title || "download"}.${ext}"`);
  res.setHeader("Content-Type", job.format === "mp4" ? "video/mp4" : "audio/mpeg");

  job.ffmpeg.stdout.pipe(res);

  req.on("close", () => cleanupJob(req.params.jobId));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
