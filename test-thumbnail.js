/**
 * Manual thumbnail test runner.
 * Generates test-thumbnail.jpg only. Does not upload to Wix or change site data.
 */

const { createCanvas, loadImage, registerFont } = require('canvas');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  YOUTUBE_API_KEY,
  OPENAI_API_KEY,
  VIDEO_ID,
  TEST_TITLE,
  TEST_SPEAKER,
  TEST_SUBTITLE,
} = process.env;

if (!YOUTUBE_API_KEY) throw new Error('Missing YOUTUBE_API_KEY secret.');
if (!VIDEO_ID) throw new Error('Missing VIDEO_ID input.');

registerFont(path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf'), { family: 'Bethel Bold' });
registerFont(path.join(__dirname, 'assets', 'DejaVuSans.ttf'), { family: 'Bethel Regular' });

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 240000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\nCommand: ${cmd} ${args.join(' ')}\nSTDERR: ${stderr}`;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function youtube(pathAndQuery) {
  const url = `https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function lineValue(description, labels) {
  for (const label of labels) {
    const rx = new RegExp(`^\\s*${label}\\s*:\\s*(.+)\\s*$`, 'im');
    const match = description.match(rx);
    if (match) return match[1].trim();
  }
  return null;
}

function stripVideoTitle(title) {
  return (title || 'Sermon')
    .replace(/\|\s*Bethel Tabernacle.*$/i, '')
    .replace(/-\s*Bethel Tabernacle.*$/i, '')
    .replace(/\bLive Stream\b/gi, '')
    .trim();
}

function parseDurationSeconds(isoDuration) {
  if (!isoDuration) return null;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  return (parseInt(match[1] || '0', 10) * 3600) + (parseInt(match[2] || '0', 10) * 60) + parseInt(match[3] || '0', 10);
}

function parseTimestamp(text) {
  if (!text) return null;
  const parts = text.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function getPreachingStartSeconds(video) {
  const description = video.snippet.description || '';
  const explicit = lineValue(description, ['Preaching Starts', 'Preaching Start', 'Sermon Starts', 'Sermon Start', 'Message Starts', 'Message Start']);
  const parsed = parseTimestamp(explicit);
  if (parsed !== null) return parsed;
  const duration = parseDurationSeconds(video.contentDetails && video.contentDetails.duration);
  if (duration && duration > 0) return Math.min(Math.max(Math.round(duration * 0.42), 1800), 3900);
  return 2700;
}

function getDisplayData(video) {
  const description = video.snippet.description || '';
  return {
    title: TEST_TITLE || lineValue(description, ['Sermon Title', 'Title']) || stripVideoTitle(video.snippet.title),
    speaker: TEST_SPEAKER || lineValue(description, ['Speaker', 'Preacher', 'Minister']) || 'Bethel Tabernacle',
    subtitle: TEST_SUBTITLE || lineValue(description, ['Subtitle', 'Sub Title', 'Part']) || '',
  };
}

async function captureVideoFrame(videoId, seconds, fallbackThumbUrl) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bethel-thumb-test-'));
  const output = path.join(tmpDir, `${videoId}.jpg`);
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    console.log(`Capturing preacher frame around ${seconds}s...`);
    const mediaUrls = await run('yt-dlp', ['-f', 'bv*[height<=720]/b[height<=720]/best', '-g', videoUrl]);
    const mediaUrl = mediaUrls.split('\n').find(Boolean);
    if (!mediaUrl) throw new Error('yt-dlp did not return a media URL.');
    await run('ffmpeg', ['-y', '-ss', String(seconds), '-i', mediaUrl, '-frames:v', '1', '-q:v', '2', output]);
    await fs.access(output);
    return output;
  } catch (err) {
    console.warn(`Could not capture video frame, using YouTube thumbnail instead. ${err.message}`);
    const res = await fetch(fallbackThumbUrl);
    if (!res.ok) throw new Error(`Could not download fallback thumbnail: ${res.status}`);
    await fs.writeFile(output, Buffer.from(await res.arrayBuffer()));
    return output;
  }
}

