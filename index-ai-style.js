/**
 * Bethel Tabernacle — AI-style sermon thumbnail uploader
 * -------------------------------------------------------
 * This version keeps the existing YouTube -> Wix automation, but builds a
 * more designed thumbnail from an actual sermon frame instead of only using
 * YouTube's default thumbnail.
 *
 * It does NOT log in to ChatGPT. It runs safely inside GitHub Actions.
 *
 * Recommended YouTube description lines:
 *   Speaker: Jason Watkins
 *   Sermon Title: From Earth to the Open Door
 *   Subtitle: Part Two
 *   Preaching Starts: 42:15
 */

const { createCanvas, loadImage, registerFont } = require('canvas');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID, WIX_API_KEY, WIX_SITE_ID } = process.env;

for (const [key, value] of Object.entries({ YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID, WIX_API_KEY, WIX_SITE_ID })) {
  if (!value) {
    console.error(`Missing required secret: ${key}. Add it under Settings > Secrets and variables > Actions.`);
    process.exit(1);
  }
}

const COLLECTION_ID = 'Sermons';
const MANUAL_SORT_FIELD = '_manualSort_9510f576-af2a-4ca5-93c3-008a3d8b80bb';
const EXCLUDE_TITLE_KEYWORDS = ['sunday school'];
const MAX_VIDEOS_TO_CHECK = 15;

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
  return title
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

function getDisplayData(video) {
  const description = video.snippet.description || '';
  const rawTitle = lineValue(description, ['Sermon Title', 'Title']) || stripVideoTitle(video.snippet.title || 'Sermon');
  const speaker = lineValue(description, ['Speaker', 'Preacher', 'Minister']) || 'Bethel Tabernacle';
  let subtitle = lineValue(description, ['Subtitle', 'Sub Title', 'Part']);

  const partInTitle = rawTitle.match(/\b(Part\s+(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+))\b/i);
  let title = rawTitle;
  if (!subtitle && partInTitle) {
    subtitle = partInTitle[1].replace(/\b\d+\b/, (n) => ({ 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' }[n] || n));
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

  // Fallback: if no timestamp is supplied, grab a frame from roughly the middle
  // of the sermon, but not too far in.
  const duration = parseDurationSeconds(video.contentDetails && video.contentDetails.duration);
  if (duration && duration > 0) return Math.min(Math.max(Math.round(duration * 0.42), 1800), 3900);
  return 2700;
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
    console.warn(`  ! Could not capture video frame, using YouTube thumbnail instead. ${err.message}`);
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

function drawNatureBackground(ctx, palette, title) {
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

  // Snowy mountain silhouettes
  const mountainSets = [
    { y: 330, color: 'rgba(255,255,255,0.22)', peaks: [80, 250, 420, 610, 800, 1030, 1240] },
    { y: 390, color: 'rgba(0,0,0,0.35)', peaks: [0, 180, 350, 560, 740, 930, 1160, 1280] },
  ];
  for (const set of mountainSets) {
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

  // Lake/forest dark base
  const lake = ctx.createLinearGradient(0, 455, 0, h);
  lake.addColorStop(0, 'rgba(20, 70, 95, 0.35)');
  lake.addColorStop(1, 'rgba(2, 8, 18, 0.78)');
  ctx.fillStyle = lake;
  ctx.fillRect(0, 455, w, 300);

  // Dark vignette for readable title
  const vg = ctx.createRadialGradient(820, 325, 160, 620, 370, 820);
  vg.addColorStop(0, 'rgba(0,0,0,0.05)');
  vg.addColorStop(1, 'rgba(0,0,0,0.62)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 46, w, 628);
  ctx.restore();
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

async function buildDesignedThumbnail({ video, title, subtitle, speaker, fallbackThumbUrl }) {
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext('2d');
  const palette = paletteFor(title);
  drawNatureBackground(ctx, palette, title);

  const framePath = await captureVideoFrame(video.id, getPreachingStartSeconds(video), fallbackThumbUrl);
  const frame = await loadImage(framePath);

  // Right-side preacher panel. This is intentionally a stylized crop of the
  // actual sermon frame, so the thumbnail uses the real preacher moment.
  const px = 735;
  const py = 65;
  const pw = 520;
  const ph = 640;
  ctx.save();
  roundRect(ctx, px, py, pw, ph, 24);
  ctx.clip();
  drawCoverImage(ctx, frame, px, py, pw, ph, 0.55, 0.42);
  ctx.fillStyle = 'rgba(7, 14, 24, 0.08)';
  ctx.fillRect(px, py, pw, ph);
  ctx.restore();

  // Soft blend where preacher meets background
  const sideBlend = ctx.createLinearGradient(690, 0, 820, 0);
  sideBlend.addColorStop(0, 'rgba(8, 13, 28, 0.9)');
  sideBlend.addColorStop(1, 'rgba(8, 13, 28, 0)');
  ctx.fillStyle = sideBlend;
  ctx.fillRect(670, 46, 190, 628);

  // Speaker name
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = '30px "Bethel Regular"';
  ctx.fillText(titleCaseName(speaker), 126, 140);

  // Main title
  let fontSize = title.length > 34 ? 76 : 88;
  let lines;
  do {
    ctx.font = `${fontSize}px "Bethel Regular"`;
    lines = wrapText(ctx, title, 610);
    if (lines.length > 4) fontSize -= 4;
  } while (lines.length > 4 && fontSize > 46);

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  let y = subtitle ? 285 : 315;
  const gap = fontSize * 0.98;
  for (const line of lines) {
    ctx.fillText(line, 126, y);
    y += gap;
  }

  // Optional subtitle/part line
  if (subtitle) {
    const subText = subtitle.replace(/\bpart\b/i, 'Part');
    const sx = 126;
    const sy = Math.min(575, y + 15);
    ctx.save();
    ctx.shadowColor = palette.accent;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 2;
    roundRect(ctx, sx, sy - 48, 360, 64, 10);
    ctx.stroke();
    ctx.restore();
    ctx.font = '44px "Bethel Bold"';
    ctx.fillStyle = palette.accent;
    ctx.fillText(subText.toUpperCase(), sx + 28, sy);
  }

  // Church tag
  const tagX = 126;
  const tagY = 615;
  const tagW = 430;
  const tagH = 58;
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
  console.log('Checking for new Bethel Tabernacle sermons with designed thumbnail builder...');
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

    console.log('  Building designed thumbnail...');
    const jpegBuffer = await buildDesignedThumbnail({ video, title, subtitle, speaker, fallbackThumbUrl: sourceThumb });

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
