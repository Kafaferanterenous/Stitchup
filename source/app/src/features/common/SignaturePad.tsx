//! Draw a signature with the mouse, trackpad or pen (QuickSign ▸ Draw).
//! Strokes are smoothed (curves through the midpoints) and get thinner when
//! drawn fast, like ink. The canvas is transparent, so the result needs no
//! background removal.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface SignaturePadHandle {
  /** PNG (base64) of what was drawn, or null when empty. */
  png(): Promise<string | null>;
  clear(): void;
}

type Pt = { x: number; y: number; w: number };

export const INKS = [
  { label: "Black", color: "#111111" },
  { label: "Blue", color: "#13235e" },
];

export const SignaturePad = forwardRef<SignaturePadHandle, { ink: string; onChange?: (empty: boolean) => void }>(function SignaturePad({ ink, onChange }, ref) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const strokes = useRef<Pt[][]>([]);
  const cur = useRef<Pt[] | null>(null);
  const last = useRef<{ x: number; y: number; t: number } | null>(null);
  const [count, setCount] = useState(0);

  const W = 520;
  const H = 180;
  const dpr = typeof window !== "undefined" ? Math.max(1, Math.min(3, window.devicePixelRatio || 1)) : 1;

  function redraw() {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    g.setTransform(dpr * 2, 0, 0, dpr * 2, 0, 0); // drawn at 2× for a crisp signature
    g.clearRect(0, 0, W, H);
    g.strokeStyle = ink;
    g.fillStyle = ink;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const s of [...strokes.current, ...(cur.current ? [cur.current] : [])]) {
      if (s.length === 1) {
        g.beginPath();
        g.arc(s[0].x, s[0].y, s[0].w / 2, 0, Math.PI * 2);
        g.fill();
        continue;
      }
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1];
        const b = s[i];
        const p = s[i - 2] ?? a;
        // Quadratic through the midpoints → smooth curve.
        g.beginPath();
        g.lineWidth = (a.w + b.w) / 2;
        g.moveTo((p.x + a.x) / 2, (p.y + a.y) / 2);
        g.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
        g.stroke();
      }
    }
  }

  useEffect(redraw, [ink, count]);

  useImperativeHandle(ref, () => ({
    async png() {
      const c = canvas.current;
      if (!c || !strokes.current.length) return null;
      const blob: Blob | null = await new Promise((res) => c.toBlob(res, "image/png"));
      if (!blob) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    clear() {
      strokes.current = [];
      cur.current = null;
      setCount((n) => n + 1);
      onChange?.(true);
    },
  }));

  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  return (
    <canvas
      ref={canvas}
      className="sig-pad"
      aria-label="Draw your signature here"
      width={W * dpr * 2}
      height={H * dpr * 2}
      style={{ width: "100%", aspectRatio: `${W} / ${H}`, touchAction: "none" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = pos(e);
        last.current = { ...p, t: performance.now() };
        cur.current = [{ ...p, w: 3.2 }];
        redraw();
      }}
      onPointerMove={(e) => {
        if (!cur.current || !last.current) return;
        const p = pos(e);
        const now = performance.now();
        const dist = Math.hypot(p.x - last.current.x, p.y - last.current.y);
        if (dist < 0.8) return;
        const speed = dist / Math.max(1, now - last.current.t); // px per ms
        const pressure = e.pressure > 0 && e.pointerType === "pen" ? e.pressure : 0.5;
        const target = Math.max(1.4, Math.min(4.2, 4.4 - speed * 1.6)) * (0.7 + pressure * 0.6);
        const prev = cur.current[cur.current.length - 1].w;
        cur.current.push({ ...p, w: prev * 0.6 + target * 0.4 });
        last.current = { ...p, t: now };
        redraw();
      }}
      onPointerUp={() => {
        if (cur.current) strokes.current.push(cur.current);
        cur.current = null;
        last.current = null;
        setCount((n) => n + 1);
        onChange?.(false);
      }}
      onPointerCancel={() => {
        cur.current = null;
        redraw();
      }}
    />
  );
});
