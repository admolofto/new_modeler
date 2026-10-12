import type { ImageAttachment } from '../ai/agent';

/**
 * Files added to an AI chat message (the attach button, pasting, or dropping on the chat).
 * Pictures go to the AI as images, scaled down and re-encoded as JPEG so every engine takes them;
 * text files (notes, CSV cut lists, JSON) go inline in the message.
 */

export type ChatFile =
  | { kind: 'image'; name: string; image: ImageAttachment }
  | { kind: 'text'; name: string; text: string };

/** Longest side sent to the AI; bigger pictures cost more and the model downsizes them anyway. */
export const MAX_IMAGE_SIDE = 1568;
/** Pictures per message, the view picture included (the server allows this many). */
export const MAX_IMAGES = 8;
/** Characters per text file. */
export const MAX_TEXT_CHARS = 200_000;

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'svg', 'dae', 'obj', 'yaml', 'yml', 'log', 'html', 'ts', 'js']);

const extension = (name: string) => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

/** How a file goes to the AI, or why it can't. */
export function classifyFile(name: string, type: string): 'image' | 'text' | { unsupported: string } {
  const ext = extension(name);
  if (type.startsWith('image/') && type !== 'image/svg+xml') return 'image';
  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || TEXT_EXTENSIONS.has(ext)) return 'text';
  if (type === 'application/pdf' || ext === 'pdf') return { unsupported: `${name}: PDFs can't go to the AI yet. Paste a screenshot of the page instead.` };
  return { unsupported: `${name}: only pictures and text files can go to the AI.` };
}

/** Size that fits within `max` on the longest side, keeping the aspect (never enlarged). */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** A text file as it appears in the message to the AI. */
export function fileBlock(name: string, text: string): string {
  const cut = text.length > MAX_TEXT_CHARS;
  return `<file name="${name.replace(/"/g, "'")}">\n${cut ? text.slice(0, MAX_TEXT_CHARS) : text}\n</file>${cut ? `\n(${name} was cut off after ${MAX_TEXT_CHARS} characters.)` : ''}`;
}

/** Reads a picture (scaled, as JPEG on white) or a text file. Throws a readable message for anything else. */
export async function readChatFile(file: File): Promise<ChatFile> {
  const name = file.name || 'pasted image';
  const kind = classifyFile(name, file.type);
  if (typeof kind === 'object') throw new Error(kind.unsupported);
  if (kind === 'text') return { kind, name, text: await file.text() };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${name}: this browser can't read that picture format. Try a PNG or JPEG.`);
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // Transparent areas would turn black in a JPEG.
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { kind, name, image: { mediaType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.9).split(',')[1]! } };
}

/** The files carried by a paste or drop (a pasted screenshot comes through as a file too). */
export function transferFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files.length) return [...data.files];
  return [...data.items].flatMap((item) => (item.kind === 'file' ? [item.getAsFile()].filter((f): f is File => !!f) : []));
}

export const imageUrl = (image: ImageAttachment) => `data:${image.mediaType};base64,${image.data}`;
