"""
Grounded-SAM 2 service.

Setup (run once before starting):
  uv run python setup.py

This installs grounding_dino and sam2 from source into the uv environment.
"""
import sys
import uuid
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device

app = FastAPI(title="Grounded-SAM Service")

_jobs: dict[str, dict] = {}
_grounding_model = None
_sam_predictor = None


def _load_models():
    global _grounding_model, _sam_predictor
    if _grounding_model is not None:
        return _grounding_model, _sam_predictor

    import torch
    from groundingdino.util.inference import load_model as load_gdino
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    device = get_device()
    here = Path(__file__).parent

    _grounding_model = load_gdino(
        str(here / "checkpoints" / "groundingdino_swint_ogc.py"),
        str(here / "checkpoints" / "groundingdino_swint_ogc.pth"),
        device=device,
    )
    sam2_checkpoint = here / "checkpoints" / "sam2_hiera_large.pt"
    sam2_config = "sam2_hiera_l.yaml"
    sam2_model = build_sam2(sam2_config, str(sam2_checkpoint), device=device)
    _sam_predictor = SAM2ImagePredictor(sam2_model)
    return _grounding_model, _sam_predictor


class InferRequest(BaseModel):
    image_path: str
    artifact_descriptions: list[str]
    session_id: str


class JobStatus(BaseModel):
    status: Literal["pending", "running", "done", "error"]
    progress: int = 0
    result_path: str | None = None
    detail: str | None = None


def _run_job(job_id: str, req: InferRequest):
    import numpy as np
    import torch
    from PIL import Image
    import groundingdino.datasets.transforms as T
    from groundingdino.util.inference import predict as gdino_predict
    import supervision as sv

    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 10
    try:
        gdino, sam_pred = _load_models()
        job["progress"] = 30

        image_pil = Image.open(req.image_path).convert("RGB")
        image_np = np.array(image_pil)

        # Combine all artifact descriptions into a single grounding query
        text_prompt = " . ".join(req.artifact_descriptions) + " ."

        transform = T.Compose([
            T.RandomResize([800], max_size=1333),
            T.ToTensor(),
            T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        image_transformed, _ = transform(image_pil, None)

        boxes, logits, phrases = gdino_predict(
            model=gdino,
            image=image_transformed,
            caption=text_prompt,
            box_threshold=0.3,
            text_threshold=0.25,
        )
        job["progress"] = 60

        h, w = image_np.shape[:2]
        boxes_xyxy = boxes * torch.tensor([w, h, w, h], dtype=torch.float32)
        boxes_xyxy = sv.box_convert(boxes_xyxy.numpy(), "cxcywh", "xyxy")

        sam_pred.set_image(image_np)
        masks, _, _ = sam_pred.predict(
            box=boxes_xyxy,
            multimask_output=False,
        )
        job["progress"] = 85

        # Merge all masks into one binary mask
        combined = np.zeros((h, w), dtype=np.uint8)
        for m in masks:
            combined = np.logical_or(combined, m.squeeze()).astype(np.uint8)
        mask_img = Image.fromarray(combined * 255)

        out_path = str(Path(req.image_path).parent / "stage3_mask.png")
        mask_img.save(out_path)
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
