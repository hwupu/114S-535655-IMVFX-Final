"use client";

import { useRef, useEffect, useState, useCallback } from "react";

interface Props {
  baseImageUrl: string;
  maskUrl: string;        // white = masked area (binary PNG); 1×1 transparent PNG for blank start
  onMaskChange: (blob: Blob) => void;
}

export default function MaskCanvas({ baseImageUrl, maskUrl, onMaskChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [brushSize, setBrushSize] = useState(20);
  const [mode, setMode] = useState<"draw" | "erase">("draw");
  const painting = useRef(false);
  const [loaded, setLoaded] = useState(false);
  // Aspect ratio of the source image — drives container sizing so canvas + overlay always match
  const [imgAspect, setImgAspect] = useState<number | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [visualBrushR, setVisualBrushR] = useState(20);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    setLoaded(false);
    setImgAspect(null);

    const base = new Image();
    base.crossOrigin = "anonymous";
    base.src = baseImageUrl;
    base.onload = () => {
      const w = base.naturalWidth;
      const h = base.naturalHeight;

      canvas.width = w;
      canvas.height = h;
      overlay.width = w;
      overlay.height = h;

      canvas.getContext("2d")!.drawImage(base, 0, 0);

      // Set aspect ratio before showing the mask so the container is already the right size
      setImgAspect(w / h);

      const maskImg = new Image();
      maskImg.crossOrigin = "anonymous";
      maskImg.src = maskUrl;
      maskImg.onload = () => {
        const mCtx = overlay.getContext("2d")!;
        mCtx.clearRect(0, 0, w, h);

        // Convert white pixels of the incoming mask to red on the overlay canvas.
        // White + multiply blend-mode was invisible; red at 55 % opacity is clearly visible.
        const tmp = document.createElement("canvas");
        tmp.width = w;
        tmp.height = h;
        const tCtx = tmp.getContext("2d")!;
        tCtx.drawImage(maskImg, 0, 0, w, h);
        const src = tCtx.getImageData(0, 0, w, h);
        const dst = mCtx.createImageData(w, h);
        for (let i = 0; i < src.data.length; i += 4) {
          if (src.data[i + 3] > 0 && src.data[i] > 127) {
            dst.data[i]     = 255;
            dst.data[i + 1] = 50;
            dst.data[i + 2] = 50;
            dst.data[i + 3] = 255;
          }
        }
        mCtx.putImageData(dst, 0, 0);

        setLoaded(true);
        exportMask();
      };
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseImageUrl, maskUrl]);

  // Export: red overlay → binary white/black mask PNG expected by the inpainting service
  const exportMask = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const tmp = document.createElement("canvas");
    tmp.width = overlay.width;
    tmp.height = overlay.height;
    const tCtx = tmp.getContext("2d")!;
    tCtx.fillStyle = "black";
    tCtx.fillRect(0, 0, tmp.width, tmp.height);

    const src = overlay.getContext("2d")!.getImageData(0, 0, overlay.width, overlay.height);
    const dst = tCtx.getImageData(0, 0, tmp.width, tmp.height);
    for (let i = 0; i < src.data.length; i += 4) {
      if (src.data[i + 3] > 0) {
        dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = dst.data[i + 3] = 255;
      }
    }
    tCtx.putImageData(dst, 0, 0);
    tmp.toBlob((blob) => { if (blob) onMaskChange(blob); }, "image/png");
  }, [onMaskChange]);

  // Convert a CSS-space mouse event on the overlay into canvas pixel coordinates + visual brush radius
  const canvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width > 0 ? e.currentTarget.width / rect.width : 1;
    const scaleY = e.currentTarget.height > 0 ? e.currentTarget.height / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
      cssX: e.clientX - rect.left,
      cssY: e.clientY - rect.top,
      cssR: brushSize / scaleX,
    };
  };

  const paint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y, cssX, cssY, cssR } = canvasCoords(e);
    setCursorPos({ x: cssX, y: cssY });
    setVisualBrushR(cssR);

    if (!painting.current || !loaded) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const mCtx = overlay.getContext("2d")!;

    mCtx.beginPath();
    if (mode === "draw") {
      mCtx.globalCompositeOperation = "source-over";
      mCtx.fillStyle = "rgba(255, 50, 50, 1)";
    } else {
      mCtx.globalCompositeOperation = "destination-out";
      mCtx.fillStyle = "rgba(0,0,0,1)";
    }
    mCtx.arc(x, y, brushSize, 0, Math.PI * 2);
    mCtx.fill();
    mCtx.globalCompositeOperation = "source-over";
  };

  const stopPainting = () => {
    if (painting.current) {
      painting.current = false;
      exportMask();
    }
  };

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex gap-2">
          {(["draw", "erase"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={[
                "rounded px-3 py-1 text-xs font-medium capitalize transition-colors",
                mode === m ? "bg-indigo-600 text-white" : "bg-zinc-700 text-zinc-300 hover:bg-zinc-600",
              ].join(" ")}
            >
              {m}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Brush size
          <input
            type="range" min={5} max={80} value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-24 accent-indigo-500"
          />
          <span className="w-6 text-right">{brushSize}</span>
        </label>
      </div>

      {/*
        Canvas container.

        The container is sized by CSS aspect-ratio (set once the image loads) plus
        maxHeight: 500px. This means:
          - Landscape image: fills full width, height = width / aspect (≤ 500 px).
          - Portrait image: height is capped at 500 px, width shrinks to 500 * aspect.

        Both canvases fill the container (w-full h-full / inset-0), so they are
        always pixel-perfectly aligned regardless of the source image dimensions.
      */}
      <div
        className="relative overflow-hidden rounded-lg border border-zinc-700"
        style={{
          cursor: "none",
          aspectRatio: imgAspect !== null ? String(imgAspect) : undefined,
          maxHeight: 500,
        }}
        onMouseLeave={() => setCursorPos(null)}
      >
        {/* Base image canvas — pixel buffer = natural size, CSS fills container */}
        <canvas ref={canvasRef} className="block w-full h-full" />

        {/* Red mask overlay — same container bounds as base canvas */}
        <canvas
          ref={overlayRef}
          className="absolute inset-0 w-full h-full"
          style={{ opacity: 0.55 }}
          onMouseDown={(e) => { painting.current = true; paint(e); }}
          onMouseMove={paint}
          onMouseUp={stopPainting}
          onMouseLeave={() => { stopPainting(); setCursorPos(null); }}
        />

        {/* Brush cursor circle */}
        {cursorPos && (
          <div
            className="pointer-events-none absolute rounded-full border border-white"
            style={{
              width: visualBrushR * 2,
              height: visualBrushR * 2,
              left: cursorPos.x - visualBrushR,
              top: cursorPos.y - visualBrushR,
            }}
          />
        )}
      </div>

      <p className="text-xs text-zinc-500">
        Red areas will be inpainted. Draw to add, erase to remove.
      </p>
    </div>
  );
}