function hashText(text) {
  let hash = 0;
  for (const ch of text) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function paletteFor(title) {
  const palettes = [
    { outer: '#0d5f84', top: '#144e75', mid: '#172b4b', bottom: '#071425', accent: '#b7d8f4' },
    { outer: '#615780', top: '#5a5076', mid: '#22213f', bottom: '#080912', accent: '#d4b2ff' },
    { outer: '#284e61', top: '#244b51', mid: '#0f312d', bottom: '#061411', accent: '#bee6d0' },
    { outer: '#866647', top: '#a67f54', mid: '#2c2b2a', bottom: '#10100f', accent: '#ffd687' },
  ];
  return palettes[hashText(title) % palettes.length];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCoverImage(ctx, img, x, y, w, h, focalX = 0.5, focalY = 0.5) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = Math.max(0, Math.min(img.width - sw, img.width * focalX - sw / 2));
  const sy = Math.max(0, Math.min(img.height - sh, img.height * focalY - sh / 2));
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function drawFallbackBackground(ctx, palette, title) {
  const w = 1280;
  const h = 720;
  ctx.fillStyle = palette.outer;
  ctx.fillRect(0, 0, w, h);
  const gx = ctx.createLinearGradient(0, 40, 0, h - 40);
  gx.addColorStop(0, palette.top);
  gx.addColorStop(0.58, palette.mid);
  gx.addColorStop(1, palette.bottom);
  roundRect(ctx, 38, 46, 1204, 628, 28);
  ctx.fillStyle = gx;
  ctx.fill();
  ctx.save();
  roundRect(ctx, 38, 46, 1204, 628, 28);
  ctx.clip();
  for (const set of [
    { y: 330, color: 'rgba(255,255,255,0.22)', peaks: [80, 250, 420, 610, 800, 1030, 1240] },
    { y: 390, color: 'rgba(0,0,0,0.35)', peaks: [0, 180, 350, 560, 740, 930, 1160, 1280] },
  ]) {
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < set.peaks.length; i++) {
      const x = set.peaks[i];
      const peakY = i % 2 === 0 ? set.y - 180 - (hashText(title + i) % 85) : set.y - 45;
      ctx.lineTo(x, peakY);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = set.color;
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(2, 8, 18, 0.55)';
  ctx.fillRect(0, 455, w, 300);
  ctx.restore();
}

async function generateOpenAIBackground({ title, subtitle, speaker, palette }) {
  if (!OPENAI_API_KEY) return null;
  const prompt = [
    'Create a beautiful 16:9 sermon thumbnail background only.',
    'No people, no faces, no text, no letters, no words, no logos, no watermark.',
    'Elegant Christian sermon promo background, cinematic, peaceful, majestic mountains, lake or valley, sunrise or sunset glow.',
    `Use colors that harmonize with ${palette.top}, ${palette.mid}, and ${palette.bottom}.`,
    `Theme title: ${title}. Speaker: ${speaker}. ${subtitle ? `Subtitle: ${subtitle}.` : ''}`,
    'Keep the left half cleaner and darker for title text, and the right side suitable for a preacher image.',
  ].join(' ');
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '1536x1024' }),
  });
  if (!res.ok) {
    console.warn(`OpenAI image generation failed (${res.status}). Falling back. ${await res.text()}`);
    return null;
  }
  const json = await res.json();
  const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
  return b64 ? Buffer.from(b64, 'base64') : null;
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function titleCaseName(name) {
  return name.replace(/\w\S*/g, (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
}

async function buildThumbnail({ video, title, subtitle, speaker, fallbackThumbUrl }) {
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext('2d');
  const palette = paletteFor(title);
  ctx.fillStyle = palette.outer;
  ctx.fillRect(0, 0, 1280, 720);

  const bgBuffer = await generateOpenAIBackground({ title, subtitle, speaker, palette });
  if (bgBuffer) {
    const bg = await loadImage(bgBuffer);
    ctx.save();
    roundRect(ctx, 38, 46, 1204, 628, 28);
    ctx.clip();
    drawCoverImage(ctx, bg, 38, 46, 1204, 628, 0.52, 0.48);
    ctx.restore();
    ctx.fillStyle = 'rgba(7, 12, 22, 0.56)';
    ctx.fillRect(38, 46, 700, 628);
  } else {
    drawFallbackBackground(ctx, palette, title);
  }

  const framePath = await captureVideoFrame(video.id, getPreachingStartSeconds(video), fallbackThumbUrl);
  const frame = await loadImage(framePath);
  const px = 735, py = 65, pw = 520, ph = 640;
  ctx.save();
  roundRect(ctx, px, py, pw, ph, 24);
  ctx.clip();
  drawCoverImage(ctx, frame, px, py, pw, ph, 0.58, 0.38);
  ctx.restore();

  const sideBlend = ctx.createLinearGradient(660, 0, 825, 0);
  sideBlend.addColorStop(0, 'rgba(8, 13, 28, 0.94)');
  sideBlend.addColorStop(1, 'rgba(8, 13, 28, 0)');
  ctx.fillStyle = sideBlend;
  ctx.fillRect(650, 46, 200, 628);

  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = '30px "Bethel Regular"';
  ctx.fillText(titleCaseName(speaker), 126, 140);

  let fontSize = title.length > 36 ? 72 : 86;
  let lines;
  do {
    ctx.font = `${fontSize}px "Bethel Regular"`;
    lines = wrapText(ctx, title, 610);
    if (lines.length > 4) fontSize -= 4;
  } while (lines.length > 4 && fontSize > 44);

  ctx.fillStyle = '#ffffff';
  let y = subtitle ? 285 : 320;
  const gap = fontSize * 0.98;
  for (const line of lines) {
    ctx.fillText(line, 126, y);
    y += gap;
  }

  if (subtitle) {
    const subText = subtitle.replace(/\bpart\b/i, 'Part');
    const sx = 126, sy = Math.min(575, y + 15);
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 2;
    roundRect(ctx, sx, sy - 48, 360, 64, 10);
    ctx.stroke();
    ctx.font = '44px "Bethel Bold"';
    ctx.fillStyle = palette.accent;
    ctx.fillText(subText.toUpperCase(), sx + 28, sy);
  }

  const tagX = 126, tagY = 615, tagW = 430, tagH = 58;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 3;
  roundRect(ctx, tagX, tagY, tagW, tagH, 26);
  ctx.stroke();
  ctx.font = '28px "Bethel Bold"';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('BETHEL TABERNACLE', tagX + 31, tagY + 39);

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

async function main() {
  console.log('Running safe test thumbnail workflow. Wix will not be touched.');
  const data = await youtube(`videos?part=snippet,contentDetails&id=${VIDEO_ID}`);
  const video = data.items && data.items[0];
  if (!video) throw new Error(`Could not find YouTube video: ${VIDEO_ID}`);
  const { title, speaker, subtitle } = getDisplayData(video);
  console.log(`Using title: ${title}`);
  console.log(`Using speaker: ${speaker}`);
  if (subtitle) console.log(`Using subtitle: ${subtitle}`);

  const thumbs = video.snippet.thumbnails || {};
  const sourceThumb = (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default).url;
  const jpegBuffer = await buildThumbnail({ video, title, subtitle, speaker, fallbackThumbUrl: sourceThumb });
  await fs.writeFile('test-thumbnail.jpg', jpegBuffer);
  console.log('Created test-thumbnail.jpg');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
