const PORTS = {
  instructpix2pix: 8001,
  qwen25vl: 8002,
  grounded_sam: 8003,
  sd2: 8004,
  fakevlm: 8005,
} as const;

type ServiceName = keyof typeof PORTS;

function url(service: ServiceName, route: string) {
  return `http://127.0.0.1:${PORTS[service]}${route}`;
}

export interface JobStatus {
  status: "pending" | "running" | "done" | "error";
  progress: number;
  result_path?: string;
  result?: unknown;
  detail?: string;
}

export async function submitJob(service: ServiceName, body: object): Promise<string> {
  const res = await fetch(url(service, "/infer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${service}: submit failed (${res.status})`);
  const data = await res.json();
  return data.job_id as string;
}

export async function pollJob(service: ServiceName, jobId: string): Promise<JobStatus> {
  const res = await fetch(url(service, `/jobs/${jobId}`));
  if (!res.ok) throw new Error(`${service}: poll failed (${res.status})`);
  return res.json() as Promise<JobStatus>;
}

export async function abortJob(service: ServiceName, jobId: string): Promise<void> {
  await fetch(url(service, `/jobs/${jobId}`), { method: "DELETE" });
}

export async function checkHealth(service: ServiceName): Promise<boolean> {
  try {
    const res = await fetch(url(service, "/health"), {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
