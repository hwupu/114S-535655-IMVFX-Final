import sys
import uuid
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device

app = FastAPI(title="Artifact Detector Service")

_jobs: dict[str, dict] = {}
_model = None
_processor = None

SYSTEM_PROMPT = (
    "You are an expert at detecting AI-generated image artifacts. "
    "Analyze the image and identify any visual defects typical of AI generation: "
    "extra or missing fingers, deformed hands, incorrect facial features, "
    "unnatural textures, asymmetric or blended body parts, floating objects, "
    "uneven fill patterns, or anatomical impossibilities. "
    "If you find artifacts, list each one concisely (e.g. 'six fingers on right hand', "
    "'deformed left eye'). If the image looks clean, reply with exactly: NO_ARTIFACTS"
)


def _load_model():
    global _model, _processor
    if _model is not None:
        return _model, _processor
    from transformers import Qwen2VLForConditionalGeneration, AutoProcessor
    import torch

    device = get_device()
    dtype = torch.float16 if device == "cuda" else torch.float32
    _model = Qwen2VLForConditionalGeneration.from_pretrained(
        "Qwen/Qwen2-VL-2B-Instruct",
        torch_dtype=dtype,
        device_map=device if device == "cuda" else None,
    )
    if device != "cuda":
        _model = _model.to(device)
    _processor = AutoProcessor.from_pretrained("Qwen/Qwen2-VL-2B-Instruct")
    return _model, _processor


class InferRequest(BaseModel):
    image_path: str
    session_id: str


class InferResult(BaseModel):
    has_artifacts: bool
    artifacts: list[str]


class JobStatus(BaseModel):
    status: Literal["pending", "running", "done", "error"]
    progress: int = 0
    result: InferResult | None = None
    detail: str | None = None


def _run_job(job_id: str, req: InferRequest):
    from PIL import Image
    import torch

    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 10
    try:
        model, processor = _load_model()
        job["progress"] = 40

        image = Image.open(req.image_path).convert("RGB")
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": SYSTEM_PROMPT},
                ],
            }
        ]
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = processor(text=[text], images=[image], return_tensors="pt").to(model.device)
        job["progress"] = 60

        with torch.no_grad():
            output_ids = model.generate(**inputs, max_new_tokens=256)
        generated = processor.batch_decode(
            output_ids[:, inputs.input_ids.shape[1]:], skip_special_tokens=True
        )[0].strip()
        job["progress"] = 90

        if "NO_ARTIFACTS" in generated:
            job["result"] = InferResult(has_artifacts=False, artifacts=[])
        else:
            lines = [l.strip("•- ").strip() for l in generated.splitlines() if l.strip()]
            job["result"] = InferResult(has_artifacts=bool(lines), artifacts=lines)

        job["progress"] = 100
        job["status"] = "done"
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
        result=job.get("result"),
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
