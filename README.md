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
│  Stage 2              │  Qwen2-VL-2B-Instruct
│  Artifact Detection   │  Visual language model
└───────────┬───────────┘
            │
     ┌──────┴──────┐
     │ no artifacts│  → Pipeline complete (return Stage 1 output)
     │ found       │
     └──────┬──────┘
            │ artifact descriptions (text)
            ▼
┌───────────────────────┐
│  Stage 3              │  Grounded-SAM 2
│  Mask Generation      │  Grounding DINO + SAM 2
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
│  Local Inpainting     │  stabilityai/stable-diffusion-2-inpainting
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

---

### Stage 2 — Artifact Detection (Qwen2-VL-2B-Instruct)

**Model:** `Qwen/Qwen2-VL-2B-Instruct` via HuggingFace `transformers`  
**Port:** 8002 · Python 3.11

A Vision-Language Model (VLM) is used to analyze the Stage 1 output and produce a structured list of any visual artifacts. Qwen2-VL-2B was chosen because:

- At ~2 GB it runs comfortably on Apple Silicon (MPS) and NVIDIA GPUs
- It understands fine-grained spatial detail well enough to identify anatomical defects
- It is natively available via HuggingFace — no custom installation required
- Inference is fast enough for interactive use (~5–15 s depending on hardware)

The model is prompted with a detailed system instruction that asks it to enumerate artifacts like six fingers, deformed hands, incorrect facial features, unnatural textures, asymmetric body parts, and uneven fill patterns. If the image is clean it replies with the sentinel `NO_ARTIFACTS`; otherwise it returns a line-separated list of descriptions such as:

```
six fingers on right hand
deformed left eye
uneven texture on background
```

These text descriptions serve a dual purpose: they are shown to the user in the UI, and they are passed directly to Stage 3 as grounding queries.

---

### Stage 3 — Mask Generation (Grounded-SAM 2)

**Models:** Grounding DINO + SAM 2 (Meta, IDEA-Research)  
**Port:** 8003 · Python 3.10

Given the artifact descriptions produced by Stage 2, this stage generates a precise pixel mask of the affected regions.

**How it works:**

1. **Grounding DINO** takes the natural-language artifact descriptions as a text prompt and predicts bounding boxes around the described regions in the image. It uses an open-vocabulary detection model that maps free-form text to image regions.

2. **SAM 2** (Segment Anything Model 2) takes those bounding boxes as prompts and produces high-quality segmentation masks for each detected region.

3. All per-artifact masks are merged into a single binary mask where white pixels indicate regions to be inpainted.

This approach was chosen over simpler alternatives (e.g., a fixed bounding-box crop) because the segmentation mask accurately follows irregular region boundaries — the edge of a hand, the boundary of a face — giving the inpainting model clean, precise context.

**Checkpoints** (downloaded by `services/grounded_sam/setup.py`):
- `groundingdino_swint_ogc.pth` — Grounding DINO SwinT backbone
- `sam2_hiera_large.pt` — SAM 2 Large

---

### Mask Review (Interactive Step)

After Stage 3, the pipeline pauses and presents the mask to the user in the web interface. The user can:

- **Do nothing** and click "Continue to Inpainting" to proceed with the auto-generated mask
- **Draw on the mask** using a circular brush tool to add or remove masked regions before proceeding
- **Click Back** to abort and return to the previous pipeline state without losing earlier results

This step exists because automatic mask generation is imperfect — the VLM might describe an artifact imprecisely, causing Grounding DINO to localize the wrong region. Manual correction keeps the human in the loop without requiring them to restart from scratch.

---

### Stage 4 — Local Inpainting (Stable Diffusion 2 Inpainting)

**Model:** `stabilityai/stable-diffusion-2-inpainting` via HuggingFace `diffusers`  
**Port:** 8004 · Python 3.10

The inpainting model receives:
- The Stage 1 output image
- The binary mask from Stage 3 (or the user-edited version)
- A text prompt automatically constructed from the Stage 2 artifact descriptions, e.g., *"Naturally repair the following defects in the image: six fingers on right hand, deformed left eye"*

SD2 Inpainting fills the masked region by sampling from the diffusion model conditioned on both the surrounding image context and the text prompt. The text guidance is critical here: because the prompt explicitly describes what is wrong and asks for a natural repair, the model is steered away from reproducing the same artifact in the fill.

