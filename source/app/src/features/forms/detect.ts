//! Detect Fields: find the places on a flat (non-fillable) form where a
//! field belongs, so the user can turn them into real fields in one go.
//!
//! The page is rendered to a bitmap and searched for:
//!  - hollow boxes (empty rectangles)  → text field, or multi-line if tall;
//!  - small hollow squares             → check box;
//!  - small hollow circles             → radio button (grouped by row/column);
//!  - blank lines / underscores        → text field sitting on the line.
//! Each suggestion is named after the nearest label text. Working on pixels
//! means it does not matter how the PDF draws them (paths, images, glyphs).

import type { RenderSession } from "../../adapters/renderAdapter";

export type SuggestKind = "text" | "multiline" | "checkbox" | "radio";

export interface Suggestion {
  page: number;
  kind: SuggestKind;
  /** Field name (radio: the group's name). */
  name: string;
  /** Radio: this button's value. */
  value?: string;
  /** PDF user space [x0, y0, x1, y1]. */
  rect: number[];
  /** Included when the user accepts (click a suggestion to toggle). */
  on: boolean;
}

/** A label word/phrase on the page, in points from the top-left. */
export interface TextBox {
  str: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A candidate in points from the top-left (before naming). */
export interface Found {
  kind: SuggestKind;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  name: string;
  value?: string;
}

const SCALE = 2; // pixels per point for the scan

/**
 * Find field candidates in a rendered page.
 * `ink` is 1 for dark pixels, `w`×`h` pixels at `scale` px/pt; `texts` and
 * `taken` (existing fields) are in points from the top-left.
 */
export function detectInMask(ink: Uint8Array, w: number, h: number, scale: number, texts: TextBox[], taken: TextBox[] = []): Found[] {
  const pt = (px: number) => px / scale;
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? ink[y * w + x] : 0);

  // Summed-area table: ink count of any box in O(1).
  const sat = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += ink[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const inkIn = (x0: number, y0: number, x1: number, y1: number) => {
    x0 = Math.max(0, Math.min(w, Math.round(x0)));
    x1 = Math.max(0, Math.min(w, Math.round(x1)));
    y0 = Math.max(0, Math.min(h, Math.round(y0)));
    y1 = Math.max(0, Math.min(h, Math.round(y1)));
    if (x1 <= x0 || y1 <= y0) return 0;
    const W = w + 1;
    return sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
  };

  // Connected components (8-neighbour) → bounding boxes.
  const label = new Int32Array(w * h);
  const comps: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!ink[i] || label[i]) continue;
    const c = { x0: w, y0: h, x1: -1, y1: -1, n: 0 };
    comps.push(c);
    const id = comps.length;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w;
      const y = (j - x) / w;
      c.n++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const k = yy * w + xx;
          if (ink[k] && !label[k]) {
            label[k] = id;
            stack.push(k);
          }
        }
      }
    }
  }

  const wordy = (t: TextBox) => /[\p{L}\p{N}]/u.test(t.str);
  const overlap = (a: TextBox, b: { x0: number; y0: number; x1: number; y1: number }) =>
    Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  // Is this candidate (points) really a letter ("O", "D", "□" in a word…)?
  const onText = (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    return texts.some((t) => wordy(t) && overlap(t, b) > 0.3 * area);
  };
  const onField = (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    return taken.some((t) => overlap(t, b) > 0.3 * area);
  };

  const found: Found[] = [];
  const pageW = pt(w);
  // Typical label size: boxes are judged against it (big Canva labels mean
  // big boxes and check boxes).
  const sizes = texts.filter(wordy).map((t) => t.y1 - t.y0).sort((a, b) => a - b);
  const em = sizes.length ? sizes[sizes.length >> 1] : 11;
  const maxMark = Math.max(28, 1.6 * em); // largest check box / radio button
  const tallText = Math.max(36, 2.6 * em); // taller boxes are multi-line
  for (const c of comps) {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    const W = pt(cw);
    const H = pt(ch);
    const box = { x0: pt(c.x0), y0: pt(c.y0), x1: pt(c.x1 + 1), y1: pt(c.y1 + 1) };

    // A blank line: thin, long, nothing written just above it.
    if (H <= 3 && W >= 36 && W < 0.8 * pageW) {
      let up = 0; // empty space above, in px (≤ 20 pt)
      const lim = Math.round(20 * scale);
      while (up < lim && inkIn(c.x0, c.y0 - up - 1, c.x1 + 1, c.y0 - up) <= cw * 0.01) up++;
      if (up >= 10 * scale) {
        const f = { x0: box.x0, y0: box.y0 - pt(up) + 1, x1: box.x1, y1: box.y0 };
        if (!onField(f)) found.push({ kind: "text", ...f, name: "" });
      }
      continue;
    }
    if (W < 6 || H < 6) continue;

    // How much of each edge band is inked (outline check).
    const band = Math.max(2, Math.round(Math.min(3 * scale, cw / 5, ch / 5)));
    const edge = (horizontal: boolean, fromEnd: boolean) => {
      let hit = 0;
      const len = horizontal ? cw : ch;
      for (let i = 0; i < len; i++) {
        let any = 0;
        for (let k = 0; k < band && !any; k++) {
          const x = horizontal ? c.x0 + i : fromEnd ? c.x1 - k : c.x0 + k;
          const y = horizontal ? (fromEnd ? c.y1 - k : c.y0 + k) : c.y0 + i;
          any = at(x, y);
        }
        hit += any;
      }
      return hit / len;
    };
    // Nothing drawn inside (the inside of a box, or the middle of a circle).
    const emptyInside = (ix: number, iy: number) =>
      inkIn(c.x0 + ix, c.y0 + iy, c.x1 + 1 - ix, c.y1 + 1 - iy) <= Math.max(1, (cw - 2 * ix) * (ch - 2 * iy)) * 0.004;
    const ib = band + 1; // clear of the border

    const square = Math.abs(W - H) <= 0.2 * Math.max(W, H);
    const sides = [edge(true, false), edge(true, true), edge(false, false), edge(false, true)];
    const isRect = sides.every((s) => s >= 0.9) && emptyInside(ib, ib);
    if (square && W <= maxMark) {
      if (onText(box) || onField(box)) continue;
      if (isRect) {
        found.push({ kind: "checkbox", ...box, name: "" });
        continue;
      }
      // Circle: sides touched only around their middle, corners empty.
      const k = Math.max(1, Math.round(Math.min(cw, ch) * 0.1));
      const corners = inkIn(c.x0, c.y0, c.x0 + k, c.y0 + k) + inkIn(c.x1 + 1 - k, c.y0, c.x1 + 1, c.y0 + k) +
        inkIn(c.x0, c.y1 + 1 - k, c.x0 + k, c.y1 + 1) + inkIn(c.x1 + 1 - k, c.y1 + 1 - k, c.x1 + 1, c.y1 + 1);
      const mids = at(c.x0 + (cw >> 1), c.y0) + at(c.x0 + (cw >> 1), c.y1) + at(c.x0, c.y0 + (ch >> 1)) + at(c.x1, c.y0 + (ch >> 1));
      const mid = Math.round(Math.min(cw, ch) * 0.25) + 1; // a circle's middle square
      if (corners <= 2 && mids >= 3 && sides.every((s) => s >= 0.25) && emptyInside(mid, mid)) found.push({ kind: "radio", ...box, name: "" });
      continue;
    }
    if (isRect && W >= 30 && H >= 10 && W < 0.95 * pageW && !onField(box)) {
      found.push({ kind: H >= tallText ? "multiline" : "text", ...box, name: "" });
    }
  }

  nameAll(found, texts);
  return found;
}

