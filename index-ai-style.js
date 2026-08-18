/**
 * Bethel Tabernacle — Automatic Sermon Uploader
 * ------------------------------------------------
 * Live bot with safe custom thumbnail generation.
 *
 * Existing Wix sermon flow is protected:
 * - If custom thumbnail generation succeeds, Wix gets the OpenAI-designed thumbnail.
 * - If frame capture, rembg, OpenAI, or anything thumbnail-related fails, Wix still gets
 *   the regular YouTube thumbnail-style fallback and the sermon is still added.
 */

const { createCanvas, loadImage, registerFont } = require('canvas');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const fssync = require('fs');
const os = require('os');
const path = require('path');

const {
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
  WIX_API_KEY,
  WIX_SITE_ID,
  OPENAI_API_KEY,
  STYLE_MODE,
  OPENAI_IMAGE_MODEL,
} = process.env;

for (const [key, value] of Object.entries({
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
  WIX_API_KEY,
  WIX_SITE_ID,
})) {
  if (!value) {
    console.error(`Missing required secret: ${key}. Add it under Settings > Secrets and variables > Actions.`);
    process.exit(1);
  }
}

const COLLECTION_ID = 'Sermons';
const MANUAL_SORT_FIELD = '_manualSort_9510f576-af2a-4ca5-93c3-008a3d8b80bb';
const EXCLUDE_TITLE_KEYWORDS = ['sunday school'];
const MAX_VIDEOS_TO_CHECK = 15;
const IMAGE_MODEL = OPENAI_IMAGE_MODEL || 'gpt-image-2';