The image is resized to 512×512 for inference (the model's native resolution) and scaled back to the original size afterward.

**Why SD2 Inpainting over RePaint or PowerPaint?**

| Model | Pros | Cons |
|---|---|---|
| **SD2 Inpainting** | Text-guided, HuggingFace native, fast, large community | Less task-aware than PowerPaint |
| RePaint | Iterative refinement, coherent fills | No text guidance, very slow |
| PowerPaint | Task-aware, supports multiple inpainting modes | Requires manual GitHub setup, more complex |

SD2 Inpainting was selected as the best practical starting point: the text guidance from Stage 2 feeds directly into it, it installs as a single `diffusers` call, and it is fast enough for interactive use. PowerPaint is a natural upgrade path once the pipeline is validated.

---

## Hardware Detection

All four Python services use a shared utility (`services/shared/device.py`) that selects the best available compute device at startup:

```python
def get_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"
```

This allows the same code to run on an Apple Silicon development machine (MPS) and a CUDA production machine without modification. Models are loaded in `float16` on MPS and CUDA, and `float32` on CPU.

---

## Architecture

### Microservice design

Each model runs as an independent FastAPI server in its own `uv`-managed Python environment. This solves a real dependency conflict problem: InstructPix2Pix and SD Inpainting share `diffusers` but at potentially different version requirements; Grounded-SAM 2 requires compiled C++ extensions from source; Qwen2-VL requires a newer Python (3.11) for some dependencies.

Every service exposes the same REST API shape:

```
POST   /infer          → { job_id }
GET    /jobs/{job_id}  → { status, progress, result_path?, result?, detail? }
DELETE /jobs/{job_id}  → 204  (abort)
GET    /health         → 200
```

Jobs run in background threads so the FastAPI server stays responsive for status polling. This is sufficient for a single-user local application; a production system would use a proper task queue (Celery, ARQ).

### Port assignments

| Service | Port | Model |
|---|---|---|
| InstructPix2Pix | 8001 | timbrooks/instruct-pix2pix |
| Artifact Detector | 8002 | Qwen/Qwen2-VL-2B-Instruct |
| Grounded-SAM | 8003 | GroundingDINO + SAM 2 |
| SD Inpainting | 8004 | stabilityai/stable-diffusion-2-inpainting |
| Next.js frontend | 3000 | — |

### Next.js frontend

The frontend is a single-page React app (Next.js 16, App Router, TypeScript, Tailwind CSS). It acts as the central controller for the pipeline:

- **`/api/upload`** — saves uploaded images to `workspace/{sessionId}/original.png`
- **`/api/pipeline/start`** — SSE endpoint that orchestrates all service calls sequentially, streaming stage progress to the browser. The pipeline pauses and closes the stream at the mask review step; the user's "Continue" click opens a new SSE connection starting at Stage 4.
- **`/api/pipeline/abort`** — sets an in-memory abort flag for the session and calls `DELETE /jobs/{id}` on the currently active service
- **`/api/images/{sessionId}/{filename}`** — serves workspace images to the browser
- **`/api/upload/mask`** — saves the user-edited mask blob back to the workspace before Stage 4

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
│   ├── start_services.sh               ← start all 4 FastAPI services
│   └── stop_services.sh                ← stop by PID
│
├── services/
│   ├── shared/
│   │   └── device.py                   ← MPS/CUDA/CPU auto-detect
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
│   │   ├── setup.py                    ← one-time: install from source + download checkpoints
│   │   └── start.sh
│   │
│   └── inpainting/
│       ├── .python-version             ← 3.10
│       ├── pyproject.toml
│       ├── server.py                   ← FastAPI, port 8004
│       └── start.sh
│
└── frontend/                           ← Next.js 16, TypeScript, Tailwind CSS
    ├── start.sh
    ├── src/
    │   ├── app/
    │   │   ├── page.tsx                ← main UI, pipeline state machine
    │   │   ├── layout.tsx
    │   │   └── api/
    │   │       ├── upload/route.ts
    │   │       ├── upload/mask/route.ts
    │   │       ├── pipeline/start/route.ts   ← SSE orchestrator
    │   │       ├── pipeline/abort/route.ts
    │   │       └── images/[sessionId]/[filename]/route.ts
    │   ├── components/
    │   │   ├── Dropzone.tsx
    │   │   ├── PromptPanel.tsx
    │   │   ├── PipelineStatus.tsx
    │   │   ├── MaskCanvas.tsx          ← mask overlay + circular brush
    │   │   └── ResultPanel.tsx         ← three-panel comparison
    │   └── lib/
    │       ├── types.ts
    │       ├── paths.ts                ← workspace path resolution
    │       ├── serviceClient.ts        ← typed REST wrappers for services
    │       └── pipelineState.ts        ← shared abort/job state (server-side)
    └── package.json
```

---

## Setup

### Prerequisites

- [uv](https://docs.astral.sh/uv/) — Python package and environment manager
- Node.js 20+ and npm
- Python 3.10 and 3.11 available (uv will manage them)
- Sufficient disk space for model weights (~20 GB total)

### 1. Install Node dependencies

```bash
cd frontend
npm install
```

### 2. Install Python dependencies for each service

`uv` reads `.python-version` and `pyproject.toml` and creates an isolated virtual environment per service.

```bash
cd services/instructpix2pix  && uv sync
cd services/artifact_detector && uv sync
cd services/inpainting        && uv sync
```

### 3. Set up Grounded-SAM (one-time, requires internet)

This script clones GroundingDINO and SAM 2 from GitHub, installs them into the service environment, and downloads the model checkpoints (~2 GB):

```bash
cd services/grounded_sam
uv sync
uv run python setup.py
```

### 4. Model weights (auto-downloaded on first run)

The remaining models are downloaded automatically from HuggingFace the first time each service handles a request:

| Service | Model | Size |
|---|---|---|
| InstructPix2Pix | timbrooks/instruct-pix2pix | ~8 GB |
| Artifact Detector | Qwen/Qwen2-VL-2B-Instruct | ~5 GB |
| SD Inpainting | stabilityai/stable-diffusion-2-inpainting | ~5 GB |

To pre-download without running the pipeline, use `huggingface-cli download <model-id>`.

---

## Running

### Start all model services

```bash
bash scripts/start_services.sh
```

This launches all four FastAPI servers as background processes. Logs are written to `logs/`. To stop them:

```bash
bash scripts/stop_services.sh
```

You can also start services individually for development:

```bash
cd services/instructpix2pix && bash start.sh
```

### Start the frontend

```bash
bash frontend/start.sh
# or: cd frontend && npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Health check

```bash
curl http://localhost:8001/health   # InstructPix2Pix
curl http://localhost:8002/health   # Artifact Detector
curl http://localhost:8003/health   # Grounded-SAM
curl http://localhost:8004/health   # SD Inpainting
```

---

## Usage

1. **Drop an image** onto the upload area, or click to browse.
2. **Choose or type an instruction** — e.g., "make it look like a painting".
3. **Click Start.** The interface shows live stage progress:
   - Stage 1 runs InstructPix2Pix on your image.
   - Stage 2 analyzes the result with Qwen2-VL. If no artifacts are found, the pipeline completes here.
   - Stage 3 generates a pixel mask over the detected artifact regions.
4. **Review the mask.** Optionally paint corrections with the circular brush (draw to add, erase to remove). Click **Continue to Inpainting**.
5. Stage 4 fills the masked region with SD Inpainting, guided by the artifact descriptions.
6. The **Results** panel shows the original image, the mask, and the repaired result side by side.

**Abort at any time** using the Abort button. The pipeline rewinds to the last completed stage; no work is lost. Use **Reset** to clear everything and start over.

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
  "image_path": "/abs/path/to/workspace/{sessionId}/original.png",
  "prompt": "make it look like a painting",
  "session_id": "{sessionId}"
}
```

**Artifact Detector (8002)**
```json
{
  "image_path": "/abs/path/to/workspace/{sessionId}/stage1_output.png",
  "session_id": "{sessionId}"
}
```
Response result:
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
  "mask_path": "/abs/path/to/workspace/{sessionId}/stage3_mask.png",
  "prompt": "Naturally repair the following defects: six fingers on right hand",
  "session_id": "{sessionId}"
}
```

