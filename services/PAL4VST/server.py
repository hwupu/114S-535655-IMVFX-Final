import os
import sys
import uuid
import threading
from pathlib import Path
from typing import Literal, Optional

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":16:8")

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import numpy as np


sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device, flush_memory

app = FastAPI(title="PAL4VST Artifacts Localization Service")

DEFAULT_SEED = 42

_jobs: dict[str, dict] = {}
_model = None


TORCHSCRIPT_MODEL_PATH = "end2end.pt"


def _set_deterministic(seed: int = DEFAULT_SEED) -> None:
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

def _unload() -> None:
    global _model
    if _model is not None:
        del _model
        _model = None
    flush_memory()

def _load_model():
    global _model
    if _model is not None:
        return _model

    import torch
    device = get_device()
    
   
    # _model = torch.load(TORCHSCRIPT_MODEL_PATH, map_location=device)
    _model = torch.load(TORCHSCRIPT_MODEL_PATH, map_location=device, weights_only=False)
    if hasattr(_model, 'eval'):
        _model.eval()
        
    return _model

def prepare_input(img_np: np.ndarray, device: str):

    import torch
    
    img_tensor = torch.from_numpy(img_np).float().permute(2, 0, 1)
    
    mean = torch.tensor([123.675, 116.28, 103.53], dtype=torch.float32).view(3, 1, 1)
    std = torch.tensor([58.395, 57.12, 57.375], dtype=torch.float32).view(3, 1, 1)
    
    mean = mean.to(device)
    std = std.to(device)
    img_tensor = img_tensor.to(device)
    
    img_tensor = (img_tensor - mean) / std
    img_tensor = img_tensor.unsqueeze(0)
    
    return img_tensor

class InferRequest(BaseModel):
    image_path: str
    session_id: str
    threshold: float = 0.5 

class JobStatus(BaseModel):
    status: Literal["pending", "running", "done", "error"]
    progress: int = 0
    result_path: Optional[str] = None 
    detail: Optional[str] = None

def _run_job(job_id: str, req: InferRequest):
    import torch
    from PIL import Image
    import numpy as np
    model = None
    
    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 5
    
    try:
        _set_deterministic(DEFAULT_SEED)
        model = _load_model()
        device = get_device()
        job["progress"] = 20

        img_pil = Image.open(req.image_path).convert("RGB")
        original_width, original_height = img_pil.size
        job["progress"] = 30

        crop_size = 512
        pad_w = max(crop_size - original_width, 0)
        pad_h = max(crop_size - original_height, 0)

        if pad_w > 0 or pad_h > 0:
            padded_img = Image.new("RGB", (original_width + pad_w, original_height + pad_h), (0, 0, 0))
            padded_img.paste(img_pil, (0, 0))
            img_to_process = padded_img
        else:
            img_to_process = img_pil

        proc_w, proc_h = img_to_process.size

        # sliding window
        stride = 512
        boxes = []
        for y in range(0, proc_h, stride):
            for x in range(0, proc_w, stride):
                top = min(y, proc_h - crop_size)
                left = min(x, proc_w - crop_size)
                bottom = top + crop_size
                right = left + crop_size
                
                box = (left, top, right, bottom)
                if box not in boxes:
                    boxes.append(box)

        full_prob_map = np.zeros((proc_h, proc_w), dtype=np.float32)
        overlap_count = np.zeros((proc_h, proc_w), dtype=np.float32)

        total_boxes = len(boxes)
        for i, (left, top, right, bottom) in enumerate(boxes):
            patch_pil = img_to_process.crop((left, top, right, bottom))
            patch_tensor = prepare_input(np.array(patch_pil), device)

            with torch.no_grad():
                patch_pal = model(patch_tensor).cpu().data.numpy()[0][0]

            full_prob_map[top:bottom, left:right] += patch_pal
            overlap_count[top:bottom, left:right] += 1

            job["progress"] = 30 + int(50 * ((i + 1) / total_boxes))

        full_prob_map /= np.maximum(overlap_count, 1.0)
        
        binary_mask = (full_prob_map > req.threshold).astype(np.uint8) * 255

        final_mask = binary_mask[:original_height, :original_width]
        mask_pil_final = Image.fromarray(final_mask)
        job["progress"] = 90

        workspace_dir = Path(req.image_path).parent
        mask_path = workspace_dir / "stage3_mask.png"
        mask_pil_final.save(str(mask_path))
        
        job["progress"] = 100
        job["status"] = "done"
        job["result_path"] = str(mask_path)
        
    except Exception as exc:
        job["status"] = "error"
        job["detail"] = str(exc)
    finally:
        model = None
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