import path from "path";

// Next.js runs npm from the frontend/ dir, so cwd = frontend/
export const PROJECT_ROOT = path.resolve(process.cwd(), "..");
export const WORKSPACE = path.join(PROJECT_ROOT, "workspace");
