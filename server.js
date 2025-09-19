import express from 'express';
import { spawn, execFile } from 'node:child_process';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import sqlite3 from 'sqlite3';
import winston from 'winston';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Initialize logger
const logger = winston.createLogger({
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.Console(),
  ],
});

// Log yt-dlp and ffmpeg versions at startup
execFile('/opt/venv/bin/yt-dlp', ['--version'], (err, stdout, stderr) => {
  if (err) logger.error(`yt-dlp version check failed: ${stderr}`);
  else logger.info(`yt-dlp version: ${stdout.trim()}`);
});
execFile('ffmpeg', ['-version'], (err, stdout, stderr) => {
  if (err) logger.error(`ffmpeg version check failed: ${stderr}`);
  else logger.info(`ffmpeg version: ${stdout.split('\n')[0].trim()}`);
});

// Initialize SQLite
const db = new sqlite3.Database('jobs.db', (err) => {
  if (err) logger.error(`DB connection error: ${err.message}`);
});
db.run(
  'CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT, progress REAL, error TEXT, title TEXT, format TEXT)',
  (err) => {
    if (err) logger.error(`DB table creation error: ${err.message}`);
  }
);

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 10 }));
app.use(express.json());

const jobs = new Map();

// Global error handler to prevent crashes
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
});

// Cleanup job
const cleanupJob = (jobId) => {
  const job = jobs.get(jobId);
  if (job) {
    job.emitter.removeAllListeners();
    if (job.ytdlp) job.ytdlp.kill();
    if (job.ffmpeg) job.ffmpeg.kill();
    jobs.delete(jobId);
    db.run('DELETE FROM jobs WHERE id = ?', [jobId], (err) => {
      if (err) logger.error(`DB cleanup error: ${err.message}`);
    });
  }
};

// Validate and clean URL
const isValidUrl = (url) => {
  try {
    new URL(url);
    return url.includes('youtube.com') || url.includes('youtu.be');
  } catch {
    return false;
  }
};

// Fetch title using yt-dlp
const getTitle = (url) =>
  new Promise((resolve) => {
    const cleanUrl = url.split('&')[0]; // Remove playlist parameters
    execFile('/opt/venv/bin/yt-dlp', ['-j', cleanUrl], (err, stdout, stderr) => {
      if (err) {
        logger.error(`yt-dlp title fetch error: ${stderr}`);
        return resolve('download');
      }
      try {
        const info = JSON.parse(stdout);
        const title = info.title?.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50) || 'download';
        resolve(title);
      } catch (e) {
        logger.error(`JSON parse error: ${e.message}`);
        resolve('download');
      }
    });
  });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'YouTube MP3/MP4 Downloader backend is running' });
});

