// Source-catalogue image URLs, made fetchable before they are sent to the
// matching service.
//
// ScratchProducts rows in project 353 store Google Drive SHARE links, not
// image URLs. Verified live 2026-10-31 against file 17GbI_WRnAiy8WpvE2Jtec2…:
//
//   /file/d/<ID>/view?usp=drive_link   -> HTTP 200 text/html, 85 KB   (a viewer PAGE)
//   /uc?export=download&id=<ID>        -> HTTP 200 image/png, 1.37 MB
//   /thumbnail?id=<ID>&sz=w1000        -> HTTP 200 image/png, 424 KB, 1000x1000
//
// So anything fetching the stored URL gets an HTML document where it expects
// an image. image_similarity is one of the four match gates, which makes this
// the difference between a real score and a meaningless one — and it fails
// silently, because a 200 with a body looks like success.
//
// The thumbnail form is preferred over uc?export=download: same picture, about
// a third of the bytes, and it does not go through Drive's download
// interstitial for larger files.
//
// Some entries are FOLDER links (/drive/folders/<ID>), which are not images at
// all and are dropped — on SKU 175626 that was images[0], i.e. the first and
// most likely-to-be-compared image was junk.
const DRIVE_THUMBNAIL_WIDTH = 1000;

// /file/d/<ID>/view, /uc?id=<ID>, /open?id=<ID>, /thumbnail?id=<ID>
function driveFileId(url) {
  const path = url.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (path) return path[1];

  const query = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (query) return query[1];

  return null;
}

function isDriveFolder(url) {
  return /drive\.google\.com\/drive\/folders\//i.test(url);
}

// Returns a directly fetchable image URL, or null when the entry cannot be
// one (a folder link, or an unusable value). Non-Drive URLs pass through
// untouched — every other source in this service already stores real image
// URLs, and rewriting those would be the bug this function exists to fix.
function normalizeImageUrl(value) {
  if (typeof value !== "string") return null;

  const url = value.trim();
  if (!url) return null;

  if (!/drive\.google\.com/i.test(url)) return url;

  if (isDriveFolder(url)) return null;

  const id = driveFileId(url);
  if (!id) return null;

  return `https://drive.google.com/thumbnail?id=${id}&sz=w${DRIVE_THUMBNAIL_WIDTH}`;
}

// Maps a product's image list, dropping what cannot be fetched and de-duping
// (the same Drive id can appear under more than one share form).
function normalizeSourceImages(images) {
  if (!Array.isArray(images)) return [];

  const seen = new Set();
  const out = [];

  for (const entry of images) {
    const url = normalizeImageUrl(entry);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }

  return out;
}

// Convenience for the callers that hand a whole product to the matching
// service: returns a COPY with its images normalised, so the caller's row —
// which is also written to the output file — is left as it was stored.
function withFetchableImages(product) {
  return { ...product, images: normalizeSourceImages(product?.images) };
}

module.exports = { normalizeImageUrl, normalizeSourceImages, withFetchableImages };
