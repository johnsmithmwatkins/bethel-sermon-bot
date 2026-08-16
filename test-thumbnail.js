/**
 * Manual thumbnail test runner.
 * Generates test-thumbnail.jpg only. Does not upload to Wix or change site data.
 *
 * Better recipe:
 * 1) Use OpenAI to remove the preacher background.
 * 2) Use OpenAI to create a scenic Bethel-style nature background.
 * 3) Use code to place exact title/name/church text so spelling stays right.
 */

const { createCanvas, loadImage, registerFont } = require('canvas');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const OpenAIpkg = require('openai');
const OpenAI = OpenAIpkg.default || OpenAIpkg;
const { toFile } = OpenAIpkg;

const {
  YOUTUBE_API_KEY,
  OPENAI_API_KEY,
  VIDEO_ID,
  PREACHER_IMAGE_URL,
  TEST_TITLE,
  TEST_SPEAKER,
  TEST_SUBTITLE,
  STYLE_MODE,
} = process.env;

if (!PREACHER_IMAGE_URL && !VIDEO_ID) {
  throw new Error('Provide either PREACHER_IMAGE_URL or VIDEO_ID. PREACHER_IMAGE_URL gives the best result.');
}
if (!OPENAI_API_KEY) console.warn('OPENAI_API_KEY missing. Falling back to non-AI background/cutout.');

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function font(file, family, weight = 'normal', style = 'normal') {
  try { if (fs.existsSync(file)) registerFont(file, { family, weight, style }); } catch (_) {}
}
font('/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf', 'Bethel Serif');
font('/usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf', 'Bethel Serif', 'bold');
font('/usr/share/fonts/truetype/liberation2/LiberationSerif-Italic.ttf', 'Bethel Serif', 'normal', 'italic');
font('/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf', 'Bethel Sans');
font('/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf', 'Bethel Sans', 'bold');
font(path.join(__dirname, 'assets', 'DejaVuSans.ttf'), 'Bethel Sans Fallback');
font(path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf'), 'Bethel Sans Fallback', 'bold');

const STYLES = {
  purple_mountain: {
    outer: '#62547d', overlay: 'rgba(55,45,95,0.58)', accent: '#cbb8ff',
    prompt: 'purple mountain style, soft lavender blue tint, snowy mountain backdrop, rounded translucent panel, elegant premium church thumbnail',
  },
  forest_green: {
    outer: '#0b526f', overlay: 'rgba(8,24,30,0.43)', accent: '#dcefff',
    prompt: 'deep forest green and blue mountain style, tall evergreen forest, high contrast scenic depth, premium sermon thumbnail',
  },
  blue_lake: {
    outer: '#08739d', overlay: 'rgba(13,56,88,0.42)', accent: '#c7e9ff',
    prompt: 'cool blue lake style, calm mountain lake, misty blue valley, clean classic sermon thumbnail',
  },
  warm_tan: {
    outer: '#8a6745', overlay: 'rgba(177,130,75,0.50)', accent: '#ffe1aa',
    prompt: 'warm tan and gold style, soft autumn mountain edges, premium beige panel, gentle church thumbnail',
  },
};

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
function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 240000, ...options }, (error, stdout, stderr) => {
      if (error) { error.message += `\nCommand: ${cmd} ${args.join(' ')}\nSTDERR: ${stderr}`; reject(error); return; }
      resolve(stdout.trim());
    });
  });
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
    const m = desc.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)\\s*$`, 'im'));
    if (m) return m[1].trim();
  }
  return null;
}
function stripVideoTitle(title) {
  return (title || 'Sermon').replace(/\|\s*Bethel Tabernacle.*$/i, '').replace(/-\s*Bethel Tabernacle.*$/i, '').replace(/\bLive Stream\b/gi, '').trim();
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
    console.warn(`Could not capture video frame, using YouTube thumbnail instead. ${err.message}`);
    return downloadImage(fallbackThumbUrl, 'youtube-thumbnail');
  }
}
async function imageEdit({ model, images, prompt, size, background, output_format = 'png', quality = 'high' }) {
  if (!openai) return null;
  try {
    const files = [];
    for (const img of images) {
      files.push(await toFile(fs.createReadStream(img), path.basename(img), { type: img.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
    }
    const params = { model, image: files.length === 1 ? files[0] : files, prompt, size, quality, output_format };
    if (background) params.background = background;
    const rsp = await openai.images.edit(params);
    const b64 = rsp?.data?.[0]?.b64_json;
    return b64 ? Buffer.from(b64, 'base64') : null;
  } catch (err) {
    console.warn(`OpenAI image edit failed (${model}): ${err.message}`);
    return null;
  }
}
async function imageGenerate({ prompt, size = '1536x1024' }) {
  if (!openai) return null;
  try {
    const rsp = await openai.images.generate({ model: 'gpt-image-2', prompt, size, quality: 'high', output_format: 'png' });
    const b64 = rsp?.data?.[0]?.b64_json;
    return b64 ? Buffer.from(b64, 'base64') : null;
  } catch (err) {
    console.warn(`OpenAI background generation failed: ${err.message}`);
    return null;
  }
}
async function makeCutout(preacherPath) {
  const prompt = 'Extract only the preacher/person from this sermon screenshot. Remove the entire background, wall art, pulpit, microphones, tablets, water bottles, and any other people. Preserve the preacher accurately and naturally. Clean up edges. Slightly improve lighting. Output a transparent-background PNG cutout.';
  const buf = await imageEdit({ model: 'gpt-image-1', images: [preacherPath], prompt, size: '1024x1024', background: 'transparent', output_format: 'png', quality: 'high' });
  if (!buf) return preacherPath;
  const out = path.join(os.tmpdir(), `preacher-cutout-${Date.now()}.png`);
  await fsp.writeFile(out, buf);
  return out;
}
async function makeBackground(title, speaker, subtitle, style) {
  const prompt = [
    'Create a beautiful scenic sermon thumbnail background only. No people, no text, no letters, no logos, no watermark.',
    'Use this Bethel Tabernacle established style:', style.prompt + '.',
    'The design should have a rounded rectangle main panel, scenic nature background, premium soft color grading, and open readable space on the left for large sermon title text.',
    'Leave room on the right for a preacher cutout. Use mountains, forest, lake, valley, mist, or sunset glow. Make it unique but in the same visual family as premium Bethel sermon thumbnails.',
    `Sermon: ${title}. Speaker: ${speaker}. ${subtitle ? `Subtitle: ${subtitle}.` : ''}`,
  ].join(' ');
  const buf = await imageGenerate({ prompt });
  if (!buf) return null;
  const out = path.join(os.tmpdir(), `ai-background-${Date.now()}.png`);
  await fsp.writeFile(out, buf);
  return out;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function cover(ctx, img, x, y, w, h, fx = 0.5, fy = 0.5) {
  const s = Math.max(w / img.width, h / img.height), sw = w / s, sh = h / s;
  const sx = Math.max(0, Math.min(img.width - sw, img.width * fx - sw / 2));
  const sy = Math.max(0, Math.min(img.height - sh, img.height * fy - sh / 2));
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}
function alphaTrim(img) {
  const c = createCanvas(img.width, img.height), cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, img.width, img.height).data;
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (d[(y * img.width + x) * 4 + 3] > 12) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (maxX < minX) return null;
  return { x: Math.max(0, minX - 8), y: Math.max(0, minY - 8), w: Math.min(img.width - minX, maxX - minX + 17), h: Math.min(img.height - minY, maxY - minY + 17) };
}
function containTrim(ctx, img, trim, x, y, w, h) {
  const sx = trim?.x || 0, sy = trim?.y || 0, sw = trim?.w || img.width, sh = trim?.h || img.height;
  const s = Math.min(w / sw, h / sh), dw = sw * s, dh = sh * s;
  ctx.drawImage(img, sx, sy, sw, sh, x + (w - dw) / 2, y + h - dh, dw, dh);
}
function wrap(ctx, text, max) {
  const words = String(text).split(/\s+/), lines = []; let line = '';
  for (const word of words) { const test = line ? `${line} ${word}` : word; if (ctx.measureText(test).width > max && line) { lines.push(line); line = word; } else line = test; }
  if (line) lines.push(line); return lines;
}
function titleCase(name) { return String(name || '').replace(/\w\S*/g, p => p[0].toUpperCase() + p.slice(1).toLowerCase()); }
async function compose({ preacherPath, title, speaker, subtitle }) {
  const style = chooseStyle(title);
  console.log(`Style mode: ${style.id}`);
  const bgPath = await makeBackground(title, speaker, subtitle, style);
  const cutoutPath = await makeCutout(preacherPath);
  const canvas = createCanvas(1280, 720), ctx = canvas.getContext('2d');

  ctx.fillStyle = style.outer; ctx.fillRect(0, 0, 1280, 720);
  if (bgPath) { const bg = await loadImage(bgPath); ctx.save(); roundRect(ctx, 36, 42, 1208, 636, 30); ctx.clip(); cover(ctx, bg, 36, 42, 1208, 636); ctx.restore(); }
  else { ctx.fillStyle = '#17213c'; roundRect(ctx, 36, 42, 1208, 636, 30); ctx.fill(); }

  ctx.save(); roundRect(ctx, 36, 42, 1208, 636, 30); ctx.clip();
  ctx.fillStyle = style.overlay; ctx.fillRect(36, 42, 1208, 636);
  const shade = ctx.createLinearGradient(36, 0, 760, 0); shade.addColorStop(0, 'rgba(0,0,0,0.32)'); shade.addColorStop(0.7, 'rgba(0,0,0,0.07)'); shade.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = shade; ctx.fillRect(36, 42, 820, 636);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.17)'; ctx.lineWidth = 2; roundRect(ctx, 36, 42, 1208, 636, 30); ctx.stroke();

  const preacher = await loadImage(cutoutPath), trim = cutoutPath.endsWith('.png') ? alphaTrim(preacher) : null;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.42)'; ctx.shadowBlur = 22; ctx.shadowOffsetX = -6; ctx.shadowOffsetY = 10; containTrim(ctx, preacher, trim, 690, 55, 590, 690); ctx.restore();

  ctx.fillStyle = '#fff'; ctx.font = '40px "Bethel Serif", Georgia, serif'; ctx.fillText(titleCase(speaker), 112, 145);
  let size = title.length > 42 ? 76 : title.length > 28 ? 88 : 104, lines;
  do { ctx.font = `${size}px "Bethel Serif", Georgia, serif`; lines = wrap(ctx, title, 650); if (lines.length > 4) size -= 5; } while (lines.length > 4 && size > 48);
  let y = subtitle ? 260 : 315, gap = size * 0.86;
  for (const line of lines) { ctx.fillText(line, 112, y); y += gap; }
  if (subtitle) {
    const sy = Math.min(585, y + 25); ctx.strokeStyle = style.accent; ctx.globalAlpha = 0.82; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(115, sy - 17); ctx.lineTo(205, sy - 17); ctx.moveTo(500, sy - 17); ctx.lineTo(590, sy - 17); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.font = '58px "Bethel Serif", Georgia, serif'; ctx.save(); ctx.transform(1, 0, -0.14, 1, 0, 0); ctx.fillText(subtitle.replace(/^part\s+/i, 'Part '), 250, sy); ctx.restore();
  }
  const tagX = 112, tagY = 600, tagW = 430, tagH = 62;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 3; roundRect(ctx, tagX, tagY, tagW, tagH, 29); ctx.stroke();
  ctx.font = 'bold 29px "Bethel Sans", Arial, sans-serif'; ctx.fillText('B E T H E L   T A B E R N A C L E', tagX + 34, tagY + 41);
  await fsp.writeFile('test-thumbnail.jpg', canvas.toBuffer('image/jpeg', { quality: 0.93 }));
  if (bgPath) await fsp.copyFile(bgPath, 'ai-background.png').catch(() => {});
  if (cutoutPath.endsWith('.png')) await fsp.copyFile(cutoutPath, 'preacher-cutout.png').catch(() => {});
}
async function main() {
  let title = TEST_TITLE || 'Sermon Title', speaker = TEST_SPEAKER || 'Bethel Tabernacle', subtitle = TEST_SUBTITLE || '', preacherPath;
  if (PREACHER_IMAGE_URL) preacherPath = await downloadImage(PREACHER_IMAGE_URL, 'preacher');
  else {
    const data = await youtube(`videos?part=snippet,contentDetails&id=${VIDEO_ID}`); const video = data.items?.[0]; if (!video) throw new Error(`Could not find video ${VIDEO_ID}`);
    const desc = video.snippet.description || ''; const thumbs = video.snippet.thumbnails || {}; const thumb = (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default).url;
    title = TEST_TITLE || lineValue(desc, ['Sermon Title', 'Title']) || stripVideoTitle(video.snippet.title); speaker = TEST_SPEAKER || lineValue(desc, ['Speaker', 'Preacher', 'Minister']) || 'Bethel Tabernacle'; subtitle = TEST_SUBTITLE || lineValue(desc, ['Subtitle', 'Sub Title', 'Part']) || '';
    preacherPath = await captureVideoFrame(VIDEO_ID, Math.min(Math.max(Math.round(parseDurationSeconds(video.contentDetails.duration) * 0.42), 1800), 3900), thumb);
  }
  console.log(`Title: ${title}`); console.log(`Speaker: ${speaker}`); if (subtitle) console.log(`Subtitle: ${subtitle}`);
  await compose({ preacherPath, title, speaker, subtitle }); console.log('Created test-thumbnail.jpg');
}
main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
