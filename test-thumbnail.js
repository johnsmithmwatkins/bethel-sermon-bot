/**
 * Manual thumbnail test runner.
 * Generates test-thumbnail.jpg, preacher-cutout.png, and ai-background.png.
 *
 * New architecture:
 * - Use the real preacher frame/cutout.
 * - Use rembg locally only to preserve real preacher pixels.
 * - Use OpenAI gpt-image-2 for the FINAL polished thumbnail composition,
 *   not just the background. This should be much closer to the approved
 *   ChatGPT-made thumbnail style.
 */

const { createCanvas, loadImage } = require('canvas');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const OpenAIpkg = require('openai');
const OpenAI = OpenAIpkg.default || OpenAIpkg;
const toFile = OpenAIpkg.toFile;

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
  OPENAI_IMAGE_MODEL,
  STYLE_1_PATH,
  STYLE_2_PATH,
  STYLE_3_PATH,
  STYLE_4_PATH,
} = process.env;

if (!PREACHER_IMAGE_URL && !VIDEO_ID && !CUTOUT_PATH) {
  throw new Error('Provide PREACHER_IMAGE_URL, VIDEO_ID, or CUTOUT_PATH. PREACHER_IMAGE_URL gives the best test result.');
}
if (!OPENAI_API_KEY) {
  throw new Error('Missing OPENAI_API_KEY secret. The final thumbnail now uses the OpenAI image model.');
}
if (!toFile) {
  throw new Error('The installed openai npm package does not expose toFile(). Run npm install openai@latest or update package.json.');
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const MODEL = OPENAI_IMAGE_MODEL || 'gpt-image-2';
const FINAL_OUT = OUT_PATH || 'test-thumbnail.jpg';
const CUTOUT_OUT = 'preacher-cutout.png';
const AI_BG_OUT = 'ai-background.png';
const CHURCH = CHURCH_NAME || 'Bethel Tabernacle';

const STYLES = {
  purple_mountain: {
    outer: '#62547d',
    prompt: 'purple and lavender mountain lake background, soft premium church thumbnail palette, elegant mist, cinematic sunrise glow',
  },
  forest_green: {
    outer: '#0b526f',
    prompt: 'deep blue green forest and mountain valley, soft premium church thumbnail palette, cinematic atmospheric depth',
  },
  blue_lake: {
    outer: '#08739d',
    prompt: 'cool blue mountain lake background, misty valley, premium clean sermon thumbnail palette',
  },
  warm_tan: {
    outer: '#8a6745',
    prompt: 'warm tan gold autumn mountain background, soft beige premium church thumbnail palette',
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

function cover(ctx, img, x, y, w, h, fx = 0.5, fy = 0.5) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s;
  const sh = h / s;
  const sx = Math.max(0, Math.min(img.width - sw, img.width * fx - sw / 2));
  const sy = Math.max(0, Math.min(img.height - sh, img.height * fy - sh / 2));
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

async function fitImageToJpg(inputPath, outputPath, width = 1280, height = 720) {
  const img = await loadImage(inputPath);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  cover(ctx, img, 0, 0, width, height);
  await fsp.writeFile(outputPath, canvas.toBuffer('image/jpeg', { quality: 0.95 }));
}

async function makeRembgCutout(inputPath) {
  if (CUTOUT_PATH && fs.existsSync(CUTOUT_PATH)) {
    // Normalize existing cutout to PNG artifact name.
    const img = await loadImage(CUTOUT_PATH);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    await fsp.writeFile(CUTOUT_OUT, canvas.toBuffer('image/png'));
    return CUTOUT_OUT;
  }

  const py = path.join(os.tmpdir(), `rembg-api-${Date.now()}.py`);
  const pyCode = `
from rembg import remove
from PIL import Image
import sys
inp, out = sys.argv[1], sys.argv[2]
img = Image.open(inp).convert('RGBA')
result = remove(img)
# Crop around the preacher, ignoring the lowest clutter-heavy area.
alpha = result.getchannel('A')
w, h = result.size
scan = alpha.crop((0, 0, w, int(h * 0.82)))
bbox = scan.getbbox() or alpha.getbbox()
if bbox:
    x1, y1, x2, y2 = bbox
    pad_x = int((x2 - x1) * 0.05)
    pad_top = int((y2 - y1) * 0.035)
    x1 = max(0, x1 - pad_x)
    y1 = max(0, y1 - pad_top)
    x2 = min(w, x2 + pad_x)
    y2 = min(h, y2 + int((y2 - y1) * 0.03))
    result = result.crop((x1, y1, x2, y2))
result.save(out)
`;
  await fsp.writeFile(py, pyCode);
  await run('python3', [py, inputPath, CUTOUT_OUT]);
  await fsp.access(CUTOUT_OUT);
  console.log(`Created ${CUTOUT_OUT}`);
  return CUTOUT_OUT;
}

async function makeBackgroundBase(title, speaker, subtitle, style) {
  if (BG_PATH && fs.existsSync(BG_PATH)) {
    await fitImageToJpg(BG_PATH, AI_BG_OUT);
    return AI_BG_OUT;
  }

  const prompt = [
    'Create a beautiful 16:9 sermon thumbnail background only. No people, no faces, no text, no letters, no logos, no watermark.',
    'Use this Bethel Tabernacle style:', style.prompt + '.',
    'Premium church YouTube thumbnail background, scenic nature, mountains, lake or forest, soft cinematic color, elegant atmosphere.',
    'Leave clean negative space on the left for large title text and room on the right for a preacher cutout.',
    `Sermon title mood: ${title}. Speaker: ${speaker}. ${subtitle ? `Subtitle: ${subtitle}.` : ''}`,
  ].join(' ');

  console.log('Creating AI scenic background base...');
  const rsp = await openai.images.generate({
    model: MODEL,
    prompt,
    size: '1536x1024',
    quality: 'high',
    output_format: 'png',
  });
  const b64 = rsp?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI did not return a background image.');
  await fsp.writeFile(AI_BG_OUT, Buffer.from(b64, 'base64'));
  return AI_BG_OUT;
}

function styleAnchorPaths() {
  return [STYLE_1_PATH, STYLE_2_PATH, STYLE_3_PATH, STYLE_4_PATH]
    .filter(Boolean)
    .filter((p) => fs.existsSync(p));
}

function finalPrompt({ title, speaker, subtitle, style }) {
  const sub = subtitle
    ? `Use subtitle exactly: "${subtitle}". Render it as a tasteful smaller supporting line beneath the main title.`
    : 'Do not invent a subtitle, part number, date, or extra line.';

  return `
Create the final finished Bethel Tabernacle sermon thumbnail using the provided reference images.

Reference images:
- Image 1 is the scenic background/base.
- Image 2 is the REAL preacher cutout/reference. Preserve the preacher's real face, real hair, glasses, skin tone, suit, and expression. Do not invent a new face. Do not redraw him as a different person. Keep him realistic and clean.
- Any additional images are style anchors only. Match their polished Bethel thumbnail design language, but do not copy their text.

Final image requirements:
- 16:9 YouTube sermon thumbnail.
- Professional, premium, clean church thumbnail look.
- Use the provided preacher as a large right-side cutout, roughly chest-up to mid-torso, prominent and natural.
- Remove/hide pulpit, iPad/tablet, microphone stand, books, or bottom clutter. Do not show a lectern box.
- Left side: elegant translucent rounded rectangle/glass panel for text, like the approved Bethel thumbnails.
- Beautiful nature background: ${style.prompt}.
- Elegant serif title typography, large and readable.
- Refined purple/blue/lavender color harmony unless the scene naturally suggests another related premium palette.
- Soft cinematic shading, tasteful border/frame feel, high-end polish.

Exact text to render:
- Minister name at top left: "${speaker}"
- Main sermon title: "${title}"
- ${sub}
- Bottom rounded pill/button text: "${CHURCH.toUpperCase()}"

Critical rules:
- Render the text correctly and clearly.
- Do not add any extra words.
- Do not include fake signatures, watermarks, logos, or gibberish.
- Do not make a generic pasted collage.
- Do not make the preacher small.
- Make it look like the polished thumbnail ChatGPT created manually for this sermon.
`.trim();
}

async function fileInput(p) {
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return toFile(fs.createReadStream(p), path.basename(p), { type: mime });
}

async function generateFinalWithOpenAI({ bgPath, cutoutPath, title, speaker, subtitle, style }) {
  console.log(`Creating FINAL thumbnail composition with OpenAI image model ${MODEL}...`);

  const imageInputs = [await fileInput(bgPath), await fileInput(cutoutPath)];
  for (const p of styleAnchorPaths()) {
    imageInputs.push(await fileInput(p));
  }

  const rsp = await openai.images.edit({
    model: MODEL,
    image: imageInputs,
    prompt: finalPrompt({ title, speaker, subtitle, style }),
    size: '1536x1024',
    quality: 'high',
  });

  const b64 = rsp?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI did not return a final thumbnail image.');

  const tmp = path.join(os.tmpdir(), `final-ai-thumbnail-${Date.now()}.png`);
  await fsp.writeFile(tmp, Buffer.from(b64, 'base64'));
  await fitImageToJpg(tmp, FINAL_OUT);
  console.log(`Created ${FINAL_OUT}`);
}

async function main() {
  console.log('Running safe test thumbnail workflow. Wix will not be touched.');
  console.log('Mode: OpenAI image model FINAL composition.');

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
  const style = chooseStyle(title);

  console.log(`Title: ${title}`);
  console.log(`Speaker: ${speaker}`);
  if (subtitle) console.log(`Subtitle: ${subtitle}`);
  console.log(`Style mode: ${style.id}`);

  const preacherInput = await getInputPreacherImage(video, fallbackThumbUrl);
  const cutoutPath = await makeRembgCutout(preacherInput);
  const bgPath = await makeBackgroundBase(title, speaker, subtitle, style);
  await generateFinalWithOpenAI({ bgPath, cutoutPath, title, speaker, subtitle, style });

  console.log(`Created ${FINAL_OUT}, ${CUTOUT_OUT}, and ${AI_BG_OUT}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
