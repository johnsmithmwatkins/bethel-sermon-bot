/**
 * Manual thumbnail test runner.
 * Generates test-thumbnail.jpg only. Does not upload to Wix or change site data.
 *
 * Key rule: the preacher is NOT redrawn by OpenAI. We use rembg locally so the
 * real photo pixels are preserved. OpenAI is only used for the scenic background.
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
} = process.env;

if (!PREACHER_IMAGE_URL && !VIDEO_ID) {
  throw new Error('Provide either PREACHER_IMAGE_URL or VIDEO_ID. PREACHER_IMAGE_URL gives the best test result.');
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

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
    outer: '#62547d', overlay: 'rgba(65,50,105,0.56)', accent: '#cbb8ff',
    prompt: 'purple mountain style, soft lavender and blue color grade, snowy mountain backdrop, rounded translucent panel, elegant premium church thumbnail',
  },
  forest_green: {
    outer: '#0b526f', overlay: 'rgba(8,24,30,0.44)', accent: '#dcefff',
    prompt: 'deep forest green and blue mountain style, tall evergreen forest, strong scenic depth, premium sermon thumbnail',
  },
  blue_lake: {
    outer: '#08739d', overlay: 'rgba(13,56,88,0.43)', accent: '#c7e9ff',
    prompt: 'cool blue lake style, calm mountain lake, misty blue valley, clean classic sermon thumbnail',
  },
  warm_tan: {
    outer: '#8a6745', overlay: 'rgba(177,130,75,0.50)', accent: '#ffe1aa',
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
  if (PREACHER_IMAGE_URL) {
    console.log('Using provided preacher_image_url.');
    return downloadImage(PREACHER_IMAGE_URL, 'preacher-input');
  }
  const duration = parseDurationSeconds(video?.contentDetails?.duration);
  const seconds = Math.min(Math.max(Math.round(duration * 0.42), 1800), 3900);
  return captureVideoFrame(VIDEO_ID, seconds, fallbackThumbUrl);
}

async function getAlphaStats(pngPath) {
  const img = await loadImage(pngPath);
  const c = createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, img.width, img.height).data;
  let transparent = 0;
  let semiOrTransparent = 0;
  let opaque = 0;
  const total = img.width * img.height;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 10) transparent++;
    if (d[i] < 250) semiOrTransparent++;
    if (d[i] > 245) opaque++;
  }
  return { total, transparent, semiOrTransparent, opaque, transparentRatio: transparent / total, nonOpaqueRatio: semiOrTransparent / total };
}

async function makeLocalCutout(inputPath) {
  const out = path.join(process.cwd(), 'preacher-cutout.png');
  console.log('Removing preacher background locally with rembg so the real photo is preserved...');

  // Use python -m rembg so we do not depend on shell PATH behavior in GitHub Actions.
  await run('python3', ['-m', 'rembg', 'i', inputPath, out]);
  await fsp.access(out);

  const stats = await getAlphaStats(out);
  console.log(`Cutout alpha check: transparent ${(stats.transparentRatio * 100).toFixed(1)}%, non-opaque ${(stats.nonOpaqueRatio * 100).toFixed(1)}%.`);

  if (stats.transparentRatio < 0.08 && stats.nonOpaqueRatio < 0.10) {
    throw new Error('Background removal did not create meaningful transparency. The cutout would still be a rectangle, so stopping instead of making a bad thumbnail.');
  }
  return out;
}

async function makeBackground(title, speaker, subtitle, style) {
  if (!openai) return null;
  const prompt = [
    'Create a beautiful 16:9 sermon thumbnail background only. No people, no faces, no text, no letters, no logos, no watermark.',
    'Use this Bethel Tabernacle established style:', style.prompt + '.',
    'The design should look like a premium church YouTube thumbnail: scenic nature background, rounded main panel, soft color grading, elegant atmosphere, and readable negative space on the left for large sermon title text.',
    'Leave visual room on the right for a preacher cutout. Use mountains, forest, lake, valley, mist, or sunrise/sunset glow. Fresh design, not a copy.',
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
    const out = path.join(process.cwd(), 'ai-background.png');
    await fsp.writeFile(out, Buffer.from(b64, 'base64'));
    return out;
  } catch (err) {
    console.warn(`OpenAI background generation failed: ${err.message}`);
    return null;
  }
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

function alphaTrim(img) {
  const c = createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, img.width, img.height).data;
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (d[(y * img.width + x) * 4 + 3] > 12) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX) return null;
  return {
    x: Math.max(0, minX - 8),
    y: Math.max(0, minY - 8),
    w: Math.min(img.width - Math.max(0, minX - 8), maxX - minX + 17),
    h: Math.min(img.height - Math.max(0, minY - 8), maxY - minY + 17),
  };
}

function drawCutoutContain(ctx, img, trim, x, y, w, h) {
  const sx = trim?.x ?? 0;
  const sy = trim?.y ?? 0;
  const sw = trim?.w ?? img.width;
  const sh = trim?.h ?? img.height;
  const s = Math.min(w / sw, h / sh);
  const dw = sw * s;
  const dh = sh * s;
  ctx.drawImage(img, sx, sy, sw, sh, x + (w - dw) / 2, y + h - dh, dw, dh);
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

function titleCase(name) {
  return String(name || '').replace(/\w\S*/g, (p) => p[0].toUpperCase() + p.slice(1).toLowerCase());
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
    ctx.save();
    roundRect(ctx, 36, 42, 1208, 636, 30);
    ctx.clip();
    cover(ctx, bg, 36, 42, 1208, 636);
    ctx.restore();
  } else {
    drawFallbackBackground(ctx, style);
  }

  ctx.save();
  roundRect(ctx, 36, 42, 1208, 636, 30);
  ctx.clip();
  ctx.fillStyle = style.overlay;
  ctx.fillRect(36, 42, 1208, 636);
  const shade = ctx.createLinearGradient(36, 0, 780, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.30)');
  shade.addColorStop(0.7, 'rgba(0,0,0,0.06)');
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shade;
  ctx.fillRect(36, 42, 820, 636);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.17)';
  ctx.lineWidth = 2;
  roundRect(ctx, 36, 42, 1208, 636, 30);
  ctx.stroke();

  const preacher = await loadImage(cutoutPath);
  const trim = alphaTrim(preacher);
  if (!trim) throw new Error('Could not find preacher pixels in the transparent cutout.');
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetX = -7;
  ctx.shadowOffsetY = 10;
  drawCutoutContain(ctx, preacher, trim, 710, 42, 570, 700);
  ctx.restore();

  ctx.fillStyle = '#fff';
  ctx.font = '40px "Bethel Serif", Georgia, serif';
  ctx.fillText(titleCase(speaker), 112, 145);

  let size = title.length > 42 ? 76 : title.length > 28 ? 88 : 104;
  let lines;
  do {
    ctx.font = `${size}px "Bethel Serif", Georgia, serif`;
    lines = wrapText(ctx, title, 610);
    if (lines.length > 4) size -= 4;
  } while (lines.length > 4 && size > 58);

  let y = lines.length >= 4 ? 240 : 280;
  const gap = size * 0.87;
  for (const line of lines.slice(0, 4)) {
    ctx.fillStyle = '#fff';
    ctx.fillText(line, 112, y);
    y += gap;
  }

  if (subtitle) {
    const sub = normalizeSubtitle(subtitle);
    ctx.strokeStyle = style.accent;
    ctx.globalAlpha = 0.86;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(112, y + 12);
    ctx.lineTo(210, y + 12);
    ctx.moveTo(475, y + 12);
    ctx.lineTo(575, y + 12);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = '54px "Bethel Serif", Georgia, serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(sub, 232, y + 28);
  }

  const tagX = 112, tagY = 595, tagW = 405, tagH = 58;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  roundRect(ctx, tagX, tagY, tagW, tagH, 26);
  ctx.stroke();
  ctx.font = '29px "Bethel Sans", Arial, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText('BETHEL TABERNACLE', tagX + 33, tagY + 39);

  await fsp.writeFile('test-thumbnail.jpg', canvas.toBuffer('image/jpeg', { quality: 0.94 }));
}

