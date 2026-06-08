import re
import sys
import uuid
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device, flush_memory

app = FastAPI(title="Qwen2.5-VL Service")

_jobs: dict[str, dict] = {}
_model = None
_processor = None

SYSTEM_PROMPT = (
    "You are an expert at detecting AI-generated image artifacts. "
    "Analyze the image and identify any visual defects: extra or missing fingers, "
    "deformed hands, incorrect facial features, unnatural textures, asymmetric or "
    "blended body parts, anatomical impossibilities, floating objects. "
    "For each artifact found, output one line in this exact format:\n"
    "ARTIFACT: <concise description> BOX: (x1,y1),(x2,y2)\n"
    "where x1,y1 is the top-left corner and x2,y2 is the bottom-right corner, "
    "with coordinates in the range 0-1000 (0=top-left of image, 1000=bottom-right). "
    "If the image looks clean and realistic, reply with exactly: NO_ARTIFACTS"
)

BOX_RE = re.compile(
    r"ARTIFACT:\s*(.+?)\s+BOX:\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*,\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)",
    re.IGNORECASE,
)


def _unload() -> None:
    global _model, _processor
    _model = _processor = None
    flush_memory()


def _load_model():
    global _model, _processor
    if _model is not None:
        return _model, _processor

    import torch
    from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

    device = get_device()

    _processor = AutoProcessor.from_pretrained(
        "Qwen/Qwen2.5-VL-3B-Instruct",
        min_pixels=256 * 28 * 28,
        max_pixels=1280 * 28 * 28,
    )

    if device == "cuda":
        from transformers import BitsAndBytesConfig
        bnb_cfg = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
        _model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            "Qwen/Qwen2.5-VL-3B-Instruct",
            quantization_config=bnb_cfg,
            low_cpu_mem_usage=True,
            device_map="auto",
        )
    else:
        _model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            "Qwen/Qwen2.5-VL-3B-Instruct",
            torch_dtype=torch.float32,
            low_cpu_mem_usage=True,
        ).to(device)

    return _model, _processor


class InferRequest(BaseModel):
    image_path: str
    session_id: str


class DetectorResult(BaseModel):
    raw_text: str
    has_artifacts: bool
    artifacts: list[str]
    boxes: list[list[int]]  # [[x1, y1, x2, y2], ...] 0-1000 range, parallel to artifacts


class JobStatus(BaseModel):
    status: Literal["pending", "running", "done", "error"]
    progress: int = 0
    result: DetectorResult | None = None
    detail: str | None = None


def _run_job(job_id: str, req: InferRequest):
    import torch
    from PIL import Image

    model = processor = None
    inputs = output_ids = None
    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 5
    try:
        from qwen_vl_utils import process_vision_info

        model, processor = _load_model()
        job["progress"] = 30

        image_pil = Image.open(req.image_path).convert("RGB")
        job["progress"] = 40

        device = get_device()
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image_pil},
                    {"type": "text", "text": SYSTEM_PROMPT},
                ],
            }
        ]
        text = processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        image_inputs, _ = process_vision_info(messages)
        inputs = processor(
            text=[text],
            images=image_inputs,
            padding=True,
            return_tensors="pt",
        ).to(device)
        job["progress"] = 50

        with torch.no_grad():
            output_ids = model.generate(**inputs, max_new_tokens=512)
        job["progress"] = 85

        generated = processor.batch_decode(
            output_ids[:, inputs.input_ids.shape[1]:],
            skip_special_tokens=True,
        )[0].strip()

        matches = BOX_RE.findall(generated)
        if matches:
            artifacts = [m[0].strip() for m in matches]
            boxes = [[int(m[1]), int(m[2]), int(m[3]), int(m[4])] for m in matches]
            has_artifacts = True
        elif "NO_ARTIFACTS" in generated.upper():
            artifacts, boxes, has_artifacts = [], [], False
        else:
            artifacts = [ln.strip("•-* ").strip() for ln in generated.splitlines() if ln.strip()]
            boxes = []
            has_artifacts = bool(artifacts)

        job["progress"] = 100
        job["status"] = "done"
        job["result"] = DetectorResult(
            raw_text=generated,
            has_artifacts=has_artifacts,
            artifacts=artifacts,
            boxes=boxes,
        )
    except Exception as exc:
        job["status"] = "error"
        job["detail"] = str(exc)
    finally:
        model = processor = None
        inputs = output_ids = None
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
