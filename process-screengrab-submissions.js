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
    label: 'Purple Mountain',
    colors: '#2c2354, #5a4a84, #8e79c7, #f5f0ff',
    prompt: 'cool purple, lavender, and indigo alpine mountain atmosphere with a misty lake or snowy peak, elegant and calm',
  },
  blue_lake: {
    label: 'Blue Lake',
    colors: '#143a5a, #245d81, #7fb8d6, #eef8ff',
    prompt: 'cool blue lake and mountain atmosphere, calm water, misty valley, crisp clean premium look',
  },
  forest_green: {
    label: 'Forest Green',
    colors: '#102f2a, #1f5a49, #6f9d83, #f2fff7',
    prompt: 'deep evergreen forest and mountain atmosphere, peaceful mist, natural and grounded, refined church media look',
  },
  warm_tan: {
    label: 'Warm Tan',
    colors: '#5b3e24, #9b7145, #d5b179, #fff3df',
    prompt: 'warm tan, gold, and soft amber mountain sunset atmosphere, autumn trees, rich but restrained premium look',
  },
};

const THUMBNAIL_STYLE_GUIDE = `
TARGET LOOK:
Clean, elegant, premium YouTube sermon thumbnail. It should feel like a professionally art-directed church-media thumbnail, not an AI church flyer.

NON-NEGOTIABLES:
- Use the uploaded preacher screenshot as the real preacher reference.
- Preserve the preacher's real face, real expression, real clothing, and identity.
- Do not invent, beautify, replace, or restyle the preacher into a different person.
- No extra people.
- No cartoon look.
- No fake studio portrait.

COMPOSITION:
- 16:9 YouTube thumbnail.
- Text on the left, preacher on the right.
- Preacher should be chest-up or torso-up, large but not cramped.
- Preacher should look naturally composited with clean edges and subtle blending.
- Remove or hide distracting pulpit, iPad, microphone stand, walls, stage clutter, podium edges, or livestream clutter when possible.
- Use a large rounded translucent frosted-glass panel behind the left text area.
- The panel should occupy roughly the left 55 to 60 percent, with generous breathing room.
- Use a thin subtle border on the panel.

TYPOGRAPHY:
- Use refined, elegant, high-contrast serif-style title typography.
- Make the sermon title large, clean, and highly readable at small YouTube size.
- Break title lines naturally. Do not cram words.
- Minister name should be small, subtle, and clean near the top-left. Do NOT add the word "Speaker:".
- Subtitle should be smaller, elegant, and may be italic. It should support the title, not overpower it.
- Church name must appear as BETHEL TABERNACLE in a thin outlined capsule/button near the bottom-left.
- Do not use a heavy filled badge, temple icon, church icon, decorative emblem, or bulky branding block.

BACKGROUND:
- Scenic nature background only: mountains, lake, pine forest, misty valley, sunrise/sunset, soft clouds.
- Beautiful, peaceful, cinematic, premium, not cluttered.
- Background should support readability and not compete with the preacher or title.

AVOID:
- No decorative flourishes, ornaments, icons, temple symbols, heavy dividers, or over-designed poster elements.
- No dense church flyer look.
- No extra text beyond the provided minister name, title, subtitle if any, and BETHEL TABERNACLE.
- No misspelled or invented words.
`;