All return:
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
  "detail": null
}
```
`status` is one of `"pending"`, `"running"`, `"done"`, `"error"`.

### Abort a job

```
DELETE /jobs/{job_id}
→ 204 No Content
```

---

## Development Notes

- The `uv` `.python-version` files pin the Python interpreter per service. Running `uv sync` inside a service directory installs all dependencies into an isolated virtual environment automatically.
- The Grounded-SAM service requires compiled extensions. If `uv run python setup.py` fails, check that Xcode Command Line Tools (macOS) or `build-essential` (Linux) is installed.
- On first model load, HuggingFace weights are cached in `~/.cache/huggingface/`. Subsequent starts are fast.
- The Next.js frontend assumes `npm run dev` is run from within the `frontend/` directory, so that `process.cwd()` resolves `../workspace` correctly. The provided `frontend/start.sh` handles this automatically.
- Module-level Python dicts store in-flight job state per service process. Restarting a service clears all job state — this is acceptable for a single-user local application.

---

## Technology Choices Summary

| Component | Technology | Reason |
|---|---|---|
| Global edit | InstructPix2Pix | Instruction-following image edit, HuggingFace native |
| Artifact detection | Qwen2-VL-2B-Instruct | Lightweight VLM, MPS-compatible, detailed spatial understanding |
| Segmentation | Grounded-SAM 2 | Open-vocabulary text→mask, state-of-the-art quality |
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
| **Grounding DINO** | Liu et al., 2023 | [arxiv.org/abs/2303.05499](https://arxiv.org/abs/2303.05499) · [GitHub](https://github.com/IDEA-Research/GroundingDINO) |
| **SAM 2** (Segment Anything Model 2) | Ravi et al., Meta AI, 2024 | [arxiv.org/abs/2408.00714](https://arxiv.org/abs/2408.00714) · [GitHub](https://github.com/facebookresearch/sam2) |
| **Grounded-SAM 2** (integration) | IDEA-Research | [GitHub](https://github.com/IDEA-Research/Grounded-SAM-2) |
| **Stable Diffusion 2 Inpainting** | Rombach et al. / Stability AI, 2022 | [arxiv.org/abs/2112.10752](https://arxiv.org/abs/2112.10752) · [HuggingFace](https://huggingface.co/stabilityai/stable-diffusion-2-inpainting) |

### Python Libraries

| Library | Version | Purpose |
|---|---|---|
| [PyTorch](https://pytorch.org/) | ≥ 2.2 | Deep learning runtime; MPS / CUDA / CPU backend |
| [torchvision](https://pytorch.org/vision/) | ≥ 0.17 | Image transforms used by Grounding DINO |
| [diffusers](https://github.com/huggingface/diffusers) | ≥ 0.27 | InstructPix2Pix and SD2 Inpainting pipelines |
| [transformers](https://github.com/huggingface/transformers) | ≥ 4.40 | Qwen2-VL model loading and tokenization |
| [accelerate](https://github.com/huggingface/accelerate) | ≥ 0.29 | Device placement helper for HuggingFace models |
| [qwen-vl-utils](https://github.com/QwenLM/Qwen2-VL) | ≥ 0.0.8 | Image preprocessing utilities for Qwen2-VL |
| [FastAPI](https://fastapi.tiangolo.com/) | ≥ 0.111 | Async HTTP microservice framework |
| [uvicorn](https://www.uvicorn.org/) | ≥ 0.29 | ASGI server for FastAPI |
| [Pillow](https://python-pillow.org/) | ≥ 10.0 | Image I/O and format conversion |
| [supervision](https://supervision.roboflow.com/) | ≥ 0.19 | Bounding box format utilities for Grounded-SAM |
| [NumPy](https://numpy.org/) | ≥ 1.26 | Mask array operations |
| [OpenCV (headless)](https://opencv.org/) | ≥ 4.9 | Image processing utilities in Grounded-SAM service |
| [GroundingDINO](https://github.com/IDEA-Research/GroundingDINO) | source | Open-vocabulary object detection from text |
| [SAM 2](https://github.com/facebookresearch/sam2) | source | Segment Anything Model 2 image predictor |

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
| [HuggingFace Hub](https://huggingface.co/) | Model weight hosting and `transformers`/`diffusers` integration |
