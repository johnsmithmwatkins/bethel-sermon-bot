/**
 * Process Wix Sermon Screengrab Upload form submissions.
 *
 * Reads the hidden Wix form, uses the submitted preacher screenshot as the
 * preacher reference, generates a custom sermon thumbnail, and updates the
 * matching existing Sermons CMS item. It never creates a sermon item.
 */

const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { File } = require('buffer');

const {
  WIX_API_KEY,
  WIX_SITE_ID,
  YOUTUBE_API_KEY,
  OPENAI_API_KEY,
  OPENAI_IMAGE_MODEL,
  STYLE_MODE,
  FORM_ID,
  DRY_RUN,
} = process.env;

const REQUIRED = { WIX_API_KEY, WIX_SITE_ID, OPENAI_API_KEY };
for (const [key, value] of Object.entries(REQUIRED)) {
  if (!value) {
    console.error(`Missing required secret: ${key}`);
    process.exit(1);
  }
}

const SERMONS_COLLECTION_ID = 'Sermons';
const SCREENGRAB_FORM_ID = FORM_ID || 'c2d24226-8540-46fb-b7ea-2eb2114bd190';
const FORMS_NAMESPACE = 'wix.form_app.form';
const IMAGE_MODEL = OPENAI_IMAGE_MODEL || 'gpt-image-2';
const IS_DRY_RUN = String(DRY_RUN || '').toLowerCase() === 'true';

