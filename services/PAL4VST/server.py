import sys
import uuid
import threading
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import numpy as np


sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device, flush_memory

app = FastAPI(title="PAL4VST Artifacts Localization Service")

_jobs: dict[str, dict] = {}
_model = None


TORCHSCRIPT_MODEL_PATH = "end2end.pt"

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
    model = None
    
    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 5
    
    try:
        model = _load_model()
        device = get_device()
        job["progress"] = 20

        
        img_pil = Image.open(req.image_path).convert("RGB")
        original_width, original_height = img_pil.size
        job["progress"] = 30

        
        img_resized = np.array(img_pil.resize((512, 512), Image.BILINEAR))
        img_tensor = prepare_input(img_resized, device)
        job["progress"] = 40

       
        with torch.no_grad():
            
            pal = model(img_tensor).cpu().data.numpy()[0][0]
        job["progress"] = 70

        
        binary_mask = (pal > req.threshold).astype(np.uint8) * 255
        mask_pil = Image.fromarray(binary_mask)

        
        mask_pil_original_size = mask_pil.resize((original_width, original_height), Image.NEAREST)
        job["progress"] = 80

       
        workspace_dir = Path(req.image_path).parent
        
        mask_path = workspace_dir / "stage3_mask.png"
        mask_pil_original_size.save(str(mask_path))
        job["progress"] = 90

        job["progress"] = 100
        job["status"] = "done"
        job["result_path"] = str(mask_path)
        
    except Exception as exc:
        job["status"] = "error"
        job["detail"] = str(exc)
    finally:
        
        model = None
        img_tensor = None
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