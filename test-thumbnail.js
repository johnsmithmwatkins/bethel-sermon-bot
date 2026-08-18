/**
 * Manual thumbnail test runner.
 * Generates test-thumbnail.jpg only. Does not upload to Wix or change site data.
 *
 * This keeps the working JavaScript workflow, but tunes the output closer to the
 * approved Bethel thumbnail style:
 * - OpenAI is used only for the scenic background.
 * - rembg Python API removes the preacher background without repainting the face.
 * - the real preacher cutout is cropped tighter to reduce pulpit/iPad/mic clutter.
 * - code renders exact title/speaker/church text for reliable spelling.
 */

const { createCanvas, loadImage, registerFont } = require('canvas');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const OpenAIpkg = require('openai');
const OpenAI = OpenAIpkg.default || OpenAIpkg;

const {
  YOUTUBE_API_KEY,
  OPENAI_API_KEY,
  VIDEO_ID,
  PREACHER_IMAGE_URL,
  TEST_TITLE,
  TEST_SPEAKER,
  TEST_SUBTITLE,
  STYLE_MODE,
  BG_PATH,
  CUTOUT_PATH,
  OUT_PATH,
  MINISTER_NAME,
  SERMON_TITLE,
  SERMON_SUBTITLE,
  CHURCH_NAME,
} = process.env;

