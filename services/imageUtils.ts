import { AIImageAttachment } from '../types';

/**
 * Image preparation for multimodal AI requests.
 *
 * Why this exists: raw uploads (screenshots, photos, exported mockups) are routinely
 * several MB. Base64 inflates that by ~33%, and the whole payload counts against the
 * provider's request-body limit (DeepSeek caps a request at 48 MiB) as well as against
 * billed input tokens. So every image is downscaled and re-encoded here before it is
 * ever attached to a request.
 */

/** Longest edge of the downscaled image. Matches the useful range of vision encoders. */
export const MAX_IMAGE_EDGE = 1024;
/** Second pass, used when the first encoding is still large. */
export const MIN_IMAGE_EDGE = 768;

const INITIAL_QUALITY = 0.85;
const RETRY_QUALITY = 0.7;
/** Soft budget for the encoded payload; beyond this we shrink the edge again. */
const TARGET_BYTES = 700 * 1024;

/** Refuse absurd source files outright rather than decoding them into memory. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** Documented DeepSeek request-body limit, kept as a sanity guard for the whole payload. */
export const DEEPSEEK_REQUEST_BODY_LIMIT = 48 * 1024 * 1024;

/** Formats accepted by the DeepSeek vision API (detected from content, not the file name). */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
];

export const isSupportedImageFile = (file: File): boolean =>
  SUPPORTED_IMAGE_MIME_TYPES.includes(file.type) ||
  // Some OSes report an empty type for dropped files; fall back to the extension.
  (!file.type && /\.(jpe?g|png|gif|webp)$/i.test(file.name));

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.readAsDataURL(file);
  });

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The selected file is not a decodable image.'));
    img.src = src;
  });

const base64Bytes = (dataUrl: string): number => {
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  // 4 base64 chars -> 3 bytes, minus padding.
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

const encode = (canvas: HTMLCanvasElement, mimeType: string, quality: number): string =>
  canvas.toDataURL(mimeType, quality);

const drawScaled = (
  img: HTMLImageElement,
  maxEdge: number
): { canvas: HTMLCanvasElement; width: number; height: number } => {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const width = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot process images for AI upload (no 2D canvas context).');
  ctx.drawImage(img, 0, 0, width, height);
  return { canvas, width, height };
};

/**
 * Downscale + re-encode an image so it is safe to attach to a multimodal request.
 * Animated GIFs collapse to their first frame (the canvas API has no frame timeline).
 */
const encodeAttachment = async (
  source: string,
  name: string
): Promise<AIImageAttachment> => {
  const img = await loadImage(source);

  let quality = INITIAL_QUALITY;
  let maxEdge = MAX_IMAGE_EDGE;
  let { canvas, width, height } = drawScaled(img, maxEdge);

  // WebP keeps alpha and compresses much better than PNG for UI mockups.
  // Browsers that cannot encode WebP silently return a PNG data URL, so detect and fall back.
  let dataUrl = encode(canvas, 'image/webp', quality);
  if (!dataUrl.startsWith('data:image/webp')) {
    dataUrl = encode(canvas, 'image/jpeg', quality);
  }

  // Still too heavy? Drop quality, then shrink the edge, then do both.
  if (base64Bytes(dataUrl) > TARGET_BYTES) {
    quality = RETRY_QUALITY;
    dataUrl = encode(canvas, dataUrl.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg', quality);
  }
  if (base64Bytes(dataUrl) > TARGET_BYTES && maxEdge > MIN_IMAGE_EDGE) {
    maxEdge = MIN_IMAGE_EDGE;
    ({ canvas, width, height } = drawScaled(img, maxEdge));
    dataUrl = encode(canvas, dataUrl.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg', quality);
  }

  const comma = dataUrl.indexOf(',');
  const mimeType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png';

  return {
    dataUrl: comma >= 0 ? dataUrl : `data:${mimeType};base64,${dataUrl}`,
    mimeType,
    name,
    width,
    height,
    bytes: base64Bytes(dataUrl)
  };
};

export const prepareImageForAI = async (file: File): Promise<AIImageAttachment> => {
  if (!isSupportedImageFile(file)) {
    throw new Error(
      `Unsupported image type${file.type ? ` (${file.type})` : ''}. Use JPEG, PNG, GIF or WebP.`
    );
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(
      `Image is too large (${formatBytes(file.size)}). The limit is ${formatBytes(MAX_SOURCE_BYTES)}.`
    );
  }
  const dataUrl = await readFileAsDataUrl(file);
  return encodeAttachment(dataUrl, file.name || 'pasted-image');
};

export const prepareImageFromDataUrl = async (
  dataUrl: string,
  name = 'pasted-image'
): Promise<AIImageAttachment> => encodeAttachment(dataUrl, name);

/** Rough token estimate for the attached image, used only for the cost hint in the UI. */
export const estimateImageTokens = (image: AIImageAttachment): number =>
  Math.ceil(image.width / 28) * Math.ceil(image.height / 28);
