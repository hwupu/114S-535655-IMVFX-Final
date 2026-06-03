"use client";

import { useRef, useEffect, useState, useCallback } from "react";

interface Props {
  baseImageUrl: string;    // stage1 output — shown as background
  maskUrl: string;         // stage3 mask — white = masked area
  onMaskChange: (blob: Blob) => void;
}

export default function MaskCanvas({ baseImageUrl, maskUrl, onMaskChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null); // mask layer
  const [brushSize, setBrushSize] = useState(20);
  const [mode, setMode] = useState<"draw" | "erase">("draw");
  const painting = useRef(false);
  const [loaded, setLoaded] = useState(false);

  // Load base image + mask into canvases
  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;

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
        mCtx.drawImage(maskImg, 0, 0);
        setLoaded(true);
        exportMask();
      };
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseImageUrl, maskUrl]);

  const exportMask = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.toBlob((blob) => { if (blob) onMaskChange(blob); }, "image/png");
  }, [onMaskChange]);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width / rect.width;
    const scaleY = e.currentTarget.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const paint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!painting.current || !loaded) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const mCtx = overlay.getContext("2d")!;
    const { x, y } = getPos(e);

    mCtx.beginPath();
    if (mode === "draw") {
      mCtx.globalCompositeOperation = "source-over";
      mCtx.fillStyle = "white";
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
        className="relative overflow-hidden rounded-lg border border-zinc-700 cursor-crosshair"
        style={{ maxHeight: 500 }}
      >
        {/* Base image */}
        <canvas ref={canvasRef} className="block w-full" />
        {/* Mask overlay — semi-transparent red */}
        <canvas
          ref={overlayRef}
          className="absolute inset-0 w-full h-full"
          style={{ opacity: 0.5, mixBlendMode: "multiply" }}
          onMouseDown={(e) => { painting.current = true; paint(e); }}
          onMouseMove={paint}
          onMouseUp={stopPainting}
          onMouseLeave={stopPainting}
        />
      </div>
      <p className="text-xs text-zinc-500">
        White areas will be inpainted. Draw to add, erase to remove.
      </p>
    </div>
  );
}
