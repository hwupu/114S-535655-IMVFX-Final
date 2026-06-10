import Link from "next/link";

const SERVICES = [
  {
    slug: "instructpix2pix",
    name: "InstructPix2Pix",
    port: 8001,
    description: "Global style edit via text instruction",
    inputs: "Image + prompt",
    output: "Edited image",
    color: "indigo",
  },
  {
    slug: "pal4vst",
    name: "PAL4VST",
    port: 8006,
    description: "Direct Perceptual Artifacts Localization",
    inputs: "Image",
    output: "Mask image",
    color: "cyan", 
  },
  {
    slug: "fakevlm",
    name: "FakeVLM",
    port: 8005,
    description: "LLaVA-based real/fake image classifier",
    inputs: "Image",
    output: "Text verdict",
    color: "violet",
  },
  {
    slug: "qwen25vl",
    name: "Qwen2.5-VL",
    port: 8002,
    description: "Qwen2.5-VL-3B detects AI-generated visual artifacts",
    inputs: "Image",
    output: "Artifact list + boxes",
    color: "amber",
  },
  {
    slug: "grounded-sam",
    name: "Grounded-SAM",
    port: 8003,
    description: "Text-guided segmentation mask generation",
    inputs: "Image + artifact descriptions",
    output: "Mask image",
    color: "emerald",
  },
  {
    slug: "sd2",
    name: "SD2 Inpainting",
    port: 8004,
    description: "Text-guided local image repair",
    inputs: "Image + mask + prompt",
    output: "Repaired image",
    color: "rose",
  },
];

const colorMap: Record<string, string> = {
  indigo: "border-indigo-700/50 hover:border-indigo-500",
  violet: "border-violet-700/50 hover:border-violet-500",
  amber: "border-amber-700/50 hover:border-amber-500",
  emerald: "border-emerald-700/50 hover:border-emerald-500",
  rose: "border-rose-700/50 hover:border-rose-500",
  cyan: "border-cyan-700/50 hover:border-cyan-500",
};

const badgeMap: Record<string, string> = {
  indigo: "bg-indigo-900/50 text-indigo-300",
  violet: "bg-violet-900/50 text-violet-300",
  amber: "bg-amber-900/50 text-amber-300",
  emerald: "bg-emerald-900/50 text-emerald-300",
  rose: "bg-rose-900/50 text-rose-300",
  cyan: "bg-cyan-900/50 text-cyan-300",
};

export default function HomePage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
      <div className="mx-auto max-w-4xl space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">AI Artifact Repair</h1>
          <p className="mt-1 text-sm text-zinc-500">
            NYCU 535655 IMVFX Final · Choose a mode below
          </p>
        </div>

        {/* Pipeline cards */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/pipeline"
            className="group flex items-center justify-between rounded-xl border border-indigo-600/60 bg-indigo-950/40 p-6 transition-all hover:border-indigo-400 hover:bg-indigo-950/60"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold text-indigo-100 group-hover:text-white">
                  FakeVLM Pipeline
                </span>
                <span className="rounded-full bg-indigo-800/60 px-2.5 py-0.5 text-xs text-indigo-300">
                  Full pipeline
                </span>
              </div>
              <p className="text-sm text-indigo-300/70">
                InstructPix2Pix → FakeVLM → Grounded-SAM → SD2
              </p>
              <p className="text-xs text-zinc-500">
                Stage 2 uses FakeVLM (LLaVA-based text detection)
              </p>
            </div>
            <span className="ml-4 shrink-0 text-xl text-indigo-600 transition-colors group-hover:text-indigo-300">
              →
            </span>
          </Link>

          <Link
            href="/pipeline-qwen"
            className="group flex items-center justify-between rounded-xl border border-amber-600/60 bg-amber-950/40 p-6 transition-all hover:border-amber-400 hover:bg-amber-950/60"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold text-amber-100 group-hover:text-white">
                  Qwen2.5-VL Pipeline
                </span>
                <span className="rounded-full bg-amber-800/60 px-2.5 py-0.5 text-xs text-amber-300">
                  Full pipeline
                </span>
              </div>
              <p className="text-sm text-amber-300/70">
                InstructPix2Pix → Qwen2.5-VL → Grounded-SAM → SD2
              </p>
              <p className="text-xs text-zinc-500">
                Stage 2 uses Qwen2.5-VL-3B with bounding box output
              </p>
            </div>
            <span className="ml-4 shrink-0 text-xl text-amber-600 transition-colors group-hover:text-amber-300">
              →
            </span>
          </Link>

          <Link
            href="/pipeline-pal4vst"
            className="group flex items-center justify-between rounded-xl border border-cyan-600/60 bg-cyan-950/40 p-6 transition-all hover:border-cyan-400 hover:bg-cyan-950/60"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold text-cyan-100 group-hover:text-white">
                  PAL4VST Pipeline
                </span>
                <span className="rounded-full bg-cyan-800/60 px-2.5 py-0.5 text-xs text-cyan-300">
                  Full pipeline
                </span>
              </div>
              <p className="text-sm text-cyan-300/70">
                InstructPix2Pix → PAL4VST → SD2
              </p>
              <p className="text-xs text-zinc-500">
                Uses PAL4VST for artifact localization and mask generation
              </p>
            </div>
            <span className="ml-4 shrink-0 text-xl text-cyan-600 transition-colors group-hover:text-cyan-300">
              →
            </span>
          </Link>
        </div>

        {/* Service test pages */}
        <div>
          <h2 className="mb-3 text-sm font-medium text-zinc-400">
            Individual service tests
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {SERVICES.map((svc) => (
              <Link
                key={svc.slug}
                href={`/test/${svc.slug}`}
                className={[
                  "group rounded-xl border bg-zinc-900 p-5 transition-all hover:bg-zinc-800",
                  colorMap[svc.color],
                ].join(" ")}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-zinc-100 group-hover:text-white">
                        {svc.name}
                      </span>
                      <span
                        className={[
                          "rounded-full px-2 py-0.5 font-mono text-xs",
                          badgeMap[svc.color],
                        ].join(" ")}
                      >
                        :{svc.port}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-zinc-400">{svc.description}</p>
                  </div>
                  <span className="mt-0.5 shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-400">
                    →
                  </span>
                </div>
                <div className="mt-3 flex gap-4 text-xs text-zinc-500">
                  <span>
                    <span className="text-zinc-600">in: </span>
                    {svc.inputs}
                  </span>
                  <span>
                    <span className="text-zinc-600">out: </span>
                    {svc.output}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>

      </div>
    </main>
  );
}