// Start download
app.post('/start-download', async (req, res) => {
  const { url, format: reqFormat } = req.body;
  const format = (reqFormat || 'mp3').toLowerCase();

  if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });
  if (!['mp3', 'mp4'].includes(format)) return res.status(400).json({ error: 'Invalid format' });

  const jobId = uuidv4();
  const emitter = new EventEmitter();
  let title = 'download';
  try {
    title = await getTitle(url);
  } catch (err) {
    logger.error(`Title fetch failed: ${err.message}`);
  }

  db.run(
    'INSERT INTO jobs (id, status, progress, error, title, format) VALUES (?, ?, ?, ?, ?, ?)',
    [jobId, 'initializing', 0, null, title, format],
    (err) => {
      if (err) {
        logger.error(`DB insert error: ${err.message}`);
        return res.status(500).json({ error: 'Failed to create job' });
      }
      jobs.set(jobId, { emitter, status: 'initializing', progress: 0, error: null, title, format });
      res.json({ jobId, title });

      const cleanUrl = url.split('&')[0];
      const ytdlpArgs = [
        '-f',
        format === 'mp3'
          ? 'bestaudio'
          : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '-o',
        '-',
        cleanUrl,
      ];
      const ytdlpProcess = spawn('/opt/venv/bin/yt-dlp', ytdlpArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      ytdlpProcess.on('error', (err) => {
        logger.error(`yt-dlp spawn error: ${err.message}`);
        jobs.get(jobId).status = 'failed';
        jobs.get(jobId).error = `Failed to start download: ${err.message}`;
        jobs.get(jobId).emitter.emit('update', { status: 'failed', progress: 0, error: err.message });
        db.run('UPDATE jobs SET status = ?, error = ? WHERE id = ?', ['failed', err.message, jobId]);
      });

      ytdlpProcess.on('exit', (code, signal) => {
        if (code !== 0) {
          logger.error(`yt-dlp exited with code ${code}, signal ${signal}`);
          jobs.get(jobId).status = 'failed';
          jobs.get(jobId).error = `Download failed with code ${code}`;
          jobs.get(jobId).emitter.emit('update', {
            status: 'failed',
            progress: 0,
            error: `Download failed with code ${code}`,
          });
          db.run('UPDATE jobs SET status = ?, error = ? WHERE id = ?', ['failed', `Download failed with code ${code}`, jobId]);
        }
      });

      const ffmpegArgs = ['-i', 'pipe:0'];
      if (format === 'mp3') {
        ffmpegArgs.push('-f', 'mp3', '-acodec', 'mp3', '-ab', '192k', 'pipe:1');
      } else {
        ffmpegArgs.push('-c:v', 'copy', '-c:a', 'aac', '-f', 'mp4', 'pipe:1');
      }
      const ffmpeg = spawn('ffmpeg', ffmpegArgs);

      ffmpeg.on('error', (err) => {
        logger.error(`ffmpeg spawn error: ${err.message}`);
        jobs.get(jobId).status = 'failed';
        jobs.get(jobId).error = `ffmpeg failed: ${err.message}`;
        jobs.get(jobId).emitter.emit('update', { status: 'failed', progress: 0, error: err.message });
        db.run('UPDATE jobs SET status = ?, error = ? WHERE id = ?', ['failed', err.message, jobId]);
      });

      jobs.get(jobId).ytdlp = ytdlpProcess;
      jobs.get(jobId).ffmpeg = ffmpeg;
      jobs.get(jobId).status = 'downloading';
      db.run('UPDATE jobs SET status = ? WHERE id = ?', ['downloading', jobId]);

      ytdlpProcess.stdout.pipe(ffmpeg.stdin);

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          jobs.get(jobId).status = 'complete';
          jobs.get(jobId).progress = 100;
          jobs.get(jobId).emitter.emit('update', { status: 'complete', progress: 100 });
          db.run('UPDATE jobs SET status = ?, progress = ? WHERE id = ?', ['complete', 100, jobId]);
        } else {
          jobs.get(jobId).status = 'failed';
          jobs.get(jobId).error = `ffmpeg failed with code ${code}`;
          jobs.get(jobId).emitter.emit('update', {
            status: 'failed',
            progress: 0,
            error: `ffmpeg failed with code ${code}`,
          });
          db.run('UPDATE jobs SET status = ?, error = ? WHERE id = ?', ['failed', `ffmpeg failed with code ${code}`, jobId]);
        }
        setTimeout(() => cleanupJob(jobId), 60000);
      });

      ytdlpProcess.stderr.on('data', (data) => {
        const str = data.toString();
        const match = str.match(/(\d{1,3}\.\d)%/);
        if (match) {
          jobs.get(jobId).progress = parseFloat(match[1]);
          jobs.get(jobId).emitter.emit('update', {
            status: jobs.get(jobId).status,
            progress: jobs.get(jobId).progress,
          });
          db.run('UPDATE jobs SET progress = ? WHERE id = ?', [jobs.get(jobId).progress, jobId]);
        }
      });
    }
  );
});

// SSE: get progress
app.get('/progress/:jobId', (req, res) => {
  db.get('SELECT * FROM jobs WHERE id = ?', [req.params.jobId], (err, row) => {
    if (err || !row) return res.status(404).send('Job not found');
    const job = jobs.get(req.params.jobId) || { emitter: new EventEmitter(), ...row };
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ status: row.status, progress: row.progress, error: row.error })}\n\n`);
    const listener = (update) => res.write(`data: ${JSON.stringify(update)}\n\n`);
    job.emitter.on('update', listener);
    req.on('close', () => {
      job.emitter.removeListener('update', listener);
      res.end();
    });
  });
});

// Download route
app.get('/download/:jobId', (req, res) => {
  db.get('SELECT * FROM jobs WHERE id = ?', [req.params.jobId], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Job not found' });
    const job = jobs.get(req.params.jobId);
    if (!job || !job.ffmpeg) return res.status(404).json({ error: 'Job not found or not started' });
    if (row.status !== 'complete') return res.status(400).json({ error: `Job status: ${row.status}` });
    const ext = row.format === 'mp4' ? 'mp4' : 'mp3';
    res.setHeader('Content-Disposition', `attachment; filename="${row.title || 'download'}.${ext}"`);
    res.setHeader('Content-Type', row.format === 'mp4' ? 'video/mp4' : 'audio/mpeg');
    job.ffmpeg.stdout.pipe(res);
    req.on('close', () => cleanupJob(req.params.jobId));
  });
});

app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
});
