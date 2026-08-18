/**
 * Process Wix Sermon Screengrab Upload form submissions.
 *
 * Reads the hidden Wix form, uses the submitted preacher screenshot as the
 * real preacher reference, generates a premium Bethel sermon thumbnail, and
 * updates the matching existing Sermons CMS item. It never creates a sermon.
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

for (const [key, value] of Object.entries({ WIX_API_KEY, WIX_SITE_ID, OPENAI_API_KEY })) {
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

// Default random now avoids the warmer/gold look because it was drifting into
// ornate church-flyer territory. warm_tan still works only when explicitly requested.
const STYLES = {
  purple_mountain: {
    label: 'purple mountain',
    colors: ['#171433', '#2d2555', '#6d5aa8', '#f5f1ff'],
    prompt: 'cool purple, indigo, lavender, snowy mountain, soft mist, premium modern Bethel look',
  },
  blue_lake: {
    label: 'blue lake',
    colors: ['#10283f', '#174d74', '#5d91b6', '#eff8ff'],
    prompt: 'cool blue lake, mountain, soft mist, calm and premium, clean modern Bethel look',
  },
  forest_green: {
    label: 'forest green',
    colors: ['#102b29', '#1e5148', '#6f927f', '#effaf5'],
    prompt: 'deep evergreen forest, cool mountain valley, subtle mist, refined clean Bethel look',
  },
  warm_tan: {
    label: 'warm tan',
    colors: ['#3f2d22', '#745739', '#b39166', '#fff1de'],
    prompt: 'warm tan mountain sunset, restrained and clean, no ornate gold flyer style',
  },
};

function chooseStyle() {
  if (STYLE_MODE && STYLE_MODE !== 'random' && STYLES[STYLE_MODE]) {
    return { id: STYLE_MODE, ...STYLES[STYLE_MODE] };
  }
  const defaultKeys = ['purple_mountain', 'blue_lake', 'forest_green'];
  const id = defaultKeys[Math.floor(Math.random() * defaultKeys.length)];
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
  if (!obj || typeof obj !== 'object') return null;
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
  const direct = findFirstStringByKey(obj, /^(url|fileUrl|downloadUrl|src)$/i);
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  const urls = [];
  function walk(value) {
    if (!value) return;
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value) && /(\.png|\.jpe?g|\.webp)(\?|#|$)|static\.wixstatic\.com|static\.parastorage\.com/i.test(value)) urls.push(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === 'object') return Object.values(value).forEach(walk);
  }
  walk(obj);
  return urls[0] || null;
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
      filter: { formId: SCREENGRAB_FORM_ID, namespace: FORMS_NAMESPACE },
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

async function patchSermonThumbnail(dataItemId, thumbnailRef) {
  await wix('/wix-data/v2/bulk/items/patch', 'POST', {
    dataCollectionId: SERMONS_COLLECTION_ID,
    patches: [
      {
        dataItemId,
        fieldModifications: [
          { fieldPath: 'thumbnail', action: 'SET_FIELD', setFieldOptions: { value: thumbnailRef } },
        ],
      },
    ],
  });
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
  try {
    await fs.writeFile(path.join(process.cwd(), fileName), buffer);
  } catch (_) {}
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

async function makeStyleReferenceImage(style) {
  const w = 1536;
  const h = 1024;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  const [c1, c2, c3, c4] = style.colors;
  const grd = ctx.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, c1);
  grd.addColorStop(0.42, c2);
  grd.addColorStop(1, c4);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  // Abstract clean layout guide only. No real words to copy.
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(520, 570); ctx.lineTo(790, 250); ctx.lineTo(1070, 570); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 0.18;
  ctx.beginPath(); ctx.moveTo(720, 570); ctx.lineTo(1000, 330); ctx.lineTo(1260, 570); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 0.16;
  for (let i = 0; i < 8; i++) {
    ctx.beginPath(); ctx.ellipse(160 + i * 185, 670 + Math.sin(i) * 15, 225, 42, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Left frosted panel guide.
  ctx.fillStyle = 'rgba(20, 16, 46, 0.56)';
  roundRect(ctx, 58, 75, 700, 805, 54, true, false);
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 3;
  roundRect(ctx, 58, 75, 700, 805, 54, false, true);

  // Text hierarchy guide as clean white bars, not text.
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  roundRect(ctx, 130, 150, 340, 28, 12, true, false);
  roundRect(ctx, 130, 290, 520, 56, 16, true, false);
  roundRect(ctx, 130, 370, 470, 56, 16, true, false);
  roundRect(ctx, 130, 450, 360, 56, 16, true, false);
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  roundRect(ctx, 280, 605, 260, 46, 20, true, false);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 3;
  roundRect(ctx, 130, 735, 470, 68, 34, false, true);

  const buffer = canvas.toBuffer('image/png');
  await writeArtifact('style-reference.png', buffer);
  const tmp = path.join(os.tmpdir(), `style-reference-${Date.now()}.png`);
  await fs.writeFile(tmp, buffer);
  return tmp;
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

function buildPrompt({ style, display }) {
  return `Create one polished 16:9 YouTube sermon thumbnail for Bethel Tabernacle.

Image 1 is ONLY the layout/style reference: clean cool scenic background, large rounded translucent text panel on the left, preacher area on the right. Do not copy any placeholder shapes as text.
Image 2 is the real preacher screenshot. Use this exact real preacher. Preserve his actual face, expression, hair, glasses if present, clothing, and identity. Do not invent a new person. Do not make a stock headshot.

Style: ${style.label}. ${style.prompt}.

Make the result look like a clean premium church-media thumbnail, close to a professional modern sermon series graphic. Keep it simple and high-end.

Required layout:
- scenic mountain/lake/forest background
- large rounded translucent panel on the LEFT
- real preacher on the RIGHT, chest-up or torso-up, clean edges, natural blending
- big elegant serif sermon title on the left
- small minister name at top-left, without the word Speaker
- subtitle smaller below the title if provided
- BETHEL TABERNACLE in a thin outlined capsule near lower-left

Exact text only:
Minister name: ${display.speaker}
Sermon title: ${display.title}
${display.subtitle ? `Subtitle: ${display.subtitle}` : 'No subtitle.'}
Church label: BETHEL TABERNACLE

Do not add icons. Do not add a temple icon. Do not add decorative flourishes. Do not add heavy gold badges. Do not add extra words. Do not use the word Speaker. Do not make it ornate. Prioritize clean spacing, simple hierarchy, and readability.`;
}

async function generateThumbnail({ screenshotBuffer, display }) {
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
  form.append('prompt', buildPrompt({ style, display }));

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
  return normalizeToJpeg(raw, 'generated-thumbnail.jpg');
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

function wixImageRef(uploadedFile, fileName) {
  const imgInfo = uploadedFile.media?.image?.image || {};
  return `wix:image://v1/${uploadedFile.id}/${fileName}#originWidth=${imgInfo.width || 1280}&originHeight=${imgInfo.height || 720}`;
}

async function processLatestSubmission() {
  console.log('Checking Wix Sermon Screengrab Upload submissions...');
  const submissions = await queryRecentSubmissions();
  console.log(`Found ${submissions.length} recent submissions.`);

  const candidates = submissions.filter((s) => !s.seen);
  if (!candidates.length) {
    console.log('No unseen screengrab submissions to process.');
    return { processed: false, reason: 'NO_UNSEEN_SUBMISSIONS' };
  }

  const submission = candidates[0];
  const youtubeUrl = getYoutubeUrlFromSubmission(submission);
  const videoId = extractVideoId(youtubeUrl);
  const screenGrabUrl = getScreenGrabUrlFromSubmission(submission);

  console.log(`Submission ${submission.id}:`);
  console.log(`  YouTube URL: ${youtubeUrl || 'missing'}`);
  console.log(`  Video ID: ${videoId || 'missing'}`);
  console.log(`  Screen grab URL found: ${screenGrabUrl ? 'yes' : 'no'}`);

  if (!videoId) throw new Error('Could not extract YouTube video ID from form submission.');
  if (!screenGrabUrl) throw new Error('Could not find uploaded screengrab URL in form submission.');

  const sermon = await findSermonByVideoId(videoId);
  if (!sermon) throw new Error(`No existing Wix Sermons item found for video ID ${videoId}.`);
  console.log(`Matched sermon item: ${sermon.id}`);

  const youtubeVideo = await getVideoDetails(videoId).catch((err) => {
    console.warn(`Could not fetch YouTube metadata; using Wix fields only. ${err.message}`);
    return null;
  });
  const display = getDisplayFromSermon(sermon, youtubeVideo);
  console.log(`Title: ${display.title}`);
  console.log(`Speaker: ${display.speaker}`);
  if (display.subtitle) console.log(`Subtitle: ${display.subtitle}`);

  const screenshotBuffer = await downloadBuffer(screenGrabUrl);
  await writeArtifact('process-result.json', Buffer.from(JSON.stringify({
    submissionId: submission.id,
    videoId,
    sermonItemId: sermon.id,
    title: display.title,
    speaker: display.speaker,
    subtitle: display.subtitle,
    dryRun: IS_DRY_RUN,
  }, null, 2)));

  const thumbnailBuffer = await generateThumbnail({ screenshotBuffer, display });

  if (IS_DRY_RUN) {
    console.log('DRY RUN: generated thumbnail but did not update Wix sermon or mark submission seen.');
    return { processed: true, dryRun: true, videoId, sermonItemId: sermon.id };
  }

  const fileName = `sermon-${videoId}-custom.jpg`;
  const uploadedFile = await uploadImageToWix(thumbnailBuffer, fileName);
  const thumbnailRef = wixImageRef(uploadedFile, fileName);
  await patchSermonThumbnail(sermon.id, thumbnailRef);
  await markSubmissionSeen(submission);
  console.log('Updated sermon thumbnail successfully.');

  return { processed: true, dryRun: false, videoId, sermonItemId: sermon.id };
}

processLatestSubmission()
  .then(async (result) => {
    await writeArtifact('process-result.json', Buffer.from(JSON.stringify(result, null, 2)));
  })
  .catch(async (err) => {
    console.error(err);
    await writeArtifact('process-result.json', Buffer.from(JSON.stringify({ error: err.message }, null, 2)));
    process.exit(1);
  });
