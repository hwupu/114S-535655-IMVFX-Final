"use client";

import Link from "next/link";

interface Props {
  title: string;
  port: number;
  description: string;
  children: React.ReactNode;
}

export default function TestShell({ title, port, description, children }: Props) {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-start gap-4">
          <Link
            href="/test"
            className="mt-1 shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
          >
            ← Services
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{title}</h1>
              <span className="rounded-full bg-zinc-800 px-2.5 py-0.5 font-mono text-xs text-zinc-400">
                :{port}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-zinc-500">{description}</p>
          </div>
        </div>

        {children}
      </div>
    </main>
  );
}
