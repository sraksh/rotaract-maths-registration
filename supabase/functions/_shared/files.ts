/** Payment-screenshot constraints and content sniffing. */

export const MAX_PROOF_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_QR_BYTES = 2 * 1024 * 1024; // 2 MB

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export const ALLOWED_MIME: readonly ImageMime[] = ['image/jpeg', 'image/png', 'image/webp'];
export const ALLOWED_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp'];

export function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx < 0 ? '' : fileName.slice(idx + 1).toLowerCase();
}

/** The MIME type implied by an extension, or null if the extension is not allowed. */
export function mimeForExtension(ext: string): ImageMime | null {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

export interface DeclaredFile {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Checks the metadata the browser DECLARES about a file. This is a usability
 * check only; the stored object is re-verified from its bytes by
 * `detectImageType()` before a registration is saved.
 */
export function validateDeclaredFile(f: DeclaredFile, maxBytes = MAX_PROOF_BYTES): string | null {
  if (!Number.isFinite(f.sizeBytes) || f.sizeBytes <= 0) return 'The selected file is empty.';
  if (f.sizeBytes > maxBytes) return `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  const byExt = mimeForExtension(extensionOf(f.fileName));
  if (!byExt) return 'Only JPG, JPEG, PNG or WEBP images are accepted.';
  if (!(ALLOWED_MIME as readonly string[]).includes(f.contentType)) {
    return 'Only JPG, JPEG, PNG or WEBP images are accepted.';
  }
  if (byExt !== f.contentType) return 'The file extension does not match its type.';
  return null;
}

/** Detects the real image type from the file signature ("magic bytes"). */
export function detectImageType(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }
  return null;
}
