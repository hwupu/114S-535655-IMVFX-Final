# AI Artifact Repair Pipeline

**NYCU 535655 — Image Manipulation Techniques and Visual Effects**  
Final Project · 114S-535655-IMVFX-Final

---

## Overview

This project implements a multi-stage image manipulation pipeline designed to repair AI-generated artifacts. A user provides a photo and a text instruction; the system performs a global style edit and then automatically detects and heals any visual defects introduced by the generative model — extra fingers, deformed faces, unnatural textures, and so on — using a chain of specialized AI models.

The entire pipeline is orchestrated by a Next.js web interface. Each AI model runs as an isolated FastAPI microservice managed by `uv`, allowing each service to have its own Python version and dependency set.

---

## Pipeline Design

```
User photo + instruction
        │
        ▼
┌───────────────────────┐
│  Stage 1              │  InstructPix2Pix
│  Global Style Edit    │  timbrooks/instruct-pix2pix
└───────────┬───────────┘
            │  intermediate image
            ▼
┌───────────────────────┐
│  Stage 2              │  FakeVLM (lingcco/fakeVLM)
│  Artifact Detection   │  LLaVA-based multimodal VLM
└───────────┬───────────┘
            │
     ┌──────┴──────┐
     │ no artifacts│  → Pipeline complete (return Stage 1 output)
     │ found       │
     └──────┬──────┘
            │ artifact descriptions (text)
            ▼
┌───────────────────────┐
│  Stage 3              │  Grounded-SAM
│  Mask Generation      │  Grounding DINO + SAM
└───────────┬───────────┘
            │  binary mask PNG
            ▼
    ┌───────────────┐
    │  Mask Review  │  ← User may draw on mask with a brush
    └───────┬───────┘
            │
            ▼
┌───────────────────────┐
│  Stage 4              │  Stable Diffusion 2 Inpainting
│  Local Inpainting     │  sd2-community/stable-diffusion-2-inpainting
└───────────┬───────────┘
            │
            ▼
       Final image
```

### Stage 1 — Global Style Edit (InstructPix2Pix)

**Model:** `timbrooks/instruct-pix2pix` via HuggingFace `diffusers`  
**Port:** 8001 · Python 3.10

InstructPix2Pix is an instruction-following image editing model trained on paired (before, after, instruction) triplets. Given a source image and a natural-language instruction such as "make it look like a painting" or "apply cinematic color grading", the model edits the image globally while preserving its structure.

This stage is intentionally a *global* transformation. Because diffusion-based editing can introduce subtle artifacts — anatomically incorrect features, blended textures, misaligned geometry — the output of this stage is treated as an *intermediate* result that feeds into the artifact detection and repair chain.

**Key parameters:**
- `num_inference_steps=50` — balances quality and speed
- `image_guidance_scale=1.5` — how much the output follows the original image structure
- `guidance_scale=7.5` — how strictly the edit instruction is followed

