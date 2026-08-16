/**
 * Bethel Tabernacle — Automatic Sermon Uploader
 * ------------------------------------------------
 * Runs on a schedule (see .github/workflows/check-sermons.yml).
 * Each run:
 *   1. Checks the YouTube channel's recent uploads.
 *   2. Skips anything already on the site, anything with "Sunday School"
 *      in the title, and anything not public.
 *   3. For each genuinely new sermon: builds a thumbnail (real YouTube
 *      video frame + a title/speaker banner), uploads it to Wix, creates
 *      the Sermons entry, and marks it as the most recent sermon.
 *
 * See README.md for one-time setup instructions.
 */

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');

// ---------------------------------------------------------------------
// Config — these come from GitHub Actions secrets (see README.md)
// ---------------------------------------------------------------------
const { YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID, WIX_API_KEY, WIX_SITE_ID } = process.env;

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
// This is the hidden field Wix uses to order sermons on the site (newest first).
// It must stay in sync with the value used for the June-August 2026 backfill.
const MANUAL_SORT_FIELD = '_manualSort_9510f576-af2a-4ca5-93c3-008a3d8b80bb';
const EXCLUDE_TITLE_KEYWORDS = ['sunday school'];
const MAX_VIDEOS_TO_CHECK = 15; // how many of the most recent uploads to look at each run

