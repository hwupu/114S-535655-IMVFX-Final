import sys
import uuid
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device

app = FastAPI(title="InstructPix2Pix Service")

_jobs: dict[str, dict] = {}
_pipeline = None


def _load_pipeline():
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    from diffusers import StableDiffusionInstructPix2PixPipeline
    import torch

    device = get_device()
    dtype = torch.float16 if device == "cuda" else torch.float32
    _pipeline = StableDiffusionInstructPix2PixPipeline.from_pretrained(
        "timbrooks/instruct-pix2pix",
        torch_dtype=dtype,
        safety_checker=None,
    ).to(device)
    return _pipeline


class InferRequest(BaseModel):
    image_path: str
    prompt: str
    session_id: str


class JobStatus(BaseModel):
    status: Literal["pending", "running", "done", "error"]
    progress: int = 0
    result_path: str | None = None
    detail: str | None = None


def _run_job(job_id: str, req: InferRequest):
    from PIL import Image

    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 5
    try:
        pipe = _load_pipeline()
        job["progress"] = 20

        image = Image.open(req.image_path).convert("RGB")
        job["progress"] = 30

        result = pipe(
            req.prompt,
            image=image,
            num_inference_steps=50,
            image_guidance_scale=1.5,
            guidance_scale=7.5,
        ).images[0]
        job["progress"] = 90

        out_path = str(Path(req.image_path).parent / "stage1_output.png")
        result.save(out_path)
        job["progress"] = 100
        job["status"] = "done"
        job["result_path"] = out_path
    except Exception as exc:
        job["status"] = "error"
        job["detail"] = str(exc)


@app.get("/health")
def health():
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
