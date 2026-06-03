// Module-level shared state for the local single-user pipeline.
// API routes in the same Next.js server process share this module instance.

export const abortFlags = new Map<string, boolean>();
export const activeJobs = new Map<string, { service: string; jobId: string }>();
export const sessionArtifacts = new Map<string, string[]>();
