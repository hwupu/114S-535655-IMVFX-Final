"use client";

interface Props {
  originalUrl: string | null;
  maskUrl: string | null;
  resultUrl: string | null;
  stage1Url: string | null;
}

function Panel({ label, url }: { label: string; url: string | null }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-center text-xs font-medium text-zinc-400 uppercase tracking-wider">{label}</p>
      <div className="aspect-square w-full overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 flex items-center justify-center">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="h-full w-full object-contain" />
        ) : (
          <span className="text-xs text-zinc-600">—</span>
        )}
      </div>
    </div>
  );
}

export default function ResultPanel({ originalUrl, maskUrl, resultUrl, stage1Url }: Props) {
  const hasResult = resultUrl || stage1Url;
  if (!originalUrl && !hasResult) return null;

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 space-y-3">
      <h3 className="text-sm font-semibold text-zinc-200">Results</h3>
      <div className="grid grid-cols-3 gap-3">
        <Panel label="Original" url={originalUrl} />
        <Panel label="Mask" url={maskUrl} />
        <Panel label="Result" url={resultUrl ?? stage1Url} />
      </div>
    </div>
  );
}