The input image is resized to 512×512 before inference (the model's native resolution) and scaled back to the original size afterward to avoid OOM on high-resolution inputs.

---

### Stage 2 — Artifact Detection (FakeVLM)

**Model:** `lingcco/fakeVLM` via HuggingFace `transformers`  
**Port:** 8005 · Python 3.11

FakeVLM (Wen et al., NeurIPS 2025) is a LLaVA-based multimodal model trained specifically for synthetic image detection and artifact explanation. In the pipeline it is prompted to enumerate specific visual defects rather than return a binary verdict:

```
<image>List any visual artifacts in this image, such as extra fingers,
deformed faces, unnatural textures, or asymmetric features.
If the image looks correct and realistic, reply with exactly: NO_ARTIFACTS
```

If the image is clean the model replies `NO_ARTIFACTS` and the pipeline terminates early (no mask generation or inpainting needed). Otherwise the response is split into per-artifact descriptions:

```
extra fingers on right hand
deformed facial geometry around the left eye
uneven fill pattern on the background wall
```

These descriptions are passed directly to Stage 3 as text grounding queries for GroundingDINO.

The model uses 4-bit NF4 quantization (BitsAndBytes) on CUDA for memory efficiency (~7 GB quantized vs ~28 GB unquantized). On MPS or CPU, quantization is disabled and the model runs in `float32`.

> **Note:** `Qwen/Qwen2-VL-2B-Instruct` (port 8002) remains available as a standalone service for comparison via the `/test/artifact-detector` test page, but is no longer used in the main pipeline.

---

### Stage 3 — Mask Generation (Grounded-SAM)

**Models:** `IDEA-Research/grounding-dino-base` + `facebook/sam-vit-large` via HuggingFace `transformers`  
**Port:** 8003 · Python 3.10

Given the artifact descriptions produced by Stage 2, this stage generates a precise pixel mask of the affected regions.

**How it works:**

1. **Grounding DINO** takes the natural-language artifact descriptions as a text prompt and predicts bounding boxes around the described regions in the image. It uses an open-vocabulary detection model that maps free-form text to image regions.

2. **SAM** (Segment Anything Model) takes those bounding boxes as prompts and produces high-quality segmentation masks for each detected region.

3. All per-artifact masks are merged into a single binary mask where white pixels indicate regions to be inpainted.

This approach was chosen over simpler alternatives (e.g., a fixed bounding-box crop) because the segmentation mask accurately follows irregular region boundaries — the edge of a hand, the boundary of a face — giving the inpainting model clean, precise context.

Both models are loaded via HuggingFace `transformers` (pure Python, no C++ compilation required). Weights are downloaded automatically from HuggingFace Hub on first use.

---

### Mask Review (Interactive Step)

After Stage 3, the pipeline pauses and presents the mask to the user in the web interface. The user can:

- **Do nothing** and click "Continue to Inpainting" to proceed with the auto-generated mask
- **Draw on the mask** using a circular brush tool to add or remove masked regions before proceeding
- **Click Back** to abort and return to the previous pipeline state without losing earlier results

This step exists because automatic mask generation is imperfect — the VLM might describe an artifact imprecisely, causing Grounding DINO to localize the wrong region. Manual correction keeps the human in the loop without requiring them to restart from scratch.

---

### Stage 4 — Local Inpainting (Stable Diffusion 2 Inpainting)

**Model:** `sd2-community/stable-diffusion-2-inpainting` via HuggingFace `diffusers`  
**Port:** 8004 · Python 3.10

The inpainting model receives:
- The Stage 1 output image
- The binary mask from Stage 3 (or the user-edited version)
- A text prompt automatically constructed from the Stage 2 artifact descriptions, e.g., *"Naturally repair the following defects in the image: six fingers on right hand, deformed left eye"*

SD2 Inpainting fills the masked region by sampling from the diffusion model conditioned on both the surrounding image context and the text prompt. The text guidance is critical here: because the prompt explicitly describes what is wrong and asks for a natural repair, the model is steered away from reproducing the same artifact in the fill.

The image and mask are resized to 512×512 for inference (the model's native resolution) and scaled back to the original size afterward.

**Why SD2 Inpainting over RePaint or PowerPaint?**

| Model | Pros | Cons |
|---|---|---|
| **SD2 Inpainting** | Text-guided, HuggingFace native, fast, large community | Less task-aware than PowerPaint |
| RePaint | Iterative refinement, coherent fills | No text guidance, very slow |
| PowerPaint | Task-aware, supports multiple inpainting modes | Requires manual GitHub setup, more complex |

SD2 Inpainting was selected as the best practical starting point: the text guidance from Stage 2 feeds directly into it, it installs as a single `diffusers` call, and it is fast enough for interactive use. PowerPaint is a natural upgrade path once the pipeline is validated.

---

### Standalone Service — Qwen2-VL Artifact Detector (Port 8002)

**Model:** `Qwen/Qwen2-VL-2B-Instruct` via HuggingFace `transformers`  
**Port:** 8002 · Python 3.11

Qwen2-VL-2B is a lightweight VLM (~2 GB) that runs on Apple Silicon (MPS) and NVIDIA GPUs. It was the original Stage 2 detector and remains available as a standalone service for comparison testing via `/test/artifact-detector`. Its structured output format (`{ has_artifacts, artifacts[] }`) differs from FakeVLM's free-text response.

---

## Hardware Detection

All services use a shared utility (`services/shared/device.py`) that selects the best available compute device at startup:

```python
def get_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"
```

**dtype selection:**

| Device | dtype |
|---|---|
| CUDA | `float16` (half precision, reduced VRAM) |
| MPS | `float32` (MPS float16 triggers an assertion in `MPSNDArrayMatrixMultiplication`) |
| CPU | `float32` |

---

## VRAM Management

If all models were loaded simultaneously, combined VRAM use would exceed 20 GB. Since the pipeline executes strictly sequentially (Stage 1 → 2 → 3 → 4 never overlap), each service **unloads its model immediately after each job completes** via a `try/finally` block. By the time the Next.js orchestrator polls `"done"` and issues the next `POST /infer`, the previous model has already been released.

**Peak VRAM: ~6 GB** (the largest single model), down from ~20 GB cumulative.

Each service also exposes a `POST /release` endpoint for explicit orchestrator-triggered unloads.

---

## Architecture

### Microservice design

Each model runs as an independent FastAPI server in its own `uv`-managed Python environment. This solves a real dependency conflict problem: InstructPix2Pix and SD Inpainting share `diffusers` but at potentially different version requirements; Grounded-SAM uses pure-Python HuggingFace transformers models (no compilation); Qwen2-VL and FakeVLM require Python 3.11 and specific quantization libraries.

Every service exposes the same REST API shape:

```
POST   /infer          → { job_id }
GET    /jobs/{job_id}  → { status, progress, result_path?, result?, detail? }
DELETE /jobs/{job_id}  → 204  (abort)
GET    /health         → 200
POST   /release        → 200  (unload model from VRAM)
```

Jobs run in background threads so the FastAPI server stays responsive for status polling.

### Port assignments

| Service | Port | Model |
|---|---|---|
| InstructPix2Pix | 8001 | timbrooks/instruct-pix2pix |
| Qwen2-VL Detector *(standalone)* | 8002 | Qwen/Qwen2-VL-2B-Instruct |
| Grounded-SAM | 8003 | grounding-dino-base + sam-vit-large |
| SD Inpainting | 8004 | sd2-community/stable-diffusion-2-inpainting |
| FakeVLM *(Stage 2 — pipeline)* | 8005 | lingcco/fakeVLM |
| Next.js frontend | 3000 | — |

### Next.js frontend

The frontend is a single-page React app (Next.js 16, App Router, TypeScript, Tailwind CSS). It acts as the central controller for the pipeline:

- **`/api/upload`** — saves uploaded images to `workspace/{sessionId}/original.png`
- **`/api/pipeline/start`** — SSE endpoint that orchestrates all service calls sequentially, streaming stage progress to the browser. The pipeline pauses and closes the stream at the mask review step; the user's "Continue" click opens a new SSE connection starting at Stage 4.
- **`/api/pipeline/abort`** — sets an in-memory abort flag for the session and calls `DELETE /jobs/{id}` on the currently active service
- **`/api/images/{sessionId}/{filename}`** — serves workspace images to the browser
- **`/api/upload/mask`** — saves the user-edited mask blob back to the workspace before Stage 4
- **`/api/test/invoke`** — thin proxy used by test pages: resolves sessionIds to absolute paths and forwards to the target service's `/infer`
- **`/api/test/status`** — proxies job status polling and converts `result_path` to a browser-accessible image URL

Progress events are streamed as Server-Sent Events (SSE) over the HTTP response body. `EventSource` is not used because it only supports `GET`; instead, the browser reads the response as a `ReadableStream` and parses `data: {...}\n\n` frames manually.

### Session state and file layout

Each pipeline run is identified by a UUID session ID. All intermediate files live in `workspace/{sessionId}/`:

```
workspace/
└── {sessionId}/
    ├── original.png        ← user upload
    ├── stage1_output.png   ← InstructPix2Pix result
    ├── stage3_mask.png     ← Grounded-SAM mask (may be overwritten by user edits)
    └── stage4_result.png   ← final inpainted image
```

The workspace directory is `.gitignore`d. Session files persist across aborts so earlier results are not lost.

---

## Repo Structure

```
114S-535655-IMVFX-Final/
├── .gitignore
├── README.md
│
├── workspace/                          ← runtime session files (gitignored)
│
├── scripts/
│   ├── start_services.sh               ← start all 5 FastAPI services
│   └── stop_services.sh                ← stop by PID
│
├── services/
│   ├── shared/
│   │   └── device.py                   ← MPS/CUDA/CPU auto-detect + flush_memory()
│   │
│   ├── instructpix2pix/
│   │   ├── .python-version             ← 3.10
│   │   ├── pyproject.toml
│   │   ├── server.py                   ← FastAPI, port 8001
│   │   └── start.sh
│   │
│   ├── artifact_detector/
│   │   ├── .python-version             ← 3.11
│   │   ├── pyproject.toml
│   │   ├── server.py                   ← FastAPI, port 8002
│   │   └── start.sh
│   │
│   ├── grounded_sam/
│   │   ├── .python-version             ← 3.10
│   │   ├── pyproject.toml
│   │   ├── server.py                   ← FastAPI, port 8003
│   │   └── start.sh
│   │
│   ├── inpainting/
│   │   ├── .python-version             ← 3.10
│   │   ├── pyproject.toml
│   │   ├── server.py                   ← FastAPI, port 8004
│   │   └── start.sh
│   │
│   └── fakeVLM/                        ← experimental LLaVA classifier
│       ├── .python-version             ← 3.11
│       ├── pyproject.toml
│       ├── server.py                   ← FastAPI, port 8005
│       ├── testVLM.py                  ← standalone CLI test script
│       └── start.sh
│
└── frontend/                           ← Next.js 16, TypeScript, Tailwind CSS
    ├── start.sh
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx                ← landing page (pipeline card + service cards)
    │   │   ├── layout.tsx
    │   │   ├── pipeline/
    │   │   │   └── page.tsx            ← full pipeline UI
    │   │   ├── test/
    │   │   │   ├── instructpix2pix/page.tsx
    │   │   │   ├── fakevlm/page.tsx
    │   │   │   ├── artifact-detector/page.tsx
    │   │   │   ├── grounded-sam/page.tsx
    │   │   │   └── inpainting/page.tsx
    │   │   └── api/
    │   │       ├── upload/route.ts
    │   │       ├── upload/mask/route.ts
    │   │       ├── pipeline/start/route.ts   ← SSE orchestrator
    │   │       ├── pipeline/abort/route.ts
    │   │       ├── images/[sessionId]/[filename]/route.ts
    │   │       ├── test/invoke/route.ts      ← test-page job submission proxy
    │   │       └── test/status/route.ts      ← test-page job polling proxy
    │   ├── components/
    │   │   ├── Dropzone.tsx
    │   │   ├── PromptPanel.tsx
    │   │   ├── PipelineStatus.tsx
    │   │   ├── MaskCanvas.tsx          ← mask overlay + circular brush
    │   │   ├── ResultPanel.tsx         ← three-panel comparison
    │   │   └── TestShell.tsx           ← shared header for test pages
    │   └── lib/
    │       ├── types.ts
    │       ├── paths.ts                ← workspace path resolution
    │       ├── serviceClient.ts        ← typed REST wrappers for services
    │       └── pipelineState.ts        ← shared abort/job state (server-side)
    └── package.json
```

---

## Setup

### Windows (first-time setup)

> Shell commands in later steps (`bash scripts/...`, `uv sync`) require a bash-compatible terminal. Git for Windows includes **Git Bash**, which is sufficient. WSL provides a full Linux environment if you prefer.

**Step 1 — System tools** (PowerShell or Windows Terminal, run as Administrator):

```powershell
# Git for Windows (includes Git Bash)
winget install Git.Git

# Ubuntu WSL — optional; enables running bash scripts natively in Linux
wsl --install

# NVM for Windows — manages Node.js versions
winget install CoreyButler.NVMforWindows
```

Restart your terminal, then:

```powershell
nvm install lts
nvm use lts
corepack enable
```

**Step 2 — uv**

```powershell
winget install astral-sh.uv
```

Or via PowerShell directly:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Restart your terminal so `uv` is on `PATH`.

**Step 3 — CUDA Toolkit** *(NVIDIA GPU only)*

Download and install CUDA Toolkit 12.1 from the NVIDIA website. Verify with `nvcc --version` after installation.

**Step 4 — Clone the repo, then switch to Git Bash**

```powershell
git clone <repo-url>
cd 114S-535655-IMVFX-Final
```

Open **Git Bash** (or a WSL terminal) in the repo root. All remaining commands in this Setup section should be run in Git Bash or WSL — not PowerShell.

> **WSL users:** If you are working entirely inside WSL, install `uv`, `nvm`, `node`, and `corepack` inside the WSL terminal separately using the Linux instructions, then continue with the shared steps below.

---

### Prerequisites

- [uv](https://docs.astral.sh/uv/) — Python package and environment manager
- Node.js 20+ with [Corepack](https://nodejs.org/api/corepack.html) enabled (`corepack enable`)
- Python 3.10 and 3.11 (uv will download and manage them automatically)
- ~25 GB free disk space for model weights and Python environments
- NVIDIA GPU (recommended) or Apple Silicon Mac; CPU-only is supported but slow

### 1. Install Node dependencies

The frontend uses [pnpm](https://pnpm.io/) managed via Corepack. Node.js ships with Corepack; enable it once if you haven't already:

```bash
corepack enable
```

Then install dependencies — pnpm version is pinned in `package.json` (`"packageManager": "pnpm@10.30.0"`), so Corepack will use the correct version automatically:

```bash
cd frontend
pnpm install
```

### 2. Install Python dependencies for each service

`uv sync` reads `.python-version` and `pyproject.toml` and creates an isolated virtual environment. Run it once per service directory.

**On Linux / Windows (NVIDIA GPU):** uv pulls the CUDA 12.1 PyTorch wheels automatically — no manual torch install needed.  
**On macOS (Apple Silicon):** uv falls back to the standard PyPI torch with MPS support.

```bash
cd services/instructpix2pix  && uv sync && cd ../..
cd services/artifact_detector && uv sync && cd ../..
cd services/inpainting        && uv sync && cd ../..
cd services/fakeVLM           && uv sync && cd ../..
```

### 3. Install Grounded-SAM dependencies

```bash
cd services/grounded_sam && uv sync && cd ../..
```

Models (`grounding-dino-base`, `sam-vit-large`) are downloaded from HuggingFace automatically on first request. To pre-download them before running:

```bash
cd services/grounded_sam && uv run python setup.py && cd ../..
```

### 4. Model weights (auto-downloaded on first run)

The remaining models are downloaded automatically from HuggingFace the first time each service handles a request:

| Service | Model | Approx. Size |
|---|---|---|
| InstructPix2Pix | timbrooks/instruct-pix2pix | ~8 GB |
| Artifact Detector | Qwen/Qwen2-VL-2B-Instruct | ~5 GB |
| Grounded-SAM | IDEA-Research/grounding-dino-base | ~700 MB |
| Grounded-SAM | facebook/sam-vit-large | ~600 MB |
| SD Inpainting | sd2-community/stable-diffusion-2-inpainting | ~5 GB |
| FakeVLM | lingcco/fakeVLM | ~7 GB |

Weights are cached in `~/.cache/huggingface/hub/`. To pre-download without running the pipeline:

```bash
huggingface-cli download timbrooks/instruct-pix2pix
huggingface-cli download Qwen/Qwen2-VL-2B-Instruct
huggingface-cli download IDEA-Research/grounding-dino-base
huggingface-cli download facebook/sam-vit-large
huggingface-cli download sd2-community/stable-diffusion-2-inpainting
huggingface-cli download lingcco/fakeVLM
```

---

## Running

### Start all model services

```bash
bash scripts/start_services.sh
```

This launches all five FastAPI servers as background processes. Logs are written to `logs/{service}.log` and PIDs to `logs/{service}.pid`. To stop them:

```bash
bash scripts/stop_services.sh
```

You can also start services individually for development:

```bash
bash services/instructpix2pix/start.sh
# or any other service directory
```

### Start the frontend

```bash
bash frontend/start.sh
# or: cd frontend && pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) — this shows the landing page where you choose the main pipeline or a service test page.

### Health check

```bash
curl http://localhost:8001/health   # InstructPix2Pix
curl http://localhost:8002/health   # Artifact Detector
curl http://localhost:8003/health   # Grounded-SAM
curl http://localhost:8004/health   # SD Inpainting
curl http://localhost:8005/health   # FakeVLM (Stage 2 — pipeline)
```

---

## Usage

### Main pipeline

Navigate to [http://localhost:3000](http://localhost:3000) and click **Main Pipeline**, or go directly to [http://localhost:3000/pipeline](http://localhost:3000/pipeline).

1. **Drop an image** onto the upload area, or click to browse.
2. **Choose or type an instruction** — e.g., "make it look like a painting".
3. **Click Start.** The interface shows live stage progress:
   - Stage 1 runs InstructPix2Pix on your image.
   - Stage 2 analyzes the result with FakeVLM. If no artifacts are found, the pipeline completes here.
   - Stage 3 generates a pixel mask over the detected artifact regions.
4. **Review the mask.** Optionally paint corrections with the circular brush (draw to add, erase to remove). Click **Continue to Inpainting**.
5. Stage 4 fills the masked region with SD Inpainting, guided by the artifact descriptions.
6. The **Results** panel shows the original image, the mask, and the repaired result side by side.

**Abort at any time** using the Abort button. The pipeline rewinds to the last completed stage; no work is lost. Use **Reset** to clear everything and start over.

### Service test pages

Each model can be tested independently from the landing page at [http://localhost:3000](http://localhost:3000). A test page is available for every service:

| URL | What to test |
|---|---|
| `/test/instructpix2pix` | Upload image + type prompt → see edited image |
| `/test/fakevlm` | Upload image → get real/fake verdict text (pipeline Stage 2) |
| `/test/artifact-detector` | Upload image → see Qwen2-VL artifact list (standalone comparison) |
| `/test/grounded-sam` | Upload image + type artifact descriptions → see segmentation mask |
| `/test/inpainting` | Upload image + mask + type prompt → see inpainted result |

These pages are useful for verifying that each service is working correctly before running the full pipeline.

---

## API Reference

All services share the same interface pattern.

### Submit a job

```
POST /infer
Content-Type: application/json
```

**InstructPix2Pix (8001)**
```json
{
  "image_path": "/abs/path/workspace/{sessionId}/original.png",
  "prompt": "make it look like a painting",
  "session_id": "{sessionId}"
}
```

**Artifact Detector (8002)**
```json
{
  "image_path": "/abs/path/workspace/{sessionId}/stage1_output.png",
  "session_id": "{sessionId}"
}
```
Response `result`:
```json
{ "has_artifacts": true, "artifacts": ["six fingers on right hand", "deformed left eye"] }
```

**Grounded-SAM (8003)**
```json
{
  "image_path": "...",
  "artifact_descriptions": ["six fingers on right hand", "deformed left eye"],
  "session_id": "{sessionId}"
}
```

**SD Inpainting (8004)**
```json
{
  "image_path": "...",
  "mask_path": "/abs/path/workspace/{sessionId}/stage3_mask.png",
  "prompt": "Naturally repair the following defects: six fingers on right hand",
  "session_id": "{sessionId}"
}
```

**FakeVLM (8005)**
```json
{
  "image_path": "...",
  "prompt": "<image>List any visual artifacts in this image, such as extra fingers, deformed faces, unnatural textures, or asymmetric features. If the image looks correct and realistic, reply with exactly: NO_ARTIFACTS",
  "session_id": "{sessionId}"
}
```
Response `result`: plain text — either `"NO_ARTIFACTS"` or a description of detected artifacts.  
Default test-page prompt: `"<image>Does the image looks real/fake?"`

All `/infer` endpoints return:
```json
{ "job_id": "uuid" }
```

### Poll job status

```
GET /jobs/{job_id}
```
```json
{
  "status": "running",
  "progress": 60,
  "result_path": "/abs/path/to/output.png",
  "result": null,
  "detail": null
}
```
`status` is one of `"pending"`, `"running"`, `"done"`, `"error"`.  
`result_path` is set for image-output services (IP2P, Grounded-SAM, Inpainting).  
`result` is set for text-output services (Artifact Detector, FakeVLM).

### Abort a job

```
DELETE /jobs/{job_id}
→ 204 No Content
```

### Release model from VRAM

```
POST /release
→ 200 { "ok": true }
```

---

## Development Notes

- The `uv` `.python-version` files pin the Python interpreter per service. Running `uv sync` inside a service directory creates an isolated virtual environment automatically. Never run `pip install` directly; use `uv pip install` or add dependencies to `pyproject.toml`.
- On NVIDIA machines, each service's `pyproject.toml` includes a `[tool.uv.sources]` block pointing to the PyTorch CUDA 12.1 index. If your CUDA version differs, change `cu121` to `cu118` or `cu124` in all `pyproject.toml` files and re-run `uv sync`.
- On first model load, HuggingFace weights are cached in `~/.cache/huggingface/`. Subsequent starts are fast.
- The Next.js frontend assumes `pnpm dev` is run from within the `frontend/` directory, so that `process.cwd()` resolves `../workspace` correctly. The provided `frontend/start.sh` handles this automatically.
- FakeVLM uses 4-bit NF4 quantization via `bitsandbytes`, which requires CUDA. On MPS or CPU the quantization config is skipped and the model loads in `float32`.
- Module-level Python dicts store in-flight job state per service process. Restarting a service clears all job state — this is acceptable for a single-user local application.

---

## Technology Choices Summary

| Component | Technology | Reason |
|---|---|---|
| Global edit | InstructPix2Pix | Instruction-following image edit, HuggingFace native |
| Artifact detection (pipeline) | FakeVLM (lingcco/fakeVLM) | Trained for synthetic image detection + artifact explanation; 4-bit quantized |
| Artifact detection (standalone) | Qwen2-VL-2B-Instruct | Lightweight, MPS-compatible, structured output; available for comparison |
| Segmentation | Grounded-SAM (transformers) | Open-vocabulary text→mask, pure-Python HuggingFace implementation |
| Inpainting | SD2 Inpainting | Text-guided fill, HuggingFace native, fast |
| Service isolation | uv | Per-service Python version + dependency isolation |
| Service runtime | FastAPI + uvicorn | Lightweight async HTTP, clean REST interface |
| Frontend | Next.js 16 (App Router) | Server-side SSE orchestration, single-page React UI |
| Progress streaming | Server-Sent Events over fetch | POST-compatible (EventSource is GET-only) |
| Mask editing | HTML5 Canvas | No extra dependency; circular brush is sufficient |

---

## References

### Models

| Model | Authors | Link |
|---|---|---|
| **InstructPix2Pix** | Brooks et al., 2022 | [arxiv.org/abs/2211.09800](https://arxiv.org/abs/2211.09800) · [HuggingFace](https://huggingface.co/timbrooks/instruct-pix2pix) |
| **Qwen2-VL** | Qwen Team, Alibaba, 2024 | [arxiv.org/abs/2409.12191](https://arxiv.org/abs/2409.12191) · [HuggingFace](https://huggingface.co/Qwen/Qwen2-VL-2B-Instruct) |
| **Grounding DINO** | Liu et al., 2023 | [arxiv.org/abs/2303.05499](https://arxiv.org/abs/2303.05499) · [HuggingFace](https://huggingface.co/IDEA-Research/grounding-dino-base) |
| **SAM** (Segment Anything Model) | Kirillov et al., Meta AI, 2023 | [arxiv.org/abs/2304.02643](https://arxiv.org/abs/2304.02643) · [HuggingFace](https://huggingface.co/facebook/sam-vit-large) |
| **Stable Diffusion 2 Inpainting** | Rombach et al. / Stability AI, 2022 | [arxiv.org/abs/2112.10752](https://arxiv.org/abs/2112.10752) · [HuggingFace](https://huggingface.co/sd2-community/stable-diffusion-2-inpainting) *(community mirror — original weights, Stability AI removed the official repo)* |
| **FakeVLM** — "Spot the Fake" | Wen, Siwei et al., NeurIPS 2025 | Wen, S. et al. "Spot the fake: Large multimodal model-based synthetic image detection with artifact explanation." *Advances in Neural Information Processing Systems* 38 (2026): 58972–59005. · [HuggingFace](https://huggingface.co/lingcco/fakeVLM) |
| **LLaVA** (FakeVLM base architecture) | Liu et al., 2023 | [arxiv.org/abs/2304.08485](https://arxiv.org/abs/2304.08485) |

### Python Libraries

| Library | Version | Purpose |
|---|---|---|
| [PyTorch](https://pytorch.org/) | ≥ 2.2 | Deep learning runtime; MPS / CUDA / CPU backend |
| [torchvision](https://pytorch.org/vision/) | ≥ 0.17 | Image transforms used by Grounding DINO |
| [diffusers](https://github.com/huggingface/diffusers) | ≥ 0.27 | InstructPix2Pix and SD2 Inpainting pipelines |
| [transformers](https://github.com/huggingface/transformers) | ≥ 4.40 | Qwen2-VL and FakeVLM model loading and tokenization |
| [accelerate](https://github.com/huggingface/accelerate) | ≥ 0.29 | Device placement helper for HuggingFace models |
| [bitsandbytes](https://github.com/TimDettmers/bitsandbytes) | ≥ 0.41 | 4-bit NF4 quantization for FakeVLM (CUDA only) |
| [qwen-vl-utils](https://github.com/QwenLM/Qwen2-VL) | ≥ 0.0.8 | Image preprocessing utilities for Qwen2-VL |
| [FastAPI](https://fastapi.tiangolo.com/) | ≥ 0.111 | Async HTTP microservice framework |
| [uvicorn](https://www.uvicorn.org/) | ≥ 0.29 | ASGI server for FastAPI |
| [Pillow](https://python-pillow.org/) | ≥ 10.0 | Image I/O and format conversion |
| [NumPy](https://numpy.org/) | ≥ 1.26 | Mask array operations |

### Frontend Libraries

| Library | Version | Purpose |
|---|---|---|
| [Next.js](https://nextjs.org/) | 16 | Full-stack React framework; App Router, API routes, SSE |
| [React](https://react.dev/) | 19 | UI component model and state management |
| [TypeScript](https://www.typescriptlang.org/) | 5 | Static typing across frontend and API routes |
| [Tailwind CSS](https://tailwindcss.com/) | 4 | Utility-first styling |
| [uuid](https://github.com/uuidjs/uuid) | — | Session ID generation in upload route |

### Tooling

| Tool | Purpose |
|---|---|
| [uv](https://docs.astral.sh/uv/) | Fast Python package manager; per-service environment and Python version isolation |
| [pnpm](https://pnpm.io/) (via Corepack) | Fast, disk-efficient Node.js package manager; version pinned via `"packageManager"` in `package.json` |
| [HuggingFace Hub](https://huggingface.co/) | Model weight hosting and `transformers`/`diffusers` integration |
