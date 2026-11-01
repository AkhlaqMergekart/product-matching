// Image URLs as the matching service needs them: addresses that answer with
// the image itself.
//
// Some catalogues store Google Drive *share* links ("drive.google.com/file/
// d/<id>/view?usp=sharing" — project 353's Stag Iconic products). Those
// answer with Drive's viewer page (text/html), so the service has no image to
// compare and image similarity scores 0 for every candidate.
//
// For a publicly shared file, lh3.googleusercontent.com/d/<id> answers with
// the image itself (HTTP 200 image/jpeg). It has to be that host: the
// matching service does not follow redirects, and Drive's own image
// addresses (drive.google.com/thumbnail?id=..., uc?export=view) answer 302/303
// pointing here — sending the thumbnail address still scored 0 against a
// candidate an ordinary .jpg scored 1.0 with (TTRA 670, 2026-11-01).
//
// Folder links ("drive.google.com/drive/folders/<id>") point at no single
// image and can't be converted; they are left as they are.

// Width asked of Drive. Images are compared, not displayed, so this only
// needs to be comfortably above what the service resizes to.
const DRIVE_IMAGE_WIDTH = 1000;

// The file id in the Drive URL forms a share link comes in:
//   drive.google.com/file/d/<id>/view?usp=sharing
//   drive.google.com/open?id=<id>
//   drive.google.com/uc?id=<id>&export=...      (docs.google.com too)
function driveFileId(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return null;
  }

  if (!/^(drive|docs)\.google\.com$/.test(parsed.hostname)) return null;

  const fromPath = parsed.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
  if (fromPath) return fromPath[1];

  if (/^\/(open|uc)$/.test(parsed.pathname)) {
    const id = parsed.searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  }

  return null;
}

function toDirectImageUrl(url) {
  if (typeof url !== "string") return url;
  const id = driveFileId(url.trim());
  return id ? `https://lh3.googleusercontent.com/d/${id}=w${DRIVE_IMAGE_WIDTH}` : url;
}

// Maps a product's `images` (an array of URLs, or a single URL) to direct
// image addresses; anything else is passed through untouched.
function toDirectImageUrls(images) {
  if (Array.isArray(images)) return images.map(toDirectImageUrl);
  if (typeof images === "string") return toDirectImageUrl(images);
  return images;
}

module.exports = { toDirectImageUrl, toDirectImageUrls };