async function main() {
  console.log('Running safe test thumbnail workflow. Wix will not be touched.');
  let video = null;
  if (VIDEO_ID) {
    const data = await youtube(`videos?part=snippet,contentDetails&id=${VIDEO_ID}`);
    video = data.items && data.items[0];
  }

  const description = video?.snippet?.description || '';
  const title = TEST_TITLE || lineValue(description, ['Sermon Title', 'Title']) || stripVideoTitle(video?.snippet?.title || 'Sermon');
  const speaker = TEST_SPEAKER || lineValue(description, ['Speaker', 'Preacher', 'Minister']) || 'Bethel Tabernacle';
  const subtitle = normalizeSubtitle(TEST_SUBTITLE || lineValue(description, ['Subtitle', 'Sub Title', 'Part']) || '');
  const thumbs = video?.snippet?.thumbnails || {};
  const fallbackThumbUrl = (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default || {}).url;

  console.log(`Title: ${title}`);
  console.log(`Speaker: ${speaker}`);
  if (subtitle) console.log(`Subtitle: ${subtitle}`);

  const preacherPath = await getInputPreacherImage(video, fallbackThumbUrl);
  await compose({ preacherPath, title, speaker, subtitle });
  console.log('Created test-thumbnail.jpg, preacher-cutout.png, and ai-background.png if OpenAI background succeeded.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