registerFont(path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf'), { family: 'Bethel Bold' });
registerFont(path.join(__dirname, 'assets', 'DejaVuSans.ttf'), { family: 'Bethel Regular' });

const STYLES = {
  purple_mountain: {
    label: 'purple mountain',
    colors: '#62547d, #372b5f, lavender blue, soft white',
    prompt: 'soft lavender and blue mountain mood, snowy mountain or valley atmosphere, refined purple frame, elegant premium church thumbnail',
  },
  forest_green: {
    label: 'forest green',
    colors: '#0b526f, #123b35, deep evergreen, misty blue',
    prompt: 'deep forest green and blue mountain mood, tall evergreen forest, misty valley depth, clean premium sermon thumbnail',
  },
  blue_lake: {
    label: 'blue lake',
    colors: '#08739d, #144e75, cool lake blue, pale sky',
    prompt: 'cool blue lake and mountain mood, calm water, misty blue valley, clean classic Bethel sermon thumbnail',
  },
  warm_tan: {
    label: 'warm tan',
    colors: '#8a6745, #a67f54, warm gold, soft cream',
    prompt: 'warm tan and gold mountain mood, autumn glow, soft sunrise or sunset, premium beige church thumbnail',
  },
};

function chooseStyle() {
  const keys = Object.keys(STYLES);
  if (STYLE_MODE && STYLE_MODE !== 'random' && STYLES[STYLE_MODE]) {
    return { id: STYLE_MODE, ...STYLES[STYLE_MODE] };
  }
  const id = keys[Math.floor(Math.random() * keys.length)];
  return { id, ...STYLES[id] };
}

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

async function youtube(pathAndQuery) {
  const url = `https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getUploadsPlaylistId() {
  const data = await youtube(`channels?part=contentDetails&id=${YOUTUBE_CHANNEL_ID}`);
  const item = data.items && data.items[0];
  if (!item) throw new Error('Could not find the YouTube channel — double check YOUTUBE_CHANNEL_ID.');
  return item.contentDetails.relatedPlaylists.uploads;
}

async function getRecentVideoIds(playlistId) {
  const data = await youtube(`playlistItems?part=contentDetails&playlistId=${playlistId}&maxResults=${MAX_VIDEOS_TO_CHECK}`);
  return (data.items || []).map((i) => i.contentDetails.videoId).reverse();
}

async function getVideoDetails(videoIds) {
  if (!videoIds.length) return [];
  return (await youtube(`videos?part=snippet,liveStreamingDetails,status,contentDetails&id=${videoIds.join(',')}`)).items || [];
}

async function wix(pathname, method, body) {
  const res = await fetch(`https://www.wixapis.com${pathname}`, {
    method,
    headers: {
      Authorization: WIX_API_KEY,
      'wix-site-id': WIX_SITE_ID,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Wix API error ${res.status} on ${pathname}: ${JSON.stringify(json)}`);
  return json;
}

async function sermonAlreadyExists(videoId) {
  const result = await wix('/wix-data/v2/items/query', 'POST', {
    dataCollectionId: COLLECTION_ID,
    query: { filter: { url: { $contains: videoId } }, paging: { limit: 1 } },
  });
  return (result.dataItems || []).length > 0;
}

async function getCurrentRecentItemIds() {
  const result = await wix('/wix-data/v2/items/query', 'POST', {
    dataCollectionId: COLLECTION_ID,
    query: { filter: { isRecent: { $eq: true } }, paging: { limit: 20 } },
  });
  return (result.dataItems || []).map((i) => i.id);
}

async function uploadImageToWix(buffer, fileName) {
  const gen = await wix('/site-media/v1/files/generate-upload-url', 'POST', { mimeType: 'image/jpeg', fileName });
  const uploadRes = await fetch(`${gen.uploadUrl}?filename=${encodeURIComponent(fileName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: buffer,
  });
  const uploadJson = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) throw new Error(`Wix media upload failed: ${JSON.stringify(uploadJson)}`);
  return uploadJson.file;
}

async function insertSermon(data) {
  return wix('/wix-data/v2/items', 'POST', { dataCollectionId: COLLECTION_ID, dataItem: { data } });
}

async function clearOldRecentFlags(excludeId) {
  const ids = (await getCurrentRecentItemIds()).filter((id) => id !== excludeId);
  if (!ids.length) return;
  await wix('/wix-data/v2/bulk/items/patch', 'POST', {
    dataCollectionId: COLLECTION_ID,
    patches: ids.map((id) => ({
      dataItemId: id,
      fieldModifications: [{ fieldPath: 'isRecent', action: 'SET_FIELD', setFieldOptions: { value: false } }],
    })),
  });
}

function manualSortValue(dateStr) {
  const inverse = 99999999 - parseInt(dateStr.replace(/-/g, ''), 10);
  return `0${String(inverse).padStart(8, '0')}`;
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
  return String(title || 'Sermon')
    .replace(/\|\s*Bethel Tabernacle.*$/i, '')
    .replace(/-\s*Bethel Tabernacle.*$/i, '')
    .replace(/\bLive Stream\b/gi, '')
    .trim();
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

function parseDurationSeconds(isoDuration) {
  if (!isoDuration) return null;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  return (parseInt(match[1] || '0', 10) * 3600) + (parseInt(match[2] || '0', 10) * 60) + parseInt(match[3] || '0', 10);
}

function normalizePartWord(n) {
  return ({ 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten' }[n] || String(n));
}

function getDisplayData(video) {
  const description = video.snippet.description || '';
  const rawTitle = lineValue(description, ['Sermon Title', 'Title']) || stripVideoTitle(video.snippet.title || 'Sermon');
  const speaker = lineValue(description, ['Speaker', 'Preacher', 'Minister']) || 'Bethel Tabernacle';
  let subtitle = lineValue(description, ['Subtitle', 'Sub Title', 'Part']);

  const partInTitle = rawTitle.match(/\b(Part\s+(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+))\b/i);
  let title = rawTitle;
  if (!subtitle && partInTitle) {
    subtitle = partInTitle[1].replace(/\b(\d+)\b/, (_, n) => normalizePartWord(parseInt(n, 10)));
    title = rawTitle.replace(partInTitle[0], '').replace(/[-–—:]+\s*$/, '').trim();
  }
  if (subtitle && !/^part\b/i.test(subtitle)) subtitle = `Part ${subtitle}`;

  return { title, speaker, subtitle };
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

async function downloadToFile(url, output) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
  await fs.writeFile(output, Buffer.from(await res.arrayBuffer()));
  return output;
}

async function captureVideoFrame(videoId, seconds, fallbackThumbUrl) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bethel-thumb-'));
  const output = path.join(tmpDir, `${videoId}.jpg`);
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    console.log(`  Capturing preacher frame around ${seconds}s...`);
    const mediaUrls = await run('yt-dlp', ['-f', 'bv*[height<=720]/b[height<=720]/best', '-g', videoUrl]);
    const mediaUrl = mediaUrls.split('\n').find(Boolean);
    if (!mediaUrl) throw new Error('yt-dlp did not return a media URL.');
    await run('ffmpeg', ['-y', '-ss', String(seconds), '-i', mediaUrl, '-frames:v', '1', '-q:v', '2', output]);
    await fs.access(output);
    return output;
  } catch (err) {
    console.warn(`  ! Could not capture video frame, using YouTube thumbnail as source frame. ${err.message}`);
    return downloadToFile(fallbackThumbUrl, output);
  }
}

async function makeRembgCutout(inputPath) {
  const out = path.join(path.dirname(inputPath), `cutout-${Date.now()}.png`);
  const py = path.join(os.tmpdir(), `rembg-api-${Date.now()}.py`);
  await fs.writeFile(py, `
from rembg import remove
from PIL import Image
import sys
img = Image.open(sys.argv[1]).convert('RGBA')
result = remove(img)
result.save(sys.argv[2])
`);
  await run('python3', [py, inputPath, out]);
  await fs.access(out);
  return cleanAndCropCutout(out);
}

function alphaBox(canvas, ignoreLower = 0) {
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const yLimit = Math.floor(canvas.height * (1 - ignoreLower));
  let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
  for (let y = 0; y < yLimit; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const a = d[(y * canvas.width + x) * 4 + 3];
      if (a > 12) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

async function cleanAndCropCutout(inputPath) {
  const img = await loadImage(inputPath);
  const src = createCanvas(img.width, img.height);
  const sctx = src.getContext('2d');
  sctx.drawImage(img, 0, 0);
  const box = alphaBox(src, 0.18) || alphaBox(src, 0) || { x: 0, y: 0, w: img.width, h: img.height };
  const padX = Math.round(box.w * 0.05);
  const padTop = Math.round(box.h * 0.03);
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padTop);
  const w = Math.min(img.width - x, box.w + padX * 2);
  const h = Math.min(img.height - y, Math.round(box.h * 0.88) + padTop);
  const out = path.join(path.dirname(inputPath), `preacher-cutout-${Date.now()}.png`);
  const dst = createCanvas(w, h);
  dst.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  await fs.writeFile(out, dst.toBuffer('image/png'));
  return out;
}

function drawBasicFallbackThumbnailBuffer(sourceThumbBuffer, title, speaker) {
  return loadImage(sourceThumbBuffer).then((img) => {
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, img.width, img.height);
    const bandHeight = Math.round(img.height * 0.32);
    const bandY = img.height - bandHeight;
    const gradient = ctx.createLinearGradient(0, bandY, 0, img.height);
    gradient.addColorStop(0, 'rgba(8, 16, 33, 0)');
    gradient.addColorStop(0.4, 'rgba(8, 16, 33, 0.88)');
    gradient.addColorStop(1, 'rgba(8, 16, 33, 0.94)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, bandY, img.width, bandHeight);

    const paddingX = Math.round(img.width * 0.045);
    let titleSize = Math.round(img.height * 0.078);
    ctx.font = `${titleSize}px "Bethel Bold"`;
    let lines = wrapText(ctx, title.toUpperCase(), img.width - paddingX * 2);
    while (lines.length > 2 && titleSize > 26) {
      titleSize -= 2;
      ctx.font = `${titleSize}px "Bethel Bold"`;
      lines = wrapText(ctx, title.toUpperCase(), img.width - paddingX * 2);
    }
    lines = lines.slice(0, 2);
    ctx.fillStyle = '#ffffff';
    const lineGap = titleSize * 1.15;
    let y = img.height - Math.round(img.height * 0.105) - (lines.length - 1) * lineGap;
    for (const line of lines) { ctx.fillText(line, paddingX, y); y += lineGap; }
    ctx.font = `${Math.round(img.height * 0.042)}px "Bethel Regular"`;
    ctx.fillStyle = '#d7dee8';
    ctx.fillText(speaker.toUpperCase(), paddingX, img.height - Math.round(img.height * 0.035));
    ctx.font = `${Math.round(img.height * 0.045)}px "Bethel Bold"`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText('BETHEL TABERNACLE', paddingX, Math.round(img.height * 0.09));
    return canvas.toBuffer('image/jpeg', { quality: 0.9 });
  });
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else { line = test; }
  }
  if (line) lines.push(line);
  return lines;
}

async function fileBlob(filePath, mime) {
  const bytes = await fs.readFile(filePath);
  return new Blob([bytes], { type: mime });
}

function buildOpenAIThumbnailPrompt({ title, subtitle, speaker, dateStr, style }) {
  return `Create a polished 16:9 YouTube sermon thumbnail for Bethel Tabernacle.

Reference images:
- Image 1 is the real preacher cutout. Preserve the real face, hair, glasses, skin tone, suit, and expression. Do not invent a new face and do not make him look AI-generated.
- Image 2 is the original sermon frame/YouTube thumbnail for context only.

Design style for this run: ${style.label}. ${style.prompt}. Color family: ${style.colors}.

Layout requirements:
- Put the preacher large and clean on the RIGHT side, roughly mid-torso or chest-up.
- Remove pulpit, iPad/tablet, microphone stand clutter, books, and screenshot remnants.
- Put the text on the LEFT side with a refined translucent rounded panel if needed.
- Use elegant serif typography and a premium Bethel Tabernacle sermon thumbnail look.
- Use beautiful nature scenery: mountain, lake, forest, valley, sky, mist, sunrise or sunset glow.
- Use a tasteful outer frame/border feel and soft cinematic shading.
- Make it clean, professional, and readable, not a basic pasted collage.

Exact text to include:
- Speaker name at top left: "${speaker}"
- Main title: "${title}"
- ${subtitle ? `Subtitle/part line: "${subtitle}"` : 'No subtitle/part line unless it naturally belongs.'}
- Bottom-left rounded pill/button text: "BETHEL TABERNACLE"
- ${dateStr ? `You may include date subtly only if it fits: "${dateStr}"` : 'Do not add a date.'}

Critical rules:
- Do not copy text from the context image.
- Spell all text exactly as provided.
- Do not make the preacher tiny.
- Keep the finished result close to the clean, polished Bethel sermon thumbnails approved by the church.`;
}

async function generateOpenAIFinalThumbnail({ framePath, cutoutPath, title, subtitle, speaker, dateStr, style }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing.');
  const form = new FormData();
  form.append('model', IMAGE_MODEL);
  form.append('prompt', buildOpenAIThumbnailPrompt({ title, subtitle, speaker, dateStr, style }));
  form.append('quality', 'high');
  form.append('size', '1536x1024');
  form.append('image[]', await fileBlob(cutoutPath, 'image/png'), 'preacher-cutout.png');
  form.append('image[]', await fileBlob(framePath, 'image/jpeg'), 'sermon-frame.jpg');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI image edit failed ${res.status}: ${JSON.stringify(json)}`);
  const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw new Error('OpenAI returned no thumbnail image data.');
  return Buffer.from(b64, 'base64');
}

async function forceYoutubeJpeg16x9(buffer) {
  const img = await loadImage(buffer);
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext('2d');
  const scale = Math.max(1280 / img.width, 720 / img.height);
  const sw = 1280 / scale;
  const sh = 720 / scale;
  const sx = Math.max(0, (img.width - sw) / 2);
  const sy = Math.max(0, (img.height - sh) / 2);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 1280, 720);
  return canvas.toBuffer('image/jpeg', { quality: 0.94 });
}

async function downloadThumbBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download YouTube thumbnail: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function buildSafeThumbnail({ video, title, subtitle, speaker, dateStr, fallbackThumbUrl }) {
  const fallbackBuffer = await downloadThumbBuffer(fallbackThumbUrl);
  const style = chooseStyle();
  console.log(`  Selected thumbnail style: ${style.id}`);

  try {
    const framePath = await captureVideoFrame(video.id, getPreachingStartSeconds(video), fallbackThumbUrl);
    const cutoutPath = await makeRembgCutout(framePath);
    console.log(`  Creating final thumbnail with OpenAI ${IMAGE_MODEL}...`);
    const openaiPng = await generateOpenAIFinalThumbnail({ framePath, cutoutPath, title, subtitle, speaker, dateStr, style });
    return await forceYoutubeJpeg16x9(openaiPng);
  } catch (err) {
    console.warn(`  ! Custom OpenAI thumbnail failed. Using normal YouTube thumbnail fallback. ${err.message}`);
    return drawBasicFallbackThumbnailBuffer(fallbackBuffer, subtitle ? `${title} — ${subtitle}` : title, speaker);
  }
}

async function main() {
  console.log('Checking for new Bethel Tabernacle sermons...');
  const playlistId = await getUploadsPlaylistId();
  const videoIds = await getRecentVideoIds(playlistId);
  const videos = await getVideoDetails(videoIds);
  let addedCount = 0;

  for (const video of videos) {
    const id = video.id;
    const status = video.status || {};
    if (status.privacyStatus && status.privacyStatus !== 'public') continue;
    if (EXCLUDE_TITLE_KEYWORDS.some((k) => (video.snippet.title || '').toLowerCase().includes(k))) {
      console.log(`Skipping "${video.snippet.title}" (Sunday School).`);
      continue;
    }
    if (await sermonAlreadyExists(id)) continue;

    const { title, speaker, subtitle } = getDisplayData(video);
    const videoUrl = `https://www.youtube.com/watch?v=${id}`;
    console.log(`New sermon found: "${title}" (${videoUrl})`);
    console.log(`  Speaker: ${speaker}${subtitle ? ` / ${subtitle}` : ''}`);

    const isoDate = (video.liveStreamingDetails && video.liveStreamingDetails.actualStartTime) || video.snippet.publishedAt;
    const dateStr = isoDate.slice(0, 10);
    const year = parseInt(dateStr.slice(0, 4), 10);
    const thumbs = video.snippet.thumbnails || {};
    const sourceThumb = (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default).url;

    console.log('  Building thumbnail...');
    const jpegBuffer = await buildSafeThumbnail({ video, title, subtitle, speaker, dateStr, fallbackThumbUrl: sourceThumb });

    console.log('  Uploading thumbnail to Wix...');
    const fileName = `sermon-${id}.jpg`;
    const uploadedFile = await uploadImageToWix(jpegBuffer, fileName);
    const imgInfo = (uploadedFile.media && uploadedFile.media.image && uploadedFile.media.image.image) || {};
    const thumbnailRef = `wix:image://v1/${uploadedFile.id}/${fileName}#originWidth=${imgInfo.width || 1280}&originHeight=${imgInfo.height || 720}`;

    console.log('  Creating Sermons entry...');
    const inserted = await insertSermon({
      title: subtitle ? `${title} — ${subtitle}` : title,
      speaker,
      date: dateStr,
      year,
      url: videoUrl,
      audio: videoUrl,
      thumbnail: thumbnailRef,
      isRecent: true,
      [MANUAL_SORT_FIELD]: manualSortValue(dateStr),
    });

    await clearOldRecentFlags(inserted.dataItem.id);
    console.log(`  Done — "${title}" is live on the Sermons page.`);
    addedCount++;
  }

  console.log(addedCount === 0 ? 'No new sermons to add this run.' : `Added ${addedCount} new sermon(s).`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
