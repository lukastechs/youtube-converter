import express from 'express';
import { spawn } from 'node:child_process';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import sqlite3 from 'sqlite3';
import winston from 'winston';
import puppeteer from 'puppeteer';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Initialize logger
const logger = winston.createLogger({
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'browser.log', level: 'info' }),
    new winston.transports.Console(),
  ],
});

// Proxy configuration (optional; recommended)
const PROXY_LIST = process.env.PROXY_LIST || null; // e.g., 'http://username:password@brd.superproxy.io:22225'
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1000;

// Browser performance tracking
let browserStats = { successes: 0, failures: 0 };

// Log ffmpeg version
spawn('ffmpeg', ['-version']).stdout.on('data', (data) => {
  logger.info(`ffmpeg version: ${data.toString().split('\n')[0].trim()}`);
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

// Global error handler
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
});

// Cleanup job
const cleanupJob = (jobId) => {
  const job = jobs.get(jobId);
  if (job) {
    job.emitter.removeAllListeners();
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

// Fetch title and stream URL with Puppeteer
const getStreamInfo = async (url, retryCount = 0) => {
  if (retryCount >= MAX_RETRIES) {
    browserStats.failures++;
    logger.info(`Browser stats: ${JSON.stringify(browserStats)}`);
    return { title: 'download', streamUrl: null, error: 'Failed to fetch video after retries. Try again later.' };
  }

  const proxies = PROXY_LIST ? PROXY_LIST.split(',') : [null];
  const proxy = proxies[retryCount % proxies.length];
  logger.info(`Attempting stream fetch with ${proxy ? `proxy: ${proxy}` : 'no proxy'} (retry ${retryCount + 1}/${MAX_RETRIES})`);

  let browser;
  try {
    const browserArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-infobars',
    ];
    if (proxy) browserArgs.push(`--proxy-server=${proxy}`);
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium-browser',
      headless: 'new',
      args: browserArgs,
    });
    const page = await browser.newPage();

    // Mimic real user
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    // Disable unnecessary resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate to YouTube video
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Extract title
    const title = await page.evaluate(() => {
      const titleElement = document.querySelector('h1 yt-formatted-string');
      return titleElement ? titleElement.textContent.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50) : 'download';
    });

    // Extract stream URL (try HLS or direct video source)
    const streamUrl = await page.evaluate(() => {
      const player = document.querySelector('video');
      return player ? player.src : null;
    });

    if (!streamUrl) {
      throw new Error('Could not extract stream URL');
    }

    await browser.close();
    browserStats.successes++;
    logger.info(`Browser stats: ${JSON.stringify(browserStats)}`);
    return { title, streamUrl, error: null };
  } catch (e) {
    logger.error(`Puppeteer error (retry ${retryCount + 1}): ${e.message}`);
    if (browser) await browser.close();
    if (e.message.includes('net::ERR_BLOCKED_BY_CLIENT') || e.message.includes('Timeout') || e.message.includes('Navigation timeout')) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(getStreamInfo(url, retryCount + 1)), RETRY_BACKOFF_MS * Math.pow(2, retryCount));
      });
    }
    browserStats.failures++;
    return { title: 'download', streamUrl: null, error: e.message };
  }
};

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
  const { title, streamUrl, error: streamError } = await getStreamInfo(url);
  if (streamError) {
    return res.status(503).json({ error: 'Video temporarily unavailable. Please try again later.' });
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

      const ffmpegArgs = ['-i', streamUrl];
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

      jobs.get(jobId).ffmpeg = ffmpeg;
      jobs.get(jobId).status = 'downloading';
      db.run('UPDATE jobs SET status = ? WHERE id = ?', ['downloading', jobId]);

      // Simulate progress (Puppeteer lacks native progress tracking)
      let progress = 0;
      const progressInterval = setInterval(() => {
        progress = Math.min(progress + 10, 90);
        jobs.get(jobId).progress = progress;
        jobs.get(jobId).emitter.emit('update', { status: 'downloading', progress });
        db.run('UPDATE jobs SET progress = ? WHERE id = ?', [progress, jobId]);
      }, 1000);

      ffmpeg.on('close', (code) => {
        clearInterval(progressInterval);
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

// Browser stats endpoint (for debugging)
app.get('/browser-stats', (req, res) => {
  res.json(browserStats);
});

app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT} with Puppeteer`);
});
