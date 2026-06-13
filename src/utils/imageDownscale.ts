/**
 * Client-side image downscaling for chat attachments.
 *
 * Phone photos are routinely several MB — larger than both the server's 5MB
 * per-image cap and the reverse proxy's body limit, so they fail to upload.
 * They're also far bigger than Claude can use: the vision models downsample
 * anything over ~1568px on the long edge, so sending full-resolution photos
 * wastes upload time (painful on mobile) for no quality gain.
 *
 * This re-encodes oversized images through a canvas, bounding the long edge
 * and (for non-PNG) applying JPEG compression, returning a fresh File. Images
 * already within bounds are returned untouched. Anything that can't be decoded
 * (corrupt, or a format the browser can't render) is returned as-is so the
 * existing upload/validation path still handles it.
 */

// Claude's vision models downsample above this; no reason to send more.
const MAX_EDGE = 1568;
// Re-encode anything larger than this, even if its dimensions are already
// within bounds (e.g. a lightly-compressed 3MB JPEG at 1500px).
const REENCODE_OVER_BYTES = 1024 * 1024;
const JPEG_QUALITY = 0.85;

function canUseCanvas(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof createImageBitmap === 'function' &&
    typeof HTMLCanvasElement !== 'undefined'
  );
}

function loadBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Returns a downscaled/re-encoded copy of `file` when it's oversized, or the
 * original file when it's already small enough or can't be processed.
 */
export async function downscaleImageFile(file: File): Promise<File> {
  if (!canUseCanvas() || !file.type.startsWith('image/')) {
    return file;
  }
  // SVG and GIF (possibly animated) don't survive canvas re-encoding well;
  // leave them to the normal path.
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
    return file;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await loadBitmap(file);
  } catch {
    return file;
  }

  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const needsResize = longEdge > MAX_EDGE;
    const needsReencode = file.size > REENCODE_OVER_BYTES;
    if (!needsResize && !needsReencode) {
      return file;
    }

    const scale = needsResize ? MAX_EDGE / longEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);

    // Preserve PNG (it may carry transparency); everything else becomes JPEG,
    // which compresses photos far better.
    const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await canvasToBlob(canvas, outType, outType === 'image/jpeg' ? JPEG_QUALITY : undefined);
    if (!blob) {
      return file;
    }

    // If re-encoding somehow produced a larger file (e.g. a tiny PNG), keep
    // the original.
    if (blob.size >= file.size && !needsResize) {
      return file;
    }

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
    const ext = outType === 'image/png' ? 'png' : 'jpg';
    return new File([blob], `${baseName}.${ext}`, {
      type: outType,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}

/** Downscales each file independently; failures fall back to the original. */
export async function downscaleImageFiles(files: File[]): Promise<File[]> {
  return Promise.all(files.map((file) => downscaleImageFile(file)));
}
