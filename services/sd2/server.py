import os
import sys
import uuid
import threading
from pathlib import Path
from typing import Literal

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":16:8")

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device, flush_memory

app = FastAPI(title="SD Inpainting Service")

DEFAULT_SEED = 42

_jobs: dict[str, dict] = {}
_pipeline = None


def _set_deterministic(seed: int = DEFAULT_SEED) -> int:
    import random

    import numpy as np
    import torch

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False
    try:
        torch.use_deterministic_algorithms(True)
    except Exception:
        pass
    return seed


def _unload() -> None:
    global _pipeline
    if _pipeline is not None:
        del _pipeline
        _pipeline = None
    flush_memory()


def _load_pipeline():
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    from diffusers import StableDiffusionInpaintPipeline
    import torch

    device = get_device()
    dtype = torch.float16 if device == "cuda" else torch.float32
    _pipeline = StableDiffusionInpaintPipeline.from_pretrained(
        "sd2-community/stable-diffusion-2-inpainting",
        torch_dtype=dtype,
    ).to(device)
    return _pipeline


class InferRequest(BaseModel):
    image_path: str
    mask_path: str
    prompt: str
    session_id: str


class JobStatus(BaseModel):
    status: Literal["pending", "running", "done", "error"]
    progress: int = 0
    result_path: str | None = None
    detail: str | None = None


def _run_job(job_id: str, req: InferRequest):
    from PIL import Image
    pipe = None
    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 5
    try:
        import torch

        seed = _set_deterministic(DEFAULT_SEED)
        pipe = _load_pipeline()
        job["progress"] = 20

        image = Image.open(req.image_path).convert("RGB")
        mask = Image.open(req.mask_path).convert("L")

        # # SD inpainting expects 512×512; resize and restore original size
        orig_size = image.size
        # image_r = image.resize((512, 512))
        # mask_r = mask.resize((512, 512))
        # job["progress"] = 35

        device = get_device()
        generator = torch.Generator(device=device).manual_seed(seed)

        # result = pipe(
        #     prompt=req.prompt,
        #     image=image_r,
        #     mask_image=mask_r,
        #     num_inference_steps=50,
        #     guidance_scale=7.5,
        #     generator=generator,
        # ).images[0]
        # job["progress"] = 90

        # result = result.resize(orig_size)
        # out_path = str(Path(req.image_path).parent / "stage4_result.png")
        # result.save(out_path)



        # mask = mask.filter(ImageFilter.GaussianBlur(radius=3))

        width, height = orig_size
        aspect_ratio = width / height
        if width < height:
            new_width = 512
            new_height = int((512 / aspect_ratio) // 8 * 8)
        else:
            new_height = 512
            new_width = int((512 * aspect_ratio) // 8 * 8)

        image_r = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
        mask_r = mask.resize((new_width, new_height), Image.Resampling.LANCZOS)

        # better_prompt = "beautiful emerald green cat eyes, sharp focus, highly detailed, photorealistic"
        neg_prompt = "glowing, low resolution, blurry, deformed, cross-eyed, unnatural, poorly drawn"

        result = pipe(
            prompt=req.prompt,
            negative_prompt=neg_prompt,
            image=image_r,
            mask_image=mask_r,
            num_inference_steps=50,
            guidance_scale=7.5,
            generator=generator,
        ).images[0]

        result = result.resize(orig_size, Image.Resampling.LANCZOS)
        out_path = str(Path(req.image_path).parent / "stage4_result.png")
        result.save(out_path)




        job["progress"] = 100
        job["status"] = "done"
        job["result_path"] = out_path
    except Exception as exc:
        job["status"] = "error"
        job["detail"] = str(exc)
    finally:
        pipe = None
        _unload()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/release")
def release():
    _unload()
    return {"ok": True}


@app.post("/infer")
def infer(req: InferRequest):
    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "pending", "progress": 0}
    thread = threading.Thread(target=_run_job, args=(job_id, req), daemon=True)
    _jobs[job_id]["thread"] = thread
    thread.start()
    return {"job_id": job_id}


@app.get("/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobStatus(
        status=job["status"],
        progress=job["progress"],
        result_path=job.get("result_path"),
        detail=job.get("detail"),
    )


@app.delete("/jobs/{job_id}", status_code=204)
def abort_job(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job["status"] = "error"
    job["detail"] = "aborted"
    _jobs.pop(job_id, None)