// ---------------------------------------------------------------- labels

const clean = (s: string) =>
  s.replace(/[_.…]{2,}/g, " ").replace(/\s+/g, " ").replace(/[\s:*_]+$/u, "").replace(/^[\s:*•·-]+/u, "").trim().slice(0, 40).trim();

/** Words on one line, left to right, joined into phrases (gap < 1.2 em). */
function phrases(texts: TextBox[]): TextBox[] {
  const items = texts.filter((t) => t.str.trim() && t.y1 > t.y0).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const out: TextBox[] = [];
  for (const t of items) {
    const hgt = t.y1 - t.y0;
    const prev = out.find((p) => {
      const vo = Math.min(p.y1, t.y1) - Math.max(p.y0, t.y0);
      return vo > 0.5 * Math.min(hgt, p.y1 - p.y0) && t.x0 >= p.x1 - 1 && t.x0 - p.x1 < 1.2 * hgt;
    });
    if (prev) {
      prev.str += (t.x0 - prev.x1 > 0.15 * hgt && !prev.str.endsWith(" ") ? " " : "") + t.str;
      prev.x1 = Math.max(prev.x1, t.x1);
      prev.y0 = Math.min(prev.y0, t.y0);
      prev.y1 = Math.max(prev.y1, t.y1);
    } else out.push({ ...t });
  }
  return out.filter((p) => clean(p.str));
}

