/* yt-dlp wrapper: resolve metadata + stream downloads.
   Requires Python + yt-dlp (`pip install yt-dlp`) OR a yt-dlp binary (YTDLP_PATH).
   All errors are returned as { ok:false, error } — never throws to callers. */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ytdlpBin() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

/* Map low-level spawn errors to a human-friendly, actionable message */
function friendlyBinaryError(err) {
  if (err && (err.code === 'ENOENT' || /ENOENT|not recognized|cannot find/i.test(err.message || ''))) {
    return 'yt-dlp is not installed or not on PATH. Fix: run "pip install yt-dlp" (or download yt-dlp.exe and set YTDLP_PATH in server/.env), then restart the server.';
  }
  return null;
}

function run(args, timeoutMs = 45000) {
  return new Promise((resolve) => {
    execFile(ytdlpBin(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const friendly = friendlyBinaryError(err);
        resolve({ ok: false, error: (friendly || (stderr || err.message)).trim().slice(0, 300) });
      } else {
        resolve({ ok: true, stdout: (stdout || '').trim() });
      }
    });
  });
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('tiktok.com')) return 'tiktok';
  return 'unknown';
}

function pickFormatId(info, quality) {
  const formats = (info.formats || []).filter((f) => f.url && f.vcodec !== 'none');
  if (!formats.length) return null;
  const withH = formats.filter((f) => f.height);
  const sorted = (withH.length ? withH : formats).slice().sort((a, b) => (b.height || 0) - (a.height || 0));
  if (quality === 'sd') {
    const under = sorted.filter((f) => (f.height || 9999) <= 720);
    return (under[0] || sorted[sorted.length - 1]).format_id;
  }
  return sorted[0].format_id; // hd = best
}

/* Resolve a reel URL to metadata + playable/download URLs (no file saved) */
async function resolveUrl(url) {
  const platform = detectPlatform(url);
  const r = await run([
    url, '--dump-single-json', '--no-playlist', '--no-warnings',
    '--socket-timeout', '15',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  ], 60000);
  if (!r.ok) {
    const msg = /unsupported url/i.test(r.error) ? 'This link is not supported or is private/login-walled.' : r.error;
    return { ok: false, platform, error: msg };
  }
  let info;
  try { info = JSON.parse(r.stdout); }
  catch { return { ok: false, platform, error: 'Could not parse video info.' }; }

  const best = pickFormatId(info, 'hd');
  const direct = (info.formats || []).find((f) => f.format_id === best);
  return {
    ok: true,
    platform,
    title: info.title || 'reel_video',
    thumbnail: info.thumbnail || null,
    duration: info.duration || null,
    width: direct?.width || info.width || null,
    height: direct?.height || info.height || null,
    filesize: direct?.filesize || direct?.filesize_approx || info.filesize_approx || null,
    streamUrl: direct?.url || info.url || null, // hotlink (may expire)
    uploader: info.uploader || info.channel || null,
    qualities: ['hd', 'sd', 'audio'],
    rawId: info.id || null,
  };
}

/* ffmpeg is required for HLS/video merging and MP3 extraction */
function ffmpegArg() {
  const p = (process.env.FFMPEG_PATH || '').trim();
  return p ? ['--ffmpeg-location', p] : [];
}

/* Stream a download to the HTTP response. yt-dlp writes to a temp file first
   (so merging to real MP4 + MP3 extraction actually work — stdout mode can't
   postprocess), then the finished file is streamed and deleted. */
function streamDownload(url, quality, res, filename) {
  const ext = quality === 'audio' ? 'mp3' : 'mp4';
  const safe = (filename || 'reel').replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'reel';
  const tmpPath = path.join(os.tmpdir(), `reelfetch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);

  const args = [url, '--no-playlist', '--no-warnings', '-o', tmpPath, ...ffmpegArg()];
  if (quality === 'audio') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  else args.push('-f', quality === 'sd'
    ? 'best[height<=720]/bv*[height<=720]+ba/best/b'
    : 'best/bv*+ba/b', '--merge-output-format', 'mp4');

  const child = spawn(ytdlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let errBuf = '';
  child.stderr.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-500); });

  const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };
  const fail = (msg) => {
    cleanup();
    if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} return; }
    res.status(500).json({ ok: false, error: msg });
  };

  child.on('error', (e) => {
    console.error('[dl] spawn failed:', e.message);
    fail(friendlyBinaryError(e) || ('Download failed: ' + e.message));
  });
  child.on('close', (code) => {
    if (code !== 0) {
      console.error('[dl] yt-dlp exited with code ' + code + ':', errBuf.trim() || '(no stderr)');
      return fail(errBuf.trim().slice(0, 300) || ('Download failed (yt-dlp exit ' + code + ')'));
    }
    fs.stat(tmpPath, (err, st) => {
      if (err || !st.size) return fail('Download produced no data. ' + (errBuf.trim().slice(0, 200) || err?.message || ''));
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.${ext}"`);
      res.setHeader('Content-Type', quality === 'audio' ? 'audio/mpeg' : 'video/mp4');
      res.setHeader('Content-Length', st.size);
      res.statusCode = 200;
      const s = fs.createReadStream(tmpPath);
      s.on('close', cleanup);
      s.on('error', (e2) => { console.error('[dl] stream error:', e2.message); cleanup(); try { res.end(); } catch {} });
      s.pipe(res);
    });
  });
  res.on('close', () => { try { child.kill(); } catch {} });
  return child;
}

module.exports = { resolveUrl, streamDownload, detectPlatform };
