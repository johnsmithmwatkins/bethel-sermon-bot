/**
 * One-time corrective pass for "More of God, Less of Me".
 * Matches exact YouTube IDs rather than relying on old Wix title text.
 * Uses each original Wix thumbnail and submitted real preacher screengrab
 * as image-edit references. Does not mark or change form submissions.
 */
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs/promises');
const { File } = require('buffer');

const { WIX_API_KEY, WIX_SITE_ID, OPENAI_API_KEY, OPENAI_IMAGE_MODEL, DRY_RUN } = process.env;
const isDryRun = String(DRY_RUN || '').toLowerCase() === 'true';
for (const [name, value] of Object.entries({ WIX_API_KEY, WIX_SITE_ID, OPENAI_API_KEY })) {
  if (!value) throw new Error('Missing GitHub Actions secret ' + name);
}

const EPISODES = [
  { part: 1, videoId: 'eG1KK2_4sNE' },
  // Part 2 is already correctly numbered and should not be regenerated.
  { part: 3, videoId: 'ZIpAKehGpX8' },
  { part: 4, videoId: 'WjK_gI7GCMg' },
  { part: 5, videoId: 'SuVA6lCmFKA' },
];
const FORM_ID = 'c2d24226-8540-46fb-b7ea-2eb2114bd190';
const FORM_NS = 'wix.form_app.form';
const MODEL = OPENAI_IMAGE_MODEL || 'gpt-image-2';

