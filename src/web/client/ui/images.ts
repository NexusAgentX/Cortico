/**
 * 输入器图片通道的归一化:把用户丢进来的文件变成 `ConsoleImageAttachment`。
 *
 * 规则只有三条:不是图不收;长边超过上限按比例缩小;编码后仍超字节上限的改 JPEG
 * 重编码,再超就拒收。原文件在上限之内时字节原样透传(PNG 不转、GIF 动图不动),
 * 只有真的要缩才走 canvas——重编码是有损的,不该为一张本来就合规的图付这个代价。
 *
 * `fitWithin` 单独导出:它是这里唯一的算术,也是在没有 canvas 的测试环境里唯一能钉的部分。
 */

import type { ConsoleImageAttachment, ConsolePromptImagesOptions } from '../../shared/client-panel.ts';
import { S } from './strings.ts';

export const IMAGE_MIMES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const IMAGE_DEFAULTS: Required<ConsolePromptImagesOptions> = {
  max: 8,
  maxEdge: 2048,
  maxBytes: 6 * 1024 * 1024,
};

export function isImageFile(file: { type: string }): boolean {
  return IMAGE_MIMES.includes(file.type);
}

/** 只缩不放:长边不超过 `maxEdge` 的原样返回;缩放保持比例,四舍五入且不小于 1。 */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (!(edge > maxEdge) || maxEdge <= 0) return { width, height };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(S.imageReadFailed));
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function encode(bitmap: ImageBitmap, width: number, height: number, mime: string, quality?: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(S.canvasUnsupported);
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(S.imageEncodeFailed))), mime, quality);
  });
}

/**
 * 归一化一张图。拒收(不是图片、解码失败、缩到上限后仍超字节上限)以异常表达,
 * 消息可直接给用户看。
 */
export async function normalizeImage(
  file: File,
  opts: ConsolePromptImagesOptions = {},
): Promise<ConsoleImageAttachment> {
  const { maxEdge, maxBytes } = { ...IMAGE_DEFAULTS, ...opts };
  if (!isImageFile(file)) throw new Error(S.notImage(file.name || S.fileFallback));
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(S.undecodable(file.name || S.imageFallback));
  }
  try {
    const name = file.name || 'image';
    const fitted = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const untouched = fitted.width === bitmap.width && fitted.height === bitmap.height && file.size <= maxBytes;
    if (untouched) {
      return { name, mime: file.type, base64: await toBase64(file), bytes: file.size, width: bitmap.width, height: bitmap.height };
    }
    // 缩放后先试原格式(GIF 没有 canvas 编码器,退 PNG);超字节上限再退 JPEG。
    const preferred = file.type === 'image/gif' ? 'image/png' : file.type;
    let blob = await encode(bitmap, fitted.width, fitted.height, preferred);
    let mime = preferred;
    if (blob.size > maxBytes && preferred !== 'image/jpeg') {
      blob = await encode(bitmap, fitted.width, fitted.height, 'image/jpeg', 0.85);
      mime = 'image/jpeg';
    }
    if (blob.size > maxBytes) {
      throw new Error(S.stillTooLarge(name, Math.round(maxBytes / 1024 / 1024)));
    }
    return { name, mime, base64: await toBase64(blob), bytes: blob.size, width: fitted.width, height: fitted.height };
  } finally {
    bitmap.close();
  }
}