function chooseStyle() {
  const keys = Object.keys(STYLES);
  if (STYLE_MODE && STYLE_MODE !== 'random' && STYLES[STYLE_MODE]) {
    return { id: STYLE_MODE, ...STYLES[STYLE_MODE] };
  }
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
  function walk(v) {
    if (!v) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v) && /(\.png|\.jpe?g|\.webp)(\?|#|$)|static\.wixstatic\.com|static\.parastorage\.com/i.test(v)) urls.push(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') Object.values(v).forEach(walk);
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

async function patchSermonThumbnail(dataItemId, thumbnailRef) {
  await wix('/wix-data/v2/bulk/items/patch', 'POST', {
    dataCollectionId: SERMONS_COLLECTION_ID,
    patches: [
      {
        dataItemId,
        fieldModifications: [
          {
            fieldPath: 'thumbnail',
            action: 'SET_FIELD',
            setFieldOptions: { value: thumbnailRef },
          },
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

  const grd = ctx.createLinearGradient(0, 0, w, h);
  const palette = style.colors.split(',').map(s => s.trim());
  grd.addColorStop(0, palette[0] || '#221d45');
  grd.addColorStop(0.45, palette[1] || '#514178');
  grd.addColorStop(1, palette[3] || '#f6f1ff');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  // Simple scenic guide shapes: mountains + mist + lake.
  ctx.globalAlpha = 0.48;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(520, 560);
  ctx.lineTo(790, 250);
  ctx.lineTo(1060, 560);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.moveTo(740, 560);
  ctx.lineTo(980, 330);
  ctx.lineTo(1250, 560);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.ellipse(180 + i * 180, 660 + Math.sin(i) * 18, 210, 45, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Clean left design panel reference.
  ctx.fillStyle = 'rgba(20, 16, 46, 0.54)';
  roundRect(ctx, 70, 95, 670, 740, 54, true, false);
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 3;
  roundRect(ctx, 70, 95, 670, 740, 54, false, true);

  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.font = '46px Bethel Regular';
  ctx.fillText('MINISTER NAME', 130, 190);
  ctx.font = '84px Bethel Bold';
  ctx.fillText('Large Elegant', 130, 330);
  ctx.fillText('Sermon Title', 130, 435);
  ctx.font = '48px Bethel Regular';
  ctx.fillText('Part Two', 130, 540);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 3;
  roundRect(ctx, 130, 665, 430, 72, 34, false, true);
  ctx.font = '34px Bethel Regular';
  ctx.fillText('BETHEL TABERNACLE', 165, 712);

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

function buildThumbnailPrompt(style, display) {
  const subtitleLine = display.subtitle ? `Subtitle text: ${display.subtitle}` : 'No subtitle text. Do not invent a part label.';
  return `Create one professional 16:9 YouTube sermon thumbnail for Bethel Tabernacle.

Use Image 1 as the style and layout guide. Use Image 2 as the real preacher reference.

${THUMBNAIL_STYLE_GUIDE}

SELECTED STYLE:
${style.label}: ${style.prompt}. Palette: ${style.colors}.

TEXT TO RENDER EXACTLY:
Minister name text: ${display.speaker}
Sermon title text: ${display.title}
${subtitleLine}
Church label text: BETHEL TABERNACLE

IMPORTANT TEXT RULES:
- Do not write "Speaker:" anywhere.
- Do not add a temple icon or church icon.
- Do not add decorative symbols or extra divider ornaments.
- Only use these text elements: minister name, sermon title, subtitle if provided, and BETHEL TABERNACLE.

Design it closer to a clean premium modern thumbnail: open spacing, large elegant title, subtle rounded translucent panel, right-side real preacher cutout, thin outlined church capsule.`;
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
  form.append('image[]', new File([screenshotJpg], 'real-preacher-reference.jpg', { type: 'image/jpeg' }));
  form.append('prompt', buildThumbnailPrompt(style, display));

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
  const imgInfo = uploadedFile?.media?.image?.image || uploadedFile?.media?.image || {};
  const width = imgInfo.width || 1280;
  const height = imgInfo.height || 720;
  return `wix:image://v1/${uploadedFile.id}/${fileName}#originWidth=${width}&originHeight=${height}`;
}

async function main() {
  console.log('Checking Wix Sermon Screengrab Upload submissions...');
  if (IS_DRY_RUN) console.log('DRY RUN: generated thumbnail only; Wix sermon thumbnail will not be updated.');

  const submissions = await queryRecentSubmissions();
  console.log(`Found ${submissions.length} recent submissions.`);

  const unseen = submissions.filter(s => !s.seen);
  if (!unseen.length) {
    console.log('No unseen screengrab submissions to process.');
    return;
  }

  const submission = unseen[0];
  const youtubeUrl = getYoutubeUrlFromSubmission(submission);
  const videoId = extractVideoId(youtubeUrl);
  const screenGrabUrl = getScreenGrabUrlFromSubmission(submission);

  console.log(`Submission ${submission.id}:`);
  console.log(`  YouTube URL: ${youtubeUrl || 'missing'}`);
  console.log(`  Video ID: ${videoId || 'missing'}`);
  console.log(`  Screen grab URL found: ${screenGrabUrl ? 'yes' : 'no'}`);

  if (!videoId) throw new Error('Could not extract a YouTube video ID from the form submission.');
  if (!screenGrabUrl) throw new Error('Could not find uploaded screen grab URL in the form submission.');

  const sermon = await findSermonByVideoId(videoId);
  if (!sermon) throw new Error(`No existing Wix sermon item found containing video ID ${videoId}. Refusing to create a duplicate.`);
  console.log(`Matched sermon item: ${sermon.id}`);

  const youtubeVideo = await getVideoDetails(videoId).catch(err => {
    console.warn(`Could not fetch YouTube details, using Wix sermon fields only: ${err.message}`);
    return null;
  });
  const display = getDisplayFromSermon(sermon, youtubeVideo);
  console.log(`Title: ${display.title}`);
  console.log(`Speaker: ${display.speaker}`);
  console.log(`Subtitle: ${display.subtitle || '(none)'}`);

  const screenshotBuffer = await downloadBuffer(screenGrabUrl);
  await writeArtifact('original-submitted-screengrab.jpg', screenshotBuffer);

  const thumbnailBuffer = await generateThumbnail({ screenshotBuffer, display });

  const info = {
    submissionId: submission.id,
    videoId,
    sermonItemId: sermon.id,
    title: display.title,
    speaker: display.speaker,
    subtitle: display.subtitle || '',
    dryRun: IS_DRY_RUN,
    processedAt: new Date().toISOString(),
    promptStyle: 'premium-clean-bethel-v2',
  };
  await writeArtifact('thumbnail-info.json', Buffer.from(JSON.stringify(info, null, 2)));

  if (IS_DRY_RUN) {
    console.log('DRY RUN complete. Wix sermon thumbnail was not updated.');
    return;
  }

  const fileName = `sermon-${videoId}-custom.jpg`;
  const uploadedFile = await uploadImageToWix(thumbnailBuffer, fileName);
  const thumbnailRef = wixImageRef(uploadedFile, fileName);

  await patchSermonThumbnail(sermon.id, thumbnailRef);
  console.log('Updated sermon thumbnail successfully.');

  await markSubmissionSeen(submission);
  console.log('Marked submission seen.');
}

main().catch(async (err) => {
  console.error(err && err.stack ? err.stack : err);
  try {
    await writeArtifact('thumbnail-error.txt', Buffer.from(String(err && err.stack ? err.stack : err)));
  } catch (_) {}
  process.exit(1);
});