function nameAll(found: Found[], texts: TextBox[]) {
  const ph = phrases(texts);
  const sameLine = (t: TextBox, f: Found) => {
    const cy = (f.y0 + f.y1) / 2;
    return cy >= t.y0 - 3 && cy <= t.y1 + 3;
  };
  const left = (f: Found, max: number) =>
    ph.filter((t) => sameLine(t, f) && t.x1 <= f.x0 + 2 && f.x0 - t.x1 < max).sort((a, b) => b.x1 - a.x1)[0];
  const right = (f: Found, max: number) =>
    ph.filter((t) => sameLine(t, f) && t.x0 >= f.x1 - 2 && t.x0 - f.x1 < max).sort((a, b) => a.x0 - b.x0)[0];
  const above = (f: Found, max: number) =>
    ph
      .filter((t) => t.y1 <= f.y0 + 2 && f.y0 - t.y1 < max && t.x0 < f.x1 && t.x1 > f.x0 - 40)
      .sort((a, b) => b.y1 - a.y1 || Math.abs(a.x0 - f.x0) - Math.abs(b.x0 - f.x0))[0];

  const count: Record<string, number> = {};
  const fallback = (base: string) => `${base} ${(count[base] = (count[base] ?? 0) + 1)}`;

  for (const f of found) {
    if (f.kind === "radio") continue;
    let lab: TextBox | undefined;
    if (f.kind === "checkbox") {
      const l = left(f, 120);
      const r = right(f, 40);
      lab = l && r ? (f.x0 - l.x1 <= r.x0 - f.x1 ? l : r) : l ?? r;
    } else lab = left(f, 200) ?? above(f, 24);
    f.name = (lab && clean(lab.str)) || fallback(f.kind === "checkbox" ? "Check Box" : "Text");
  }

  // Radio buttons: group the ones in a row (or column), name the group from
  // the label left of / above it, and each button from the label on its right.
  const radios = found.filter((f) => f.kind === "radio");
  const parent = radios.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < radios.length; i++) {
    for (let j = i + 1; j < radios.length; j++) {
      const a = radios[i];
      const b = radios[j];
      const sameRow = Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) < 4 && Math.abs(a.x0 - b.x0) < 260;
      const sameCol = Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) < 4 && Math.abs(a.y0 - b.y0) < 40;
      if (sameRow || sameCol) parent[root(i)] = root(j);
    }
  }
  const groups = new Map<number, Found[]>();
  radios.forEach((r, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), r]));
  for (const members of groups.values()) {
    members.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const first = members[0];
    const gb: Found = { ...first, x0: Math.min(...members.map((m) => m.x0)), x1: Math.max(...members.map((m) => m.x1)), y1: Math.max(...members.map((m) => m.y1)) };
    // A label to the left on the first row, unless it is another button's answer.
    const l = left(first, 160);
    const lab = l && !members.some((m) => m !== first && right(m, 40) === l) ? l : above(gb, 28);
    const name = (lab && clean(lab.str)) || fallback("Choice");
    const used = new Set<string>();
    members.forEach((m, k) => {
      const r = right(m, 40);
      let v = (r && clean(r.str)) || `Choice ${k + 1}`;
      while (used.has(v)) v += "+";
      used.add(v);
      m.name = name;
      m.value = v;
    });
  }
}

// ---------------------------------------------------------------- page scan

/** Scan one page; `taken` are existing field rects (PDF user space). */
export async function detectPage(session: RenderSession, pageNo: number, taken: number[][]): Promise<Suggestion[]> {
  const page = await session.pdf.getPage(pageNo);
  const vp = page.getViewport({ scale: SCALE, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Without form widgets / annotations: only what is printed on the page.
  await page.render({ canvasContext: ctx, viewport: vp, annotationMode: 0 }).promise;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const ink = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < ink.length; i += 4, j++) {
    ink[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 215 ? 1 : 0;
  }
  canvas.width = canvas.height = 0;

  // Text boxes in points from the top-left.
  const toTop = (x: number, y: number) => {
    const [px, py] = vp.convertToViewportPoint(x, y);
    return [px / SCALE, py / SCALE];
  };
  const box = (r: number[]): TextBox => {
    const [ax, ay] = toTop(r[0], r[1]);
    const [bx, by] = toTop(r[2], r[3]);
    return { str: "", x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  };
  const tc = await page.getTextContent();
  const texts: TextBox[] = [];
  for (const it of tc.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
    if (!it.str || !it.transform) continue;
    const [a, b, , , e, f] = it.transform;
    const size = Math.hypot(a, b) || it.height || 10;
    const angle = Math.atan2(b, a);
    if (Math.abs(angle) > 0.05) continue; // labels are upright
    const t = box([e, f - 0.22 * size, e + (it.width ?? 0), f + 0.8 * size]);
    t.str = it.str;
    texts.push(t);
  }

  const found = detectInMask(ink, width, height, SCALE, texts, taken.map(box));
  return found.map((f) => {
    const [ax, ay] = vp.convertToPdfPoint(f.x0 * SCALE, f.y1 * SCALE);
    const [bx, by] = vp.convertToPdfPoint(f.x1 * SCALE, f.y0 * SCALE);
    const r = (v: number) => Math.round(v * 100) / 100;
    return {
      page: pageNo,
      kind: f.kind,
      name: f.name,
      value: f.value,
      rect: [r(Math.min(ax, bx)), r(Math.min(ay, by)), r(Math.max(ax, bx)), r(Math.max(ay, by))],
      on: true,
    };
  });
}
