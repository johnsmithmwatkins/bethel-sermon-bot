/**
 * Thumbnail-only title cleanup.
 * Preserve YouTube/Wix sermon titles; never put service labels in artwork.
 */
const DAY = '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)';
const TIME = '(?:Morning|Afternoon|Evening|Night|AM|PM)';
const SERVICE = '(?:Service|Worship|Meeting|Sermon|Message|Live Stream)';
const PREFIX = new RegExp(
  '^\\s*(?:' +
  DAY + '(?:\\s+' + TIME + ')?(?:\\s+' + SERVICE + ')?' +
  '|Midweek(?:\\s+' + SERVICE + ')?' +
  ')(?:\\s*[:|\\-–—]\\s*)+',
  'i'
);

function stripServicePrefix(input) {
  let title = String(input || '').trim();
  // Handle "Wednesday Night:", "Sunday Morning Service:",
  // "Sunday AM:", "Midweek Service:", and repeated variants.
  for (let i = 0; i < 3; i++) {
    const result = title.replace(PREFIX, '').trim();
    if (result === title) break;
    title = result;
  }
  return title;
}

function forThumbnail({ title, speaker, subtitle }) {
  let cleanTitle = stripServicePrefix(title);
  let cleanSpeaker = String(speaker || '').trim();
  let cleanSubtitle = stripServicePrefix(subtitle || '');

  // Video titles may include "Matthew Watkins- A Servant's Heart"
  // when the description does not have separate speaker metadata.
  // If a recognizable minister name is before a dash, place it in
  // the speaker label; do not repeat it in the headline.
  const lead = cleanTitle.match(
    /^(?:(?:Bro|Brother|Pastor|Rev)\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*[-–—:]\s*(.+)$/
  );
  if (lead && (!cleanSpeaker || /^Bethel Tabernacle$/i.test(cleanSpeaker))) {
    cleanSpeaker = lead[1];
    cleanTitle = lead[2].trim();
  }

  return {
    title: cleanTitle,
    speaker: cleanSpeaker || 'Bethel Tabernacle',
    subtitle: cleanSubtitle,
  };
}

module.exports = { stripServicePrefix, forThumbnail };
