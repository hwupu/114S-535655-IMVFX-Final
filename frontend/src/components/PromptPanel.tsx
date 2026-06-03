"use client";

import { PROMPT_SUGGESTIONS } from "@/lib/types";

interface Props {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

export default function PromptPanel({ value, onChange, disabled }: Props) {
  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-zinc-300">Edit instruction</label>
      <div className="flex flex-wrap gap-2">
        {PROMPT_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onChange(s)}
            className={[
              "rounded-full border px-3 py-1 text-xs transition-colors",
              value === s
                ? "border-indigo-500 bg-indigo-600 text-white"
                : "border-zinc-600 text-zinc-400 hover:border-zinc-400 hover:text-zinc-200",
              disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
            ].join(" ")}
          >
            {s}
          </button>
        ))}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Or type your own instruction…"
        rows={2}
        className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