async function wix(path, method, body) {
  const res = await fetch('https://www.wixapis.com' + path, {
    method,
    headers: {
      Authorization: WIX_API_KEY,
      'wix-site-id': WIX_SITE_ID,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Wix ' + res.status + ' ' + path + ': ' + JSON.stringify(json));
  return json;
}

function videoIdFromLink(raw) {
  const text = String(raw || '');
  const match = text.match(/[?&]v=([A-Za-z0-9_-]{11})|youtu\.be\/([A-Za-z0-9_-]{11})|youtube\.com\/live\/([A-Za-z0-9_-]{11})/);
  return match ? (match[1] || match[2] || match[3]) : null;
}
async function getScreenshots() {
  const found = new Map();
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const query = cursor
      ? { cursorPaging: { limit: 100, cursor } }
      : {
          filter: { formId: FORM_ID, namespace: FORM_NS },
          sort: [{ fieldName: 'createdDate', order: 'DESC' }],
          cursorPaging: { limit: 100 },
        };
    const response = await wix('/form-submission-service/v4/submissions/namespace/query', 'POST', {
      query,
      onlyYourOwn: false,
    });
    for (const submission of response.submissions || []) {
      const fields = submission.submissions || {};
      const id = videoIdFromLink(fields.youtubeUrl || fields.youtube_url || fields.url);
      if (!id || found.has(id)) continue;
      const screenshot = fields.screenGrab || fields.screengrab || [];
      const url = Array.isArray(screenshot) ? screenshot[0]?.url : screenshot?.url;
      if (url) found.set(id, url);
    }
    if (!response.metadata?.hasNext) break;
    cursor = response.metadata?.cursors?.next;
    if (!cursor) throw new Error('Form query hasNext without cursor.');
  }
  return found;
}
async function getSermon(videoId) {
  const response = await wix('/wix-data/v2/items/query', 'POST', {
    dataCollectionId: 'Sermons',
    query: { filter: { url: { $contains: videoId } }, paging: { limit: 2 } },
  });
  const matches = response.dataItems || [];
  if (matches.length !== 1) throw new Error('Expected exactly one Wix sermon for ' + videoId + ', found ' + matches.length);
  const item = matches[0];
  if (!/more of god/i.test(item.data?.title || '')) {
    throw new Error('Unexpected sermon title for ' + videoId + ': ' + (item.data?.title || ''));
  }
  return item;
}
async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('Could not download reference image: HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
function mediaUrl(ref) {
  const match = String(ref).match(/^wix:image:\/\/v1\/([^/]+)/);
  if (!match) throw new Error('Unexpected Wix thumbnail reference: ' + ref);
  return 'https://static.wixstatic.com/media/' + match[1];
}
async function normalizeJpeg(raw) {
  const img = await loadImage(raw);
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext('2d');
  const scale = Math.max(1280 / img.width, 720 / img.height);
  const width = 1280 / scale;
  const height = 720 / scale;
  const x = Math.max(0, (img.width - width) / 2);
  const y = Math.max(0, (img.height - height) / 2);
  ctx.drawImage(img, x, y, width, height, 0, 0, 1280, 720);
  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}
function correctionPrompt(part) {
  return [
    'You are CORRECTING TYPOGRAPHY IN AN EXISTING FINISHED CHURCH SERMON THUMBNAIL.',
    'This is an image EDIT, not a new design. Image 1 is the finished thumbnail to edit.',
    'Image 2 is the original real preacher reference screenshot for identity accuracy.',
    'Keep the original composition, the real preacher face, clothing, pose, photography, lighting, mountains or forest, colors, borders, translucent panel, and church logo as unchanged as possible.',
    'Only correct the main sermon heading and part number on the LEFT side.',
    'The main heading must have precisely these two textual elements:',
    'More of God, Less of Me',
    'Part ' + part,
    'The episode number MUST be ' + part + '. Do not write any other part number.',
    'Erase outdated embedded wording such as pt.2, pt 3, Pt.4, Sunday Morning Service, and repeated Bro Jason Watkins text from the MAIN TITLE area.',
    'Keep a single small name label Jason Watkins above the title, if one exists in the original layout.',
    'Keep BETHEL TABERNACLE at the bottom of the left panel, matching its existing style.',
    'Render beautiful readable large serif title typography in the SAME style as original artwork.',
    'Do not crop the preacher head. Do not add people, props, new objects, or new background imagery.',
    'Design a 16:9 YouTube thumbnail. Leave generous margins so the title survives a center crop to 1280x720.',
    'This is a surgical lettering correction; the final image should look like the original except for the correct text.',
  ].join('\n');
}
async function correctedThumbnail(episode, sourceImage, screenshot) {
  const form = new FormData();
  form.append('model', MODEL);
  form.append('quality', 'high');
  form.append('size', '1536x1024');
  form.append('image[]', new File([sourceImage], 'existing-thumbnail.jpg', { type: 'image/jpeg' }));
  const screenImg = await loadImage(screenshot);
  const sc = createCanvas(screenImg.width, screenImg.height);
  sc.getContext('2d').drawImage(screenImg, 0, 0);
  const screenshotPng = sc.toBuffer('image/png');
  form.append('image[]', new File([screenshotPng], 'real-preacher.png', { type: 'image/png' }));
  form.append('prompt', correctionPrompt(episode.part));
  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + OPENAI_API_KEY },
    body: form,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('OpenAI edit failed ' + response.status + ': ' + JSON.stringify(json));
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI did not return edited image data.');
  return normalizeJpeg(Buffer.from(b64, 'base64'));
}
async function uploadToWix(jpg, episode) {
  const name = 'more-of-god-less-of-me-part-' + episode.part + '-corrected.jpg';
  const generated = await wix('/site-media/v1/files/generate-upload-url', 'POST', {
    mimeType: 'image/jpeg',
    fileName: name,
  });
  const response = await fetch(generated.uploadUrl + '?filename=' + encodeURIComponent(name), {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: jpg,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.file?.id) throw new Error('Wix upload failed: ' + JSON.stringify(result));
  return 'wix:image://v1/' + result.file.id + '/' + name + '#originWidth=1280&originHeight=720';
}
async function patchSermon(id, thumbnailRef) {
  const result = await wix('/wix-data/v2/bulk/items/patch', 'POST', {
    dataCollectionId: 'Sermons',
    patches: [{
      dataItemId: id,
      fieldModifications: [{
        fieldPath: 'thumbnail',
        action: 'SET_FIELD',
        setFieldOptions: { value: thumbnailRef },
      }],
    }],
  });
  if (result.bulkActionMetadata?.totalSuccesses !== 1 ||
      result.bulkActionMetadata?.totalFailures !== 0 ||
      result.results?.[0]?.itemMetadata?.success === false) {
    throw new Error('Wix CMS did not confirm success: ' + JSON.stringify(result));
  }
}
async function main() {
  const screenshots = await getScreenshots();
  const preparations = [];
  // Preflight all four videos before any image generation or CMS mutation.
  for (const episode of EPISODES) {
    const sermon = await getSermon(episode.videoId);
    const screenshotUrl = screenshots.get(episode.videoId);
    if (!screenshotUrl) throw new Error('No saved screengrab available for ' + episode.videoId);
    preparations.push({ episode, sermon, screenshotUrl });
  }

  let failed = 0;
  const results = [];
  for (const item of preparations) {
    const { episode, sermon, screenshotUrl } = item;
    const label = 'Part ' + episode.part;
    try {
      if (String(sermon.data.thumbnail || '').includes('-part-' + episode.part + '-corrected.jpg')) {
        console.log(label + ': already corrected; skipping repeat.');
        results.push({ part: episode.part, status: 'already_corrected' });
        continue;
      }
      const source = await download(mediaUrl(sermon.data.thumbnail));
      const screenshot = await download(screenshotUrl);
      const jpg = await correctedThumbnail(episode, source, screenshot);
      await fs.writeFile('corrected-part-' + episode.part + '.jpg', jpg);
      if (isDryRun) {
        console.log(label + ': preview generated; dry run, Wix unchanged.');
        results.push({ part: episode.part, status: 'preview_only' });
        continue;
      }
      const ref = await uploadToWix(jpg, episode);
      await patchSermon(sermon.id, ref);
      console.log(label + ': Wix thumbnail updated successfully.');
      results.push({ part: episode.part, status: 'updated', videoId: episode.videoId, itemId: sermon.id, previousThumbnail: sermon.data.thumbnail, thumbnail: ref });
    } catch (err) {
      failed++;
      console.error(label + ' FAILED: ' + err.message);
      results.push({ part: episode.part, status: 'failed', error: err.message });
    }
  }
  await fs.writeFile('series-correction-results.json', JSON.stringify(results, null, 2));
  console.log('Corrected ' + results.filter(x => x.status === 'updated').length + ' thumbnails; ' + failed + ' failures.');
  if (failed) process.exitCode = 1;
}
main().catch(async err => {
  console.error('Series fix failed:', err);
  process.exitCode = 1;
});
