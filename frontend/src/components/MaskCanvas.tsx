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
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [visualBrushR, setVisualBrushR] = useState(20); // CSS-pixel radius for cursor circle

  // Load base image + mask into canvases
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    setLoaded(false);

    const base = new Image();
    base.crossOrigin = "anonymous";
    base.src = baseImageUrl;
    base.onload = () => {
      canvas.width = base.naturalWidth;
      canvas.height = base.naturalHeight;
      overlay.width = base.naturalWidth;
      overlay.height = base.naturalHeight;

      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(base, 0, 0);

      const maskImg = new Image();
      maskImg.crossOrigin = "anonymous";
      maskImg.src = maskUrl;
      maskImg.onload = () => {
        const mCtx = overlay.getContext("2d")!;
        mCtx.clearRect(0, 0, overlay.width, overlay.height);

        // Convert white pixels of the source mask to red on the overlay so they
        // are visible (white with the old multiply blend mode was invisible).
        const tmp = document.createElement("canvas");
        tmp.width = overlay.width;
        tmp.height = overlay.height;
        const tCtx = tmp.getContext("2d")!;
        tCtx.drawImage(maskImg, 0, 0, overlay.width, overlay.height);
        const src = tCtx.getImageData(0, 0, overlay.width, overlay.height);
        const dst = mCtx.createImageData(overlay.width, overlay.height);
        for (let i = 0; i < src.data.length; i += 4) {
          if (src.data[i + 3] > 0 && src.data[i] > 127) {
            dst.data[i]     = 255; // R
            dst.data[i + 1] = 50;  // G
            dst.data[i + 2] = 50;  // B
            dst.data[i + 3] = 255; // A
          }
          // transparent otherwise
        }
        mCtx.putImageData(dst, 0, 0);
        setLoaded(true);
        exportMask();
      };
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseImageUrl, maskUrl]);

  // Export: convert red overlay → binary white/black mask PNG for the inpainting service
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
        dst.data[i]     = 255;
        dst.data[i + 1] = 255;
        dst.data[i + 2] = 255;
        dst.data[i + 3] = 255;
      }
      // else: stays black (already filled)
    }
    tCtx.putImageData(dst, 0, 0);
    tmp.toBlob((blob) => { if (blob) onMaskChange(blob); }, "image/png");
  }, [onMaskChange]);

  const getCanvasPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width > 0 ? e.currentTarget.width / rect.width : 1;
    const scaleY = e.currentTarget.height > 0 ? e.currentTarget.height / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
      cssRadiusX: brushSize / scaleX, // visual radius in CSS pixels
    };
  };

  const updateCursor = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { cssRadiusX } = getCanvasPos(e);
    setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setVisualBrushR(cssRadiusX);
  };

  const paint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    updateCursor(e);
    if (!painting.current || !loaded) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const mCtx = overlay.getContext("2d")!;
    const { x, y } = getCanvasPos(e);

    mCtx.beginPath();
    if (mode === "draw") {
      mCtx.globalCompositeOperation = "source-over";
      mCtx.fillStyle = "rgba(255, 50, 50, 1)"; // solid red — converted to white on export
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

      {/* Canvas stack */}
      <div
        className="relative overflow-hidden rounded-lg border border-zinc-700"
        style={{ maxHeight: 500, cursor: "none" }}
        onMouseLeave={() => setCursorPos(null)}
      >
        {/* Base image */}
        <canvas ref={canvasRef} className="block w-full" />

        {/* Red mask overlay — opacity blends with base image */}
        <canvas
          ref={overlayRef}
          className="absolute inset-0 w-full h-full"
          style={{ opacity: 0.55 }}
          onMouseDown={(e) => { painting.current = true; paint(e); }}
          onMouseMove={paint}
          onMouseUp={stopPainting}
          onMouseLeave={() => { stopPainting(); setCursorPos(null); }}
        />

        {/* Brush size cursor circle */}
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
