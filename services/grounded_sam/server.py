"""
Grounded-SAM service — pure-Python implementation.

Uses HuggingFace transformers for both GroundingDINO and SAM 1.
No C++ compilation or vendor clones required. Models are downloaded
automatically on first request from HuggingFace Hub.
"""
import sys
import uuid
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device, flush_memory

app = FastAPI(title="Grounded-SAM Service")

_jobs: dict[str, dict] = {}
_gdino_processor = None
_gdino_model = None
_sam_processor = None
_sam_model = None


def _unload() -> None:
    global _gdino_processor, _gdino_model, _sam_processor, _sam_model
    _gdino_processor = _gdino_model = _sam_processor = _sam_model = None
    flush_memory()


def _load_models():
    global _gdino_processor, _gdino_model, _sam_processor, _sam_model
    if _gdino_model is not None:
        return

    from transformers import (
        AutoProcessor,
        AutoModelForZeroShotObjectDetection,
        SamProcessor,
        SamModel,
    )

    device = get_device()

    _gdino_processor = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
    _gdino_model = AutoModelForZeroShotObjectDetection.from_pretrained(
        "IDEA-Research/grounding-dino-base"
    ).to(device)

    _sam_processor = SamProcessor.from_pretrained("facebook/sam-vit-large")
    _sam_model = SamModel.from_pretrained("facebook/sam-vit-large").to(device)


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
    gdino_inputs = gdino_outputs = None
    sam_inputs = sam_outputs = None
    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 10
    try:
        _load_models()
        job["progress"] = 30

        image_pil = Image.open(req.image_path).convert("RGB")
        w, h = image_pil.size
        device = get_device()

        # GroundingDINO expects phrases separated by ". " and ending with "."
        text_prompt = ". ".join(req.artifact_descriptions) + "."

        gdino_inputs = _gdino_processor(
            images=image_pil,
            text=text_prompt,
            return_tensors="pt",
        ).to(device)

        with torch.no_grad():
            gdino_outputs = _gdino_model(**gdino_inputs)

        results = _gdino_processor.post_process_grounded_object_detection(
            gdino_outputs,
            gdino_inputs.input_ids,
            box_threshold=0.3,
            text_threshold=0.25,
            target_sizes=[(h, w)],
        )
        boxes = results[0]["boxes"]  # [N, 4] xyxy absolute coords; may be empty
        job["progress"] = 60

        combined = np.zeros((h, w), dtype=np.uint8)

        if len(boxes) > 0:
            sam_inputs = _sam_processor(
                images=image_pil,
                input_boxes=[boxes.tolist()],  # [[x1,y1,x2,y2], ...]
                return_tensors="pt",
            ).to(device)

            with torch.no_grad():
                sam_outputs = _sam_model(**sam_inputs)

            # post_process_masks returns list[tensor[N, num_multimask, H, W]]
            masks_per_image = _sam_processor.image_processor.post_process_masks(
                sam_outputs.pred_masks.cpu(),
                sam_inputs["original_sizes"].cpu(),
                sam_inputs["reshaped_input_sizes"].cpu(),
            )
            image_masks = masks_per_image[0]  # [N, 3, H, W] bool

            for i in range(image_masks.shape[0]):
                best = image_masks[i, 0].numpy()  # [H, W]
                combined = np.logical_or(combined, best).astype(np.uint8)

        job["progress"] = 90

        mask_img = Image.fromarray(combined * 255)
        out_path = str(Path(req.image_path).parent / "stage3_mask.png")
        mask_img.save(out_path)
        job["progress"] = 100
        job["status"] = "done"
        job["result_path"] = out_path
    except Exception as exc:
        job["status"] = "error"
        job["detail"] = str(exc)
    finally:
        gdino_inputs = gdino_outputs = None
        sam_inputs = sam_outputs = None
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