registerFont(path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf'), { family: 'Bethel Bold' });
registerFont(path.join(__dirname, 'assets', 'DejaVuSans.ttf'), { family: 'Bethel Regular' });

// ---------------------------------------------------------------------
// YouTube helpers
// ---------------------------------------------------------------------

async function youtube(pathAndQuery) {
  const url = `https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function getUploadsPlaylistId() {
  const data = await youtube(`channels?part=contentDetails&id=${YOUTUBE_CHANNEL_ID}`);
  const item = data.items && data.items[0];
  if (!item) {
    throw new Error('Could not find the YouTube channel — double check YOUTUBE_CHANNEL_ID.');
  }
  return item.contentDetails.relatedPlaylists.uploads;
}

async function getRecentVideoIds(playlistId) {
  const data = await youtube(
    `playlistItems?part=contentDetails&playlistId=${playlistId}&maxResults=${MAX_VIDEOS_TO_CHECK}`
  );
  const ids = (data.items || []).map((i) => i.contentDetails.videoId);
  return ids.reverse(); // process oldest -> newest so "most recent" ends up correct
}

async function getVideoDetails(videoIds) {
  if (videoIds.length === 0) return [];
  const data = await youtube(`videos?part=snippet,liveStreamingDetails,status&id=${videoIds.join(',')}`);
  return data.items || [];
}

// ---------------------------------------------------------------------
// Wix helpers
// ---------------------------------------------------------------------

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
  if (!res.ok) {
    throw new Error(`Wix API error ${res.status} on ${pathname}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function sermonAlreadyExists(videoId) {
  // Match by video ID (a substring of the stored url), not the full url string.
  // Some older sermons were saved as youtube.com/live/ID, others as
  // youtube.com/watch?v=ID — an exact-string match would miss those and
  // create duplicates, so this checks whether the ID appears anywhere in
  // the stored url instead.
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
  const gen = await wix('/site-media/v1/files/generate-upload-url', 'POST', {
    mimeType: 'image/jpeg',
    fileName,
  });
  const uploadRes = await fetch(`${gen.uploadUrl}?filename=${encodeURIComponent(fileName)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: buffer,
  });
  const uploadJson = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) {
    throw new Error(`Wix media upload failed: ${JSON.stringify(uploadJson)}`);
  }
  return uploadJson.file;
}

async function insertSermon(data) {
  return wix('/wix-data/v2/items', 'POST', {
    dataCollectionId: COLLECTION_ID,
    dataItem: { data },
  });
}

async function clearOldRecentFlags(excludeId) {
  const ids = (await getCurrentRecentItemIds()).filter((id) => id !== excludeId);
  if (ids.length === 0) return;
  await wix('/wix-data/v2/bulk/items/patch', 'POST', {
    dataCollectionId: COLLECTION_ID,
    patches: ids.map((id) => ({
      dataItemId: id,
      fieldModifications: [
        { fieldPath: 'isRecent', action: 'SET_FIELD', setFieldOptions: { value: false } },
      ],
    })),
  });
}

// The site orders sermons using MANUAL_SORT_FIELD, not the "date" field.
// This produces a value that always sorts a more recent date ahead of an
// older one, and ahead of every value used before August 2026.
function manualSortValue(dateStr) {
  const inverse = 99999999 - parseInt(dateStr.replace(/-/g, ''), 10);
  return `0${String(inverse).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------
// Thumbnail compositing
// ---------------------------------------------------------------------

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
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

async function buildThumbnail(sourceUrl, title, speaker) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Could not download the YouTube thumbnail: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const img = await loadImage(Buffer.from(arrayBuffer));

  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, img.width, img.height);

  // Dark gradient banner across the bottom third
  const bandHeight = Math.round(img.height * 0.32);
  const bandY = img.height - bandHeight;
  const gradient = ctx.createLinearGradient(0, bandY, 0, img.height);
  gradient.addColorStop(0, 'rgba(8, 16, 33, 0)');
  gradient.addColorStop(0.4, 'rgba(8, 16, 33, 0.88)');
  gradient.addColorStop(1, 'rgba(8, 16, 33, 0.94)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, bandY, img.width, bandHeight);

  const paddingX = Math.round(img.width * 0.045);

  // Title (auto-shrinks to fit, max 2 lines)
  let titleSize = Math.round(img.height * 0.078);
  ctx.font = `${titleSize}px "Bethel Bold"`;
  let titleLines = wrapText(ctx, title.toUpperCase(), img.width - paddingX * 2);
  while (titleLines.length > 2 && titleSize > 26) {
    titleSize -= 2;
    ctx.font = `${titleSize}px "Bethel Bold"`;
    titleLines = wrapText(ctx, title.toUpperCase(), img.width - paddingX * 2);
  }
  titleLines = titleLines.slice(0, 2);

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  const lineGap = titleSize * 1.15;
  let textY = img.height - Math.round(img.height * 0.105) - (titleLines.length - 1) * lineGap;
  for (const line of titleLines) {
    ctx.fillText(line, paddingX, textY);
    textY += lineGap;
  }

  // Speaker line
  const speakerSize = Math.round(img.height * 0.042);
  ctx.font = `${speakerSize}px "Bethel Regular"`;
  ctx.fillStyle = '#d7dee8';
  ctx.fillText(speaker.toUpperCase(), paddingX, img.height - Math.round(img.height * 0.035));

  // Small church tag, top-left
  ctx.font = `${Math.round(img.height * 0.045)}px "Bethel Bold"`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText('BETHEL TABERNACLE', paddingX, Math.round(img.height * 0.09));

  return canvas.toBuffer('image/jpeg', { quality: 0.9 });
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  console.log('Checking for new Bethel Tabernacle sermons...');
  const playlistId = await getUploadsPlaylistId();
  const videoIds = await getRecentVideoIds(playlistId);
  const videos = await getVideoDetails(videoIds);

  let addedCount = 0;

  for (const video of videos) {
    const id = video.id;
    const title = video.snippet.title;
    const status = video.status || {};

    if (status.privacyStatus && status.privacyStatus !== 'public') {
      continue; // private/unlisted — matches the standing rule to skip these
    }
    if (EXCLUDE_TITLE_KEYWORDS.some((k) => title.toLowerCase().includes(k))) {
      console.log(`Skipping "${title}" (Sunday School).`);
      continue;
    }

    const videoUrl = `https://www.youtube.com/watch?v=${id}`;
   if (await sermonAlreadyExists(id)) {
      continue; // already on the site
    }

    console.log(`New sermon found: "${title}" (${videoUrl})`);

    const description = video.snippet.description || '';
    const speakerMatch = description.match(/speaker:\s*(.+)/i);
    let speaker;
    if (speakerMatch) {
      speaker = speakerMatch[1].trim().split('\n')[0].trim();
    } else {
      speaker = 'Bethel Tabernacle';
      console.warn(
        '  ! No "Speaker: Name" line found in the video description — used "Bethel Tabernacle" ' +
          'as a placeholder. Edit the speaker field on the site if you want to correct it.'
      );
    }

    const isoDate = (video.liveStreamingDetails && video.liveStreamingDetails.actualStartTime) || video.snippet.publishedAt;
    const dateStr = isoDate.slice(0, 10); // YYYY-MM-DD
    const year = parseInt(dateStr.slice(0, 4), 10);

    const thumbs = video.snippet.thumbnails || {};
    const sourceThumb = (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default).url;

    console.log('  Building thumbnail...');
    const jpegBuffer = await buildThumbnail(sourceThumb, title, speaker);

    console.log('  Uploading thumbnail to Wix...');
    const fileName = `sermon-${id}.jpg`;
    const uploadedFile = await uploadImageToWix(jpegBuffer, fileName);
    const imgInfo = (uploadedFile.media && uploadedFile.media.image && uploadedFile.media.image.image) || {};
    const thumbnailRef = `wix:image://v1/${uploadedFile.id}/${fileName}#originWidth=${imgInfo.width || 1280}&originHeight=${imgInfo.height || 720}`;

    console.log('  Creating Sermons entry...');
    const inserted = await insertSermon({
      title,
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

  if (addedCount === 0) {
    console.log('No new sermons to add this run.');
  } else {
    console.log(`Added ${addedCount} new sermon(s).`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
