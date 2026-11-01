/**
 * One-time text-only repair: "A Servant's Heart" by Matthew Watkins.
 * Preserve every pixel of the preacher photograph on the right.
 * Update only the thumbnail field of the exact matching Wix sermon.
 */
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs/promises');
const { forThumbnail } = require('./thumbnail-title');

const { WIX_API_KEY, WIX_SITE_ID } = process.env;
if (!WIX_API_KEY || !WIX_SITE_ID) throw new Error('Missing WIX_API_KEY or WIX_SITE_ID.');

const VIDEO_ID = 'sPIuCUmCPgc';
const SERMON_ID = 'fc41f85a-d9a7-492e-9f81-706232c244ea';
const ORIGINAL_IMAGE = 'https://static.wixstatic.com/media/30c91e_8a4d69d0b67d4928951d354e9d388ae4~mv2.jpg';
const OUTPUT_NAME = 'a-servants-heart-matthew-watkins-no-service-label-v2.jpg';

registerFont(path.join(__dirname, 'assets', 'DejaVuSans.ttf'), { family: 'Bethel Sans' });
registerFont(path.join(__dirname, 'assets', 'DejaVuSans-Bold.ttf'), { family: 'Bethel Sans Bold' });

async function wix(uri, method, body) {
  const response = await fetch('https://www.wixapis.com' + uri, {
    method,
    headers: {
      Authorization: WIX_API_KEY,
      'wix-site-id': WIX_SITE_ID,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Wix ' + method + ' ' + uri + ' failed: ' + JSON.stringify(result));
  return result;
}

function roundedPanel(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

async function render(originalBytes) {
  const photo = await loadImage(originalBytes);
  if (photo.width !== 1280 || photo.height !== 720)
    throw new Error('Unexpected original thumbnail dimensions: ' + photo.width + 'x' + photo.height);
  const canvas = createCanvas(1280, 720);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(photo, 0, 0);

  // Rebuild only the original left-panel area. No edits to the right-side photo.
  const panelGradient = ctx.createLinearGradient(50, 0, 630, 720);
  panelGradient.addColorStop(0, '#251e4b');
  panelGradient.addColorStop(0.55, '#221d45');
  panelGradient.addColorStop(1, '#181737');
  roundedPanel(ctx, 48, -10, 585, 738, 51);
  ctx.fillStyle = panelGradient;
  ctx.fill();
  ctx.strokeStyle = 'rgba(229, 213, 249, 0.68)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Use the same title formatter as BOTH permanent Sermon Bot pathways.
  const display = forThumbnail({
    title: "Sunday Morning: Matthew Watkins- A Servant's Heart",
    speaker: 'Bethel Tabernacle',
    subtitle: '',
  });
  if (display.title !== "A Servant's Heart" || display.speaker !== 'Matthew Watkins')
    throw new Error('Thumbnail title formatter returned unexpected fields: ' + JSON.stringify(display));

  ctx.fillStyle = '#ede5f9';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '29px "Bethel Sans"';
  ctx.fillText(display.speaker, 94, 90);

  ctx.strokeStyle = 'rgba(237, 229, 249, 0.45)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(94, 114);
  ctx.lineTo(250, 114);
  ctx.stroke();

  // Strong serif headline, intentionally without "Sunday Morning:".
  ctx.font = '83px Georgia, "Liberation Serif", serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText("A Servant's", 90, 295);
  ctx.font = '106px Georgia, "Liberation Serif", serif';
  ctx.fillText('Heart', 90, 415);

  // Reproduce original branded outline pill.
  roundedPanel(ctx, 92, 604, 431, 64, 29);
  ctx.strokeStyle = '#d6b7f4';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.font = '25px "Bethel Sans"';
  ctx.fillStyle = '#e4d7f1';
  ctx.fillText('BETHEL TABERNACLE', 129, 645);

  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}

async function main() {
  const existing = await wix('/wix-data/v2/items/' + SERMON_ID + '?dataCollectionId=Sermons&consistentRead=true', 'GET');
  const sermon = existing.dataItem;
  if (sermon?.id !== SERMON_ID ||
      !String(sermon.data?.url || '').includes(VIDEO_ID) ||
      !/servant.s heart/i.test(String(sermon.data?.title || '')))
    throw new Error('Wix sermon identity check failed; no changes made.');

  if (String(sermon.data.thumbnail || '').includes(OUTPUT_NAME)) {
    console.log('Thumbnail was previously corrected. No changes required.');
    return;
  }

  const input = await fetch(ORIGINAL_IMAGE);
  if (!input.ok) throw new Error('Cannot fetch original Wix thumbnail: HTTP ' + input.status);
  const jpeg = await render(Buffer.from(await input.arrayBuffer()));
  await fs.writeFile('a-servants-heart-corrected-preview.jpg', jpeg);

  const generated = await wix('/site-media/v1/files/generate-upload-url', 'POST', {
    mimeType: 'image/jpeg',
    fileName: OUTPUT_NAME,
  });
  const uploadResponse = await fetch(generated.uploadUrl + '?filename=' + encodeURIComponent(OUTPUT_NAME), {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: jpeg,
  });
  const uploaded = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || !uploaded.file?.id)
    throw new Error('Image upload failed: ' + JSON.stringify(uploaded));
  const thumbRef = 'wix:image://v1/' + uploaded.file.id + '/' + OUTPUT_NAME +
    '#originWidth=1280&originHeight=720';

  const patch = await wix('/wix-data/v2/bulk/items/patch', 'POST', {
    dataCollectionId: 'Sermons',
    patches: [
      {
        dataItemId: SERMON_ID,
        fieldModifications: [
          { fieldPath: 'thumbnail', action: 'SET_FIELD', setFieldOptions: { value: thumbRef } },
        ],
      },
    ],
  });
  if (patch.bulkActionMetadata?.totalSuccesses !== 1 ||
      patch.bulkActionMetadata?.totalFailures !== 0 ||
      patch.results?.[0]?.itemMetadata?.success === false)
    throw new Error('Wix CMS refused thumbnail update: ' + JSON.stringify(patch));

  const verified = await wix('/wix-data/v2/items/' + SERMON_ID + '?dataCollectionId=Sermons&consistentRead=true', 'GET');
  if (verified.dataItem?.data?.thumbnail !== thumbRef) throw new Error('Thumbnail write could not be verified.');
  if (verified.dataItem?.data?.title !== sermon.data.title) throw new Error('Original title was unexpectedly modified.');
  console.log('SUCCESS: Updated Matthew Watkins A Servant\'s Heart thumbnail; Wix sermon title unchanged.');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