registerFont(path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf'), { family: 'Bethel Bold' });
registerFont(path.join(__dirname, 'assets', 'DejaVuSans.ttf'), { family: 'Bethel Regular' });

const STYLES = {
  purple_mountain: {
    label: 'purple mountain',
    colors: '#62547d, #372b5f, lavender blue, soft white',
    prompt: 'soft lavender and blue mountain/lake mood, misty mountains, refined purple translucent panel, elegant premium church thumbnail',
  },
  forest_green: {
    label: 'forest green',
    colors: '#0b526f, #123b35, deep evergreen, misty blue',
    prompt: 'deep forest green and blue mountain mood, tall evergreens, misty valley depth, clean premium sermon thumbnail',
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
  if (STYLE_MODE && STYLE_MODE !== 'random' && STYLES[STYLE_MODE]) return { id: STYLE_MODE, ...STYLES[STYLE_MODE] };
  const id = keys[Math.floor(Math.random() * keys.length)];
  return { id, ...STYLES[id] };
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

async function youtube(pathAndQuery) {
  if (!YOUTUBE_API_KEY) return null;
  const joiner = pathAndQuery.includes('?') ? '&' : '?';
  const url = `https://www.googleapis.com/youtube/v3/${pathAndQuery}${joiner}key=${YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractVideoId(input) {
  if (!input) return null;
  const text = String(input).trim();
  let m = text.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  m = text.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  m = text.match(/youtube\.com\/(?:live|shorts|embed)\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  m = text.match(/^[A-Za-z0-9_-]{6,}$/);
  return m ? text : null;
}

function findFirstStringByKey(obj, keyRegex) {
  if (!obj) return null;
  if (typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstStringByKey(item, keyRegex);
      if (found) return found;
    }
    return null;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (keyRegex.test(key) && typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const value of Object.values(obj)) {
    const found = findFirstStringByKey(value, keyRegex);
    if (found) return found;
  }
  return null;
}

function findLikelyImageUrl(obj) {
  const url = findFirstStringByKey(obj, /^(url|fileUrl|downloadUrl|src)$/i);
  if (url && /^https?:\/\//i.test(url)) return url;
  const all = [];
  function walk(v) {
    if (!v) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v) && /\.(png|jpe?g|webp)(\?|#|$)|static\.wixstatic\.com|static\.parastorage\.com/i.test(v)) all.push(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') Object.values(v).forEach(walk);
  }
  walk(obj);
  return all[0] || null;
}

function submissionFields(submission) {
  return submission.submissions || submission.data || submission.values || {};
}

function getYoutubeUrlFromSubmission(submission) {
  const fields = submissionFields(submission);
  return fields.youtubeUrl || fields.youtube_url || fields.url || findFirstStringByKey(fields, /youtube|url/i);
}

function getScreenGrabUrlFromSubmission(submission) {
  const fields = submissionFields(submission);
  return findLikelyImageUrl(fields.screenGrab || fields.screengrab || fields.file || fields.upload || fields) || findLikelyImageUrl(submission);
}

async function queryRecentSubmissions() {
  const data = await wix('/form-submission-service/v4/submissions/namespace/query', 'POST', {
    query: {
      filter: {
        formId: SCREENGRAB_FORM_ID,
        namespace: FORMS_NAMESPACE,
      },
      sort: [{ fieldName: 'createdDate', order: 'DESC' }],
      paging: { limit: 10 },
    },
  });
  return data.submissions || [];
}

async function markSubmissionSeen(submission) {
  if (!submission.id || !submission.revision) return;
  await wix(`/form-submission-service/v4/submissions/${submission.id}`, 'PATCH', {
    submission: {
      id: submission.id,
      formId: submission.formId || SCREENGRAB_FORM_ID,
      namespace: submission.namespace || FORMS_NAMESPACE,
      revision: submission.revision,
      seen: true,
    },
  });
}

async function findSermonByVideoId(videoId) {
  const result = await wix('/wix-data/v2/items/query', 'POST', {
    dataCollectionId: SERMONS_COLLECTION_ID,
    query: { filter: { url: { $contains: videoId } }, paging: { limit: 1 } },
  });
  return (result.dataItems || [])[0] || null;
}

async function getVideoDetails(videoId) {
  if (!YOUTUBE_API_KEY) return null;
  const data = await youtube(`videos?part=snippet&id=${encodeURIComponent(videoId)}`);
  return (data.items || [])[0] || null;
}

function splitTitleParts(title) {
  const text = String(title || 'Sermon').trim();
  const parts = text.split(/\s+[—–-]\s+/);
  if (parts.length >= 2 && /^part\b/i.test(parts[parts.length - 1])) {
    return { title: parts.slice(0, -1).join(' — '), subtitle: parts[parts.length - 1] };
  }
  const match = text.match(/^(.*?)[\s:—–-]+(Part\s+(?:\d+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten))$/i);
  if (match) return { title: match[1].trim(), subtitle: match[2].trim() };
  return { title: text, subtitle: '' };
}

function getDisplayFromSermon(sermonItem, youtubeVideo) {
  const data = sermonItem.data || {};
  const fromTitle = splitTitleParts(data.title || youtubeVideo?.snippet?.title || 'Sermon');
  return {
    title: fromTitle.title,
    subtitle: data.subtitle || fromTitle.subtitle || '',
    speaker: data.speaker || data.preacher || data.minister || 'Bethel Tabernacle',
  };
}

async function downloadBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download image: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function writeArtifact(fileName, buffer) {
  try { await fs.writeFile(path.join(process.cwd(), fileName), buffer); } catch (_) {}
}

async function makeStyleReferenceImage(style) {
  const w = 1536, h = 1024;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, '#201a36');
  grd.addColorStop(0.45, '#62547d');
  grd.addColorStop(1, '#f0d7ce');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 9; i++) {
    ctx.beginPath();
    ctx.ellipse(200 + i * 170, 620 + Math.sin(i) * 50, 220, 60, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(20, 13, 50, 0.55)';
  roundRect(ctx, 70, 110, 650, 610, 48, true, false);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 4;
  roundRect(ctx, 70, 110, 650, 610, 48, false, true);
  ctx.font = '64px Bethel Bold';
  ctx.fillStyle = '#fff';
  ctx.fillText('Style Reference', 120, 220);
  ctx.font = '34px Bethel Regular';
  ctx.fillText(style.label, 120, 285);
  const buffer = canvas.toBuffer('image/png');
  await writeArtifact('style-reference.png', buffer);
  const tmp = path.join(os.tmpdir(), `style-${Date.now()}.png`);
  await fs.writeFile(tmp, buffer);
  return tmp;
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

async function normalizeToJpeg(buffer, outName) {
  const img = await loadImage(buffer);
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext('2d');
  const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
  const sw = img.width * scale;
  const sh = img.height * scale;
  ctx.drawImage(img, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh);
  const jpg = canvas.toBuffer('image/jpeg', { quality: 0.94 });
  await writeArtifact(outName, jpg);
  return jpg;
}

async function generateThumbnail({ sermon, videoId, screenshotBuffer, display }) {
  const style = chooseStyle();
  console.log(`Using style: ${style.id}`);
  const stylePath = await makeStyleReferenceImage(style);
  const screenshotJpg = await normalizeToJpeg(screenshotBuffer, 'submitted-screengrab.jpg');

  const form = new FormData();
  form.append('model', IMAGE_MODEL);
  form.append('size', '1536x1024');
  form.append('quality', 'high');
  form.append('image[]', new File([await fs.readFile(stylePath)], 'style-reference.png', { type: 'image/png' }));
  form.append('image[]', new File([screenshotJpg], 'preacher-reference.jpg', { type: 'image/jpeg' }));
  form.append('prompt', `Create a polished 16:9 YouTube sermon thumbnail for Bethel Tabernacle.

Use Image 1 as the scenic style/layout reference. Use Image 2 as the real preacher reference. The preacher in the final thumbnail must be the same real person from Image 2. Do not invent a new person, do not use a stock headshot, and do not change the preacher's face identity.

Design direction: ${style.prompt}. Put the preacher large on the right side, chest/torso-up, cleanly separated from the background. Remove distracting pulpit, microphone, tablet, walls, or livestream clutter. Use a scenic mountain/lake/forest background and an elegant translucent text panel on the left.

Render exact text:
Speaker: ${display.speaker}
Title: ${display.title}
${display.subtitle ? `Subtitle: ${display.subtitle}` : 'No subtitle.'}
Bottom label: BETHEL TABERNACLE

Use elegant serif-style title typography, premium church thumbnail composition, clean spacing, and no extra words.`);

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI image edit failed ${res.status}: ${JSON.stringify(json)}`);
  const b64 = json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw new Error(`OpenAI did not return b64_json: ${JSON.stringify(json)}`);

  const raw = Buffer.from(b64, 'base64');
  const finalJpg = await normalizeToJpeg(raw, 'generated-thumbnail.jpg');
  return finalJpg;
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

async function updateSermonThumbnail(sermonItem, videoId, jpegBuffer) {
  const fileName = `sermon-${videoId}-custom.jpg`;
  const uploadedFile = await uploadImageToWix(jpegBuffer, fileName);
  const imgInfo = (uploadedFile.media && uploadedFile.media.image && uploadedFile.media.image.image) || {};
  const thumbnailRef = `wix:image://v1/${uploadedFile.id}/${fileName}#originWidth=${imgInfo.width || 1280}&originHeight=${imgInfo.height || 720}`;

  if (IS_DRY_RUN) {
    console.log(`[DRY RUN] Would update sermon item ${sermonItem.id} thumbnail to ${thumbnailRef}`);
    return thumbnailRef;
  }

  await wix('/wix-data/v2/bulk/items/patch', 'POST', {
    dataCollectionId: SERMONS_COLLECTION_ID,
    patches: [{
      dataItemId: sermonItem.id,
      fieldModifications: [{ fieldPath: 'thumbnail', action: 'SET_FIELD', setFieldOptions: { value: thumbnailRef } }],
    }],
  });
  return thumbnailRef;
}

async function processSubmission(submission) {
  if (submission.seen === true) {
    console.log(`Skipping seen submission ${submission.id}`);
    return { skipped: true, reason: 'seen', id: submission.id };
  }

  const youtubeUrl = getYoutubeUrlFromSubmission(submission);
  const videoId = extractVideoId(youtubeUrl);
  const screenGrabUrl = getScreenGrabUrlFromSubmission(submission);

  console.log(`Submission ${submission.id || '(no id)'}:`);
  console.log(`  YouTube URL: ${youtubeUrl || '(missing)'}`);
  console.log(`  Video ID: ${videoId || '(missing)'}`);
  console.log(`  Screen grab URL found: ${screenGrabUrl ? 'yes' : 'no'}`);

  if (!videoId) throw new Error('Submission does not include a usable YouTube URL/video ID.');
  if (!screenGrabUrl) throw new Error('Submission does not include a usable screen grab URL.');

  const sermon = await findSermonByVideoId(videoId);
  if (!sermon) throw new Error(`No existing Wix sermon item found with URL containing video ID ${videoId}. Not creating a duplicate.`);

  const youtubeVideo = await getVideoDetails(videoId).catch((err) => {
    console.warn(`  Could not fetch YouTube details; using Wix sermon fields. ${err.message}`);
    return null;
  });
  const display = getDisplayFromSermon(sermon, youtubeVideo);
  console.log(`  Matched sermon item: ${sermon.id}`);
  console.log(`  Title: ${display.title}`);
  console.log(`  Speaker: ${display.speaker}`);
  if (display.subtitle) console.log(`  Subtitle: ${display.subtitle}`);

  const screenshotBuffer = await downloadBuffer(screenGrabUrl);
  const jpegBuffer = await generateThumbnail({ sermon, videoId, screenshotBuffer, display });
  const thumbnailRef = await updateSermonThumbnail(sermon, videoId, jpegBuffer);

  await fs.writeFile('process-result.json', JSON.stringify({
    processedAt: new Date().toISOString(),
    submissionId: submission.id,
    videoId,
    sermonItemId: sermon.id,
    thumbnailRef,
    dryRun: IS_DRY_RUN,
  }, null, 2));

  if (!IS_DRY_RUN) await markSubmissionSeen(submission);
  console.log(`  Updated sermon thumbnail successfully.`);
  return { processed: true, id: submission.id, videoId, sermonItemId: sermon.id };
}

async function main() {
  console.log('Checking Wix Sermon Screengrab Upload submissions...');
  const submissions = await queryRecentSubmissions();
  console.log(`Found ${submissions.length} recent submissions.`);

  let processed = 0;
  const errors = [];
  for (const submission of submissions) {
    try {
      const result = await processSubmission(submission);
      if (result.processed) {
        processed += 1;
        // Process one at a time so a test run only updates one sermon.
        break;
      }
    } catch (err) {
      console.error(`Submission failed: ${err.message}`);
      errors.push(err.message);
    }
  }

  if (!processed && errors.length) {
    throw new Error(`No screengrab submissions processed. Errors: ${errors.join(' | ')}`);
  }
  if (!processed) console.log('No new/unseen screengrab submissions to process.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