if (!PREACHER_IMAGE_URL && !VIDEO_ID && !CUTOUT_PATH) {
  throw new Error('Provide PREACHER_IMAGE_URL, VIDEO_ID, or CUTOUT_PATH. PREACHER_IMAGE_URL gives the best test result.');
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const FINAL_OUT = OUT_PATH || 'test-thumbnail.jpg';
const CHURCH = CHURCH_NAME || 'Bethel Tabernacle';
const DEFAULT_CUTOUT_OUT = 'preacher-cutout.png';
const AI_BG_OUT = 'ai-background.png';

function tryFont(file, family, weight = 'normal', style = 'normal') {
  try {
    if (fs.existsSync(file)) registerFont(file, { family, weight, style });
  } catch (_) {}
}
tryFont('/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf', 'Bethel Serif');
tryFont('/usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf', 'Bethel Serif', 'bold');
tryFont('/usr/share/fonts/truetype/liberation2/LiberationSerif-Italic.ttf', 'Bethel Serif', 'normal', 'italic');
tryFont('/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf', 'Bethel Sans');
tryFont('/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf', 'Bethel Sans', 'bold');
tryFont(path.join(__dirname, 'assets', 'DejaVuSans.ttf'), 'Bethel Sans Fallback');
tryFont(path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf'), 'Bethel Sans Fallback', 'bold');

const STYLES = {
  purple_mountain: {
    outer: '#62547d', overlay: 'rgba(90,70,135,0.36)', accent: '#d8caff',
    tint: 'rgba(98,84,125,0.18)',
    prompt: 'purple mountain style, soft lavender and blue color grade, snowy mountain backdrop, gentle clouds, premium elegant sermon thumbnail',
  },
  forest_green: {
    outer: '#0b526f', overlay: 'rgba(18,70,82,0.30)', accent: '#dcefff',
    tint: 'rgba(20,84,82,0.16)',
    prompt: 'deep forest green and blue mountain style, tall evergreen forest, soft atmospheric depth, premium sermon thumbnail',
  },
  blue_lake: {
    outer: '#08739d', overlay: 'rgba(18,75,112,0.30)', accent: '#c7e9ff',
    tint: 'rgba(18,94,135,0.16)',
    prompt: 'cool blue lake style, calm mountain lake, misty valley, clean classic premium sermon thumbnail',
  },
  warm_tan: {
    outer: '#8a6745', overlay: 'rgba(175,130,80,0.32)', accent: '#ffe1aa',
    tint: 'rgba(160,112,65,0.16)',
    prompt: 'warm tan and gold style, soft autumn mountain edges, premium beige panel, gentle church thumbnail',
  },
};

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 420000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\nCommand: ${cmd} ${args.join(' ')}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function hashText(text) {
  let h = 0;
  for (const ch of String(text || '')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function chooseStyle(title) {
  if (STYLE_MODE && STYLES[STYLE_MODE]) return { id: STYLE_MODE, ...STYLES[STYLE_MODE] };
  const keys = Object.keys(STYLES);
  const id = keys[hashText(title) % keys.length];
  return { id, ...STYLES[id] };
}

async function youtube(pathAndQuery) {
  if (!YOUTUBE_API_KEY) throw new Error('Missing YOUTUBE_API_KEY secret.');
  const url = `https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function lineValue(desc, labels) {
  for (const label of labels) {
    const m = String(desc || '').match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)\\s*$`, 'im'));
    if (m) return m[1].trim();
  }
  return null;
}

function stripVideoTitle(title) {
  return String(title || 'Sermon')
    .replace(/\|\s*Bethel Tabernacle.*$/i, '')
    .replace(/-\s*Bethel Tabernacle.*$/i, '')
    .replace(/\bLive Stream\b/gi, '')
    .trim();
}

function normalizeSubtitle(subtitle) {
  if (!subtitle) return '';
  const s = String(subtitle).trim();
  if (/^part\s+/i.test(s)) return s.replace(/^part\s+/i, 'Part ');
  return s;
}

function parseDurationSeconds(iso) {
  const m = iso && iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 3600;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

async function downloadImage(url, label = 'image') {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download ${label}: HTTP ${res.status}`);
  const type = res.headers.get('content-type') || 'image/jpeg';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const out = path.join(os.tmpdir(), `${label}-${Date.now()}.${ext}`);
  await fsp.writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

async function captureVideoFrame(videoId, seconds, fallbackThumbUrl) {
  const out = path.join(os.tmpdir(), `preacher-frame-${Date.now()}.jpg`);
  try {
    console.log(`Capturing preacher frame around ${seconds}s...`);
    const mediaUrls = await run('yt-dlp', ['-f', 'bv*[height<=720]/b[height<=720]/best', '-g', `https://www.youtube.com/watch?v=${videoId}`]);
    const mediaUrl = mediaUrls.split('\n').find(Boolean);
    if (!mediaUrl) throw new Error('yt-dlp did not return a media URL.');
    await run('ffmpeg', ['-y', '-ss', String(seconds), '-i', mediaUrl, '-frames:v', '1', '-q:v', '2', out]);
    await fsp.access(out);
    return out;
  } catch (err) {
    if (!fallbackThumbUrl) throw err;
    console.warn(`Could not capture video frame, using YouTube thumbnail instead. ${err.message}`);
    return downloadImage(fallbackThumbUrl, 'youtube-thumbnail');
  }
}

async function getInputPreacherImage(video, fallbackThumbUrl) {
  if (CUTOUT_PATH && fs.existsSync(CUTOUT_PATH)) {
    console.log(`Using provided CUTOUT_PATH: ${CUTOUT_PATH}`);
    return CUTOUT_PATH;
  }
  if (PREACHER_IMAGE_URL) {
    console.log('Using provided preacher_image_url.');
    return downloadImage(PREACHER_IMAGE_URL, 'preacher-input');
  }
  const duration = parseDurationSeconds(video?.contentDetails?.duration);
  const seconds = Math.min(Math.max(Math.round(duration * 0.42), 1800), 3900);
  return captureVideoFrame(VIDEO_ID, seconds, fallbackThumbUrl);
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

function cover(ctx, img, x, y, w, h, fx = 0.5, fy = 0.5) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s;
  const sh = h / s;
  const sx = Math.max(0, Math.min(img.width - sw, img.width * fx - sw / 2));
  const sy = Math.max(0, Math.min(img.height - sh, img.height * fy - sh / 2));
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function containDraw(ctx, img, sx, sy, sw, sh, x, y, w, h, anchorBottom = true) {
  const scale = Math.min(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = x + (w - dw) / 2;
  const dy = anchorBottom ? y + h - dh : y + (h - dh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function parseRgba(str) {
  const m = String(str).match(/rgba?\(([^)]+)\)/);
  if (!m) return [0, 0, 0, 0];
  const parts = m[1].split(',').map((p) => p.trim());
  const r = Number(parts[0] || 0);
  const g = Number(parts[1] || 0);
  const b = Number(parts[2] || 0);
  const a = parts[3] === undefined ? 1 : Number(parts[3]);
  return [r, g, b, Math.round(a * 255)];
}

function canvasToPngBuffer(canvas) {
  return canvas.toBuffer('image/png');
}

function getAlphaStatsFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const d = ctx.getImageData(0, 0, width, height).data;
  let transparent = 0;
  let nonOpaque = 0;
  const total = width * height;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 10) transparent++;
    if (d[i] < 250) nonOpaque++;
  }
  return { transparentRatio: transparent / total, nonOpaqueRatio: nonOpaque / total };
}

function findAlphaBox(canvas, { ignoreLower = 0 } = {}) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const d = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const yLimit = Math.max(1, Math.floor(height * (1 - ignoreLower)));
  for (let y = 0; y < yLimit; y++) {
    for (let x = 0; x < width; x++) {
      const a = d[(y * width + x) * 4 + 3];
      if (a > 12) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

async function makeRembgCutout(inputPath) {
  const rawOut = path.join(os.tmpdir(), `rembg-raw-${Date.now()}.png`);
  const py = path.join(os.tmpdir(), `rembg-api-${Date.now()}.py`);
  const pyCode = `
from rembg import remove
from PIL import Image
import sys
inp, out = sys.argv[1], sys.argv[2]
img = Image.open(inp).convert('RGBA')
result = remove(img)
result.save(out)
`;
  await fsp.writeFile(py, pyCode);
  await run('python3', [py, inputPath, rawOut]);
  await fsp.access(rawOut);
  return rawOut;
}

async function makeLocalCutout(inputPath) {
  const out = path.join(process.cwd(), DEFAULT_CUTOUT_OUT);

  if (CUTOUT_PATH && fs.existsSync(CUTOUT_PATH)) {
    console.log('Using existing cutout and applying cleaner crop.');
    await cleanAndCropCutout(CUTOUT_PATH, out);
    return out;
  }

  console.log('Removing preacher background locally with rembg Python API so the real photo is preserved...');
  const raw = await makeRembgCutout(inputPath);
  await cleanAndCropCutout(raw, out);

  const check = createCanvas(1, 1);
  const img = await loadImage(out);
  check.width = img.width;
  check.height = img.height;
  const c = check.getContext('2d');
  c.drawImage(img, 0, 0);
  const stats = getAlphaStatsFromCanvas(check);
  console.log(`Cutout alpha check: transparent ${(stats.transparentRatio * 100).toFixed(1)}%, non-opaque ${(stats.nonOpaqueRatio * 100).toFixed(1)}%.`);
  if (stats.transparentRatio < 0.08 && stats.nonOpaqueRatio < 0.10) {
    throw new Error('Background removal did not create meaningful transparency. Stopping instead of making a bad rectangle thumbnail.');
  }
  return out;
}

async function cleanAndCropCutout(inputPng, outputPng) {
  const img = await loadImage(inputPng);
  const src = createCanvas(img.width, img.height);
  const srcCtx = src.getContext('2d');
  srcCtx.drawImage(img, 0, 0);

  // Ignore the lowest part of the frame when finding the useful preacher box.
  // This cuts away most pulpit/iPad/mic clutter while keeping a waist/chest-up crop.
  let box = findAlphaBox(src, { ignoreLower: 0.18 }) || findAlphaBox(src) || { x: 0, y: 0, w: img.width, h: img.height };

  const padX = Math.round(box.w * 0.055);
  const padTop = Math.round(box.h * 0.035);
  const padBottom = Math.round(box.h * 0.020);
  let x = Math.max(0, box.x - padX);
  let y = Math.max(0, box.y - padTop);
  let w = Math.min(img.width - x, box.w + padX * 2);
  let h = Math.min(img.height - y, box.h + padTop + padBottom);

  // Extra lower trim for screenshots where the pulpit/mic survives rembg.
  h = Math.round(h * 0.88);

  const out = createCanvas(w, h);
  const outCtx = out.getContext('2d');
  outCtx.drawImage(img, x, y, w, h, 0, 0, w, h);
  await fsp.writeFile(outputPng, canvasToPngBuffer(out));
}

async function makeBackground(title, speaker, subtitle, style) {
  if (BG_PATH && fs.existsSync(BG_PATH)) {
    console.log(`Using provided BG_PATH: ${BG_PATH}`);
    if (BG_PATH !== AI_BG_OUT) await fsp.copyFile(BG_PATH, AI_BG_OUT).catch(() => {});
    return BG_PATH;
  }
  if (!openai) return null;

  const prompt = [
    'Create a beautiful 16:9 sermon thumbnail background only. Absolutely no people, no faces, no text, no letters, no logos, no watermark.',
    'Use this established Bethel Tabernacle visual style:', style.prompt + '.',
    'Premium church YouTube thumbnail feel: scenic nature background, soft mountains/lake/forest/sky, elegant depth, rounded-panel-friendly composition, gentle cinematic color grade.',
    'Keep the left side clean and slightly darker for large sermon title text. Leave open visual room on the right for a preacher cutout. Fresh design, not a duplicate.',
    `Sermon title mood: ${title}. Speaker: ${speaker}. ${subtitle ? `Subtitle: ${subtitle}.` : ''}`,
  ].join(' ');

  try {
    const rsp = await openai.images.generate({
      model: 'gpt-image-2',
      prompt,
      size: '1536x1024',
      quality: 'high',
      output_format: 'png',
    });
    const b64 = rsp?.data?.[0]?.b64_json;
    if (!b64) return null;
    const out = path.join(process.cwd(), AI_BG_OUT);
    await fsp.writeFile(out, Buffer.from(b64, 'base64'));
    return out;
  } catch (err) {
    console.warn(`OpenAI background generation failed: ${err.message}`);
    return null;
  }
}

function drawFallbackBackground(ctx, style) {
  const grad = ctx.createLinearGradient(0, 0, 1280, 720);
  grad.addColorStop(0, '#1a2240');
  grad.addColorStop(1, style.outer);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1280, 720);
  ctx.save();
  roundRect(ctx, 36, 42, 1208, 636, 30);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(36, 42, 1208, 636);
  ctx.restore();
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
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

function fitTitle(ctx, title, maxWidth) {
  for (let size = 88; size >= 54; size -= 2) {
    ctx.font = `${size}px "Bethel Serif", Georgia, serif`;
    const lines = wrapText(ctx, title, maxWidth);
    if (lines.length <= 4) return { size, lines };
  }
  ctx.font = '54px "Bethel Serif", Georgia, serif';
  return { size: 54, lines: wrapText(ctx, title, maxWidth).slice(0, 4) };
}

function titleCase(name) {
  return String(name || '').replace(/\w\S*/g, (p) => p[0].toUpperCase() + p.slice(1).toLowerCase());
}

function drawChurchPill(ctx, text, x, y) {
  ctx.font = '22px "Bethel Sans", Arial, sans-serif';
  const label = String(text || 'Bethel Tabernacle').toUpperCase();
  const metrics = ctx.measureText(label);
  const w = Math.ceil(metrics.width + 54);
  const h = 50;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 2.3;
  roundRect(ctx, x, y, w, h, 23);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.fillText(label, x + 27, y + 33);
  ctx.restore();
}

async function compose({ preacherPath, title, speaker, subtitle }) {
  const style = chooseStyle(title);
  console.log(`Style mode: ${style.id}`);

  const bgPath = await makeBackground(title, speaker, subtitle, style);
  const cutoutPath = await makeLocalCutout(preacherPath);

  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = style.outer;
  ctx.fillRect(0, 0, 1280, 720);

  if (bgPath) {
    const bg = await loadImage(bgPath);
    cover(ctx, bg, 0, 0, 1280, 720, 0.50, 0.50);
  } else {
    drawFallbackBackground(ctx, style);
  }

  // Unified soft tint, like the approved manual thumbnails.
  const [tr, tg, tb, ta] = parseRgba(style.tint);
  ctx.fillStyle = `rgba(${tr},${tg},${tb},${ta / 255})`;
  ctx.fillRect(0, 0, 1280, 720);

  // Rounded inner card and subtle glass panel.
  ctx.save();
  roundRect(ctx, 36, 42, 1208, 636, 30);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fillRect(36, 42, 1208, 636);

  const leftShade = ctx.createLinearGradient(36, 0, 790, 0);
  leftShade.addColorStop(0, 'rgba(16,12,28,0.28)');
  leftShade.addColorStop(0.70, 'rgba(16,12,28,0.05)');
  leftShade.addColorStop(1, 'rgba(16,12,28,0)');
  ctx.fillStyle = leftShade;
  ctx.fillRect(36, 42, 830, 636);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  roundRect(ctx, 36, 42, 1208, 636, 30);
  ctx.stroke();
  ctx.restore();

  // Left frosted text panel.
  ctx.save();
  ctx.fillStyle = 'rgba(245,240,255,0.18)';
  ctx.strokeStyle = 'rgba(255,255,255,0.34)';
  ctx.lineWidth = 1.6;
  roundRect(ctx, 60, 58, 725, 588, 26);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = 'rgba(55,42,88,0.16)';
  roundRect(ctx, 76, 58, 34, 588, 17);
  ctx.fill();
  ctx.restore();

  // Preacher cutout: larger and cleaner on the right.
  const preacher = await loadImage(cutoutPath);
  const pc = createCanvas(preacher.width, preacher.height);
  pc.getContext('2d').drawImage(preacher, 0, 0);
  const trim = findAlphaBox(pc) || { x: 0, y: 0, w: preacher.width, h: preacher.height };

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.48)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetX = -10;
  ctx.shadowOffsetY = 12;
  containDraw(ctx, preacher, trim.x, trim.y, trim.w, trim.h, 770, 78, 485, 625, true);
  ctx.restore();

  // Text.
  const white = 'rgba(252,249,255,0.97)';
  ctx.fillStyle = white;
  ctx.font = '30px "Bethel Serif", Georgia, serif';
  ctx.fillText(titleCase(speaker), 112, 126);

  const { size, lines } = fitTitle(ctx, title, 565);
  ctx.font = `${size}px "Bethel Serif", Georgia, serif`;
  ctx.fillStyle = white;
  let y = lines.length >= 4 ? 220 : 255;
  const gap = size * 0.88;
  for (const line of lines) {
    ctx.fillText(line, 112, y);
    y += gap;
  }

  let buttonY = y + 38;
  if (subtitle) {
    const sub = normalizeSubtitle(subtitle);
    const subY = y + 20;
    ctx.save();
    ctx.strokeStyle = 'rgba(245,240,255,0.76)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(112, subY + 14);
    ctx.lineTo(205, subY + 14);
    ctx.stroke();
    ctx.font = '38px "Bethel Serif", Georgia, serif';
    ctx.fillStyle = white;
    ctx.fillText(sub, 226, subY + 28);
    const subWidth = ctx.measureText(sub).width;
    ctx.beginPath();
    ctx.moveTo(246 + subWidth, subY + 14);
    ctx.lineTo(340 + subWidth, subY + 14);
    ctx.stroke();
    ctx.restore();
    buttonY = subY + 78;
  }

  drawChurchPill(ctx, CHURCH, 112, Math.min(buttonY, 585));

  await fsp.writeFile(FINAL_OUT, canvas.toBuffer('image/jpeg', { quality: 0.95 }));
  console.log(`Created ${FINAL_OUT}`);
}

async function main() {
  console.log('Running safe test thumbnail workflow. Wix will not be touched.');
  let video = null;
  if (VIDEO_ID) {
    const data = await youtube(`videos?part=snippet,contentDetails&id=${VIDEO_ID}`);
    video = data.items && data.items[0];
  }

  const description = video?.snippet?.description || '';
  const title = SERMON_TITLE || TEST_TITLE || lineValue(description, ['Sermon Title', 'Title']) || stripVideoTitle(video?.snippet?.title || 'Sermon');
  const speaker = MINISTER_NAME || TEST_SPEAKER || lineValue(description, ['Speaker', 'Preacher', 'Minister']) || 'Bethel Tabernacle';
  const subtitle = normalizeSubtitle(SERMON_SUBTITLE || TEST_SUBTITLE || lineValue(description, ['Subtitle', 'Sub Title', 'Part']) || '');
  const thumbs = video?.snippet?.thumbnails || {};
  const fallbackThumbUrl = (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default || {}).url;

  console.log(`Title: ${title}`);
  console.log(`Speaker: ${speaker}`);
  if (subtitle) console.log(`Subtitle: ${subtitle}`);

  const preacherPath = await getInputPreacherImage(video, fallbackThumbUrl);
  await compose({ preacherPath, title, speaker, subtitle });
  console.log(`Created ${FINAL_OUT}, ${DEFAULT_CUTOUT_OUT}, and ${AI_BG_OUT} if OpenAI background succeeded.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
