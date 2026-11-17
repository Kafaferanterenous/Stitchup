//! QuickSign — handwritten signatures from an image (JPG, GIF, PNG), like
//! Nitro's QuickSign: the picture is trimmed to the ink and its white paper
//! made transparent, so it sits on the page like real ink. It can be kept by
//! Stitchup (optionally locked with a password) for the next document.

import { toBase64 } from "./export";

import { tr } from "./i18n";

export interface PreparedSignature {
  /** PNG (base64) — what is stored. */
  png: string;
  /** Raw RGBA pixels (base64) — what is placed on the page. */
  rgba: string;
  width: number;
  height: number;
}

const MAX_SIDE = 1600; // plenty for a signature printed a few cm wide

function fromB64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function canvasPng(c: HTMLCanvasElement): Promise<string> {
  const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error(tr("encode failed")))), "image/png"));
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * Turn an image file (base64) into a signature: optionally make the white
 * background transparent (ink kept, soft edges preserved), then trim the
 * empty margins. Returns the PNG to store and the pixels to place.
 */
export async function prepareSignature(fileB64: string, removeWhite: boolean): Promise<PreparedSignature> {
  const bmp = await createImageBitmap(new Blob([fromB64(fileB64)]));
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  if (removeWhite) {
    // Paper (light) → transparent; ink keeps its colour. A soft ramp between
    // 175 and 235 luminance keeps anti-aliased pen edges smooth.
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const keep = Math.min(1, Math.max(0, (235 - lum) / 60));
      d[i + 3] = Math.round(d[i + 3] * keep);
    }
  }
  // Trim to the ink.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error(tr("the image looks empty — nothing darker than the paper was found"));
  const pad = Math.round(Math.max(w, h) * 0.01) + 2;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  ctx.putImageData(img, 0, 0);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  const octx = out.getContext("2d")!;
  octx.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  const px = octx.getImageData(0, 0, out.width, out.height).data;
  return { png: await canvasPng(out), rgba: toBase64(new Uint8Array(px.buffer)), width: out.width, height: out.height };
}

/** Pixels of a stored signature PNG, ready to place. */
export async function signatureFromPng(pngB64: string): Promise<PreparedSignature> {
  const bmp = await createImageBitmap(new Blob([fromB64(pngB64)], { type: "image/png" }));
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  return { png: pngB64, rgba: toBase64(new Uint8Array(px.buffer)), width: c.width, height: c.height };
}

/** Default width of a placed signature (points) — about 5.6 cm. */
export const SIGNATURE_WIDTH_PT = 160;
