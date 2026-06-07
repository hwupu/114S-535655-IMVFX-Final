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
    slug: "fakevlm",
    name: "FakeVLM",
    port: 8005,
    description: "LLaVA-based real/fake image classifier",
    inputs: "Image",
    output: "Text verdict",
    color: "violet",
  },
  {
    slug: "artifact-detector",
    name: "Artifact Detector",
    port: 8002,
    description: "Qwen2-VL detects AI-generated visual artifacts",
    inputs: "Image",
    output: "Artifact list",
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
    slug: "inpainting",
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
};

const badgeMap: Record<string, string> = {
  indigo: "bg-indigo-900/50 text-indigo-300",
  violet: "bg-violet-900/50 text-violet-300",
  amber: "bg-amber-900/50 text-amber-300",
  emerald: "bg-emerald-900/50 text-emerald-300",
  rose: "bg-rose-900/50 text-rose-300",
};

export default function TestIndexPage() {
  return (
    <main className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Service Test Pages</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Test each model microservice independently
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
          >
            ← Main Pipeline
          </Link>
        </div>

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
    </main>
  );
}
