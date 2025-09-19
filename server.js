import express from "express";
import { spawn } from "child_process";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: Restrict to your frontend domain in prod
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));

// Rate limiting: 10 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many requests, please try again later" }
});
app.use(limiter);

// Parse JSON for POST
app.use(express.json());

// In-memory job store (progress emitters; no storage)
const jobs = new Map(); // jobId: { emitter: EventEmitter, status: string, progress: number, error: null, ytdlp, ffmpeg, title: string, format: string }

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
  res.json({ status: "ok", message: "YouTube MP3/MP4 Downloader backend is running" });
});

// Start download (returns jobId for progress and download)
app.post("/start-download", async (req, res) => {
  const { url, format: reqFormat } = req.body;
  const format = (reqFormat || "mp3").toLowerCase();
  if (!url) return res.status(400).json({ error: "No URL provided" });
  if (format !== "mp3" && format !== "mp4") return res.status(400).json({ error: "Invalid format. Use 'mp3' or 'mp4'" });

  // Basic YouTube URL validation
  if (!url.match(/^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/)) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }

  const jobId = uuidv4();
  const emitter = new EventEmitter();
  jobs.set(jobId, { emitter, status: "initializing", progress: 0, error: null, ytdlp: null, ffmpeg: null, title: "download", format });

  // Fetch title async for filename (non-blocking)
  const getTitle = spawn("yt-dlp", ["--get-title", url]);
  getTitle.stdout.on("data", (data) => {
    const job = jobs.get(jobId); // Get fresh reference
    if (job) {
      job.title = data.toString().trim().replace(/[^a-zA-Z0-9 ]/g, "").substring(0, 50);
      job.emitter.emit("update", { title: job.title }); // Optionally send updated title via SSE
    }
  });
  getTitle.on("close", (code) => {
    const job = jobs.get(jobId);
    if (job) {
      if (code !== 0) {
        console.error(`Failed to get title for ${jobId}`);
        job.error = "Failed to fetch title"; // Optional: Set error if critical
      }
      job.status = "processing";
      job.emitter.emit("update", { status: job.status, progress: job.progress, error: job.error });
    }
  });

  res.json({ jobId, title: jobs.get(jobId).title }); // Return early; processes start in background

  // Start processes in background
  try {
    const ext = format === "mp4" ? "mp4" : "mp3";
    let ytdlpArgs = ["-o", "-", url];
    if (format === "mp3") {
      ytdlpArgs = ["-f", "bestaudio", ...ytdlpArgs];
    } else if (format === "mp4") {
      ytdlpArgs = ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", ...ytdlpArgs];
    }

    const ytdlp = spawn("yt-dlp", ytdlpArgs);
    let ffmpegArgs = ["-i", "pipe:0"];
    if (format === "mp3") {
      ffmpegArgs = [...ffmpegArgs, "-f", "mp3", "pipe:1"];
    } else if (format === "mp4") {
      ffmpegArgs = [...ffmpegArgs, "-c", "copy", "-f", "mp4", "pipe:1"];
    }
    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    // Store for cleanup
    const job = jobs.get(jobId);
    job.ytdlp = ytdlp;
    job.ffmpeg = ffmpeg;

    // Critical: Pipe yt-dlp output to ffmpeg input
    ytdlp.stdout.pipe(ffmpeg.stdin);

    // Parse progress from yt-dlp stderr
    ytdlp.stderr.on("data", (data) => {
      const str = data.toString();
      const match = str.match(/\[download\]\s*(\d+\.?\d*)%/);
      if (match) {
        job.progress = parseFloat(match[1]);
        if (job.progress > 90) job.status = "almost ready";
        job.emitter.emit("update", { status: job.status, progress: job.progress });
      }
      console.log(`Progress for ${jobId}: ${str}`);
    });

    ytdlp.on("error", (err) => { job.error = err.message; job.emitter.emit("update", { error: job.error }); });
    ffmpeg.on("error", (err) => { job.error = err.message; job.emitter.emit("update", { error: job.error }); });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        job.status = "complete";
        job.emitter.emit("update", { status: job.status });
      } else {
        job.error = `Failed with code ${code}`;
        job.emitter.emit("update", { error: job.error });
      }
      // Auto-cleanup after 1min
      setTimeout(() => cleanupJob(jobId), 60000);
    });

  } catch (err) {
    const job = jobs.get(jobId);
    job.error = err.message;
    job.emitter.emit("update", { error: job.error });
    cleanupJob(jobId);
  }
});

// SSE for progress updates
app.get("/progress/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).send("Job not found");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Send initial state
  res.write(`data: ${JSON.stringify({ status: job.status, progress: job.progress, error: job.error, title: job.title })}\n\n`);

  // Listener for updates
  const listener = (update) => {
    res.write(`data: ${JSON.stringify(update)}\n\n`);
  };
  job.emitter.on("update", listener);

  // Cleanup on disconnect
  req.on("close", () => {
    job.emitter.removeListener("update", listener);
    if (job.status === "complete" || job.error) cleanupJob(jobId);
    res.end();
  });
});

// Streaming download endpoint
app.get("/download/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job || !job.ytdlp || !job.ffmpeg) return res.status(404).json({ error: "Job not found or not started" });

  // Set headers
  const ext = job.format === "mp4" ? "mp4" : "mp3";
  const contentType = job.format === "mp4" ? "video/mp4" : "audio/mpeg";
  res.setHeader("Content-Disposition", `attachment; filename="${job.title}.${ext}"`);
  res.setHeader("Content-Type", contentType);

  // Pipe the already-running ffmpeg stdout to res
  job.ffmpeg.stdout.pipe(res);

  // Handle end
  job.ffmpeg.on("close", (code) => {
    if (code !== 0) res.status(500).json({ error: "Streaming failed" });
    res.end();
  });

  // Cleanup on client disconnect
  req.on("close", () => {
    cleanupJob(jobId);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
