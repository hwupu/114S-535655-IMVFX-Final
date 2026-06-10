import sys
import uuid
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import spacy
from spacy.cli import download as spacy_download

try:
    nlp = spacy.load("en_core_web_sm")
except OSError:
    print("Downloading spaCy model 'en_core_web_sm'...")
    spacy_download("en_core_web_sm")
    nlp = spacy.load("en_core_web_sm")

sys.path.append(str(Path(__file__).parent.parent / "shared"))
from device import get_device, flush_memory

app = FastAPI(title="FakeVLM Service")

_jobs: dict[str, dict] = {}
_model = None
_processor = None

DEFAULT_PROMPT = "<image>Does the image looks real/fake?"


def _unload() -> None:
    global _model, _processor
    if _model is not None:
        del _model
        _model = None
    if _processor is not None:
        del _processor
        _processor = None
    flush_memory()


def _load_model():
    global _model, _processor
    if _model is not None:
        return _model, _processor

    import torch
    from transformers import AutoProcessor, LlavaForConditionalGeneration

    device = get_device()

    try:
        import flash_attn  # noqa: F401
        attn_impl = "flash_attention_2"
    except ImportError:
        attn_impl = "sdpa"

    _processor = AutoProcessor.from_pretrained("lingcco/fakeVLM")

    if device == "cuda":
        from transformers import BitsAndBytesConfig

        quantization_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
        _model = LlavaForConditionalGeneration.from_pretrained(
            "lingcco/fakeVLM",
            quantization_config=quantization_config,
            low_cpu_mem_usage=True,
            attn_implementation=attn_impl,
            device_map="auto",
        )
    else:
        # MPS / CPU: skip 4-bit quantization (BitsAndBytes requires CUDA)
        _model = LlavaForConditionalGeneration.from_pretrained(
            "lingcco/fakeVLM",
            torch_dtype=torch.float32,
            low_cpu_mem_usage=True,
            attn_implementation=attn_impl,
        ).to(device)

    return _model, _processor


def parse_fakevlm_output(text: str) -> str:

    text = text[len("Does the image looks real/fake?"):]
    print(text)
    text_lower = text.lower().strip()
    
    if text_lower.startswith("this is a real image"):
        return "NO_ARTIFACTS"
        
    if text_lower.startswith("this is a fake image."):
        text = text[len("this is a fake image."):].strip()
    elif text_lower.startswith("this is a fake image"):
        text = text[len("this is a fake image"):].strip()

    doc = nlp(text)
    
    ignore_words = {"image", "color", "saturation", "balance", "world", "noise", "texture", "features", "areas", "overall"}
    
    valid_chunks = []
    for chunk in doc.noun_chunks:
        chunk_text = chunk.text.strip()
        if chunk.root.pos_ == "PRON":
            continue
        if not any(word in chunk_text.lower() for word in ignore_words):
            valid_chunks.append(chunk_text)
            
    if not valid_chunks:
        return "NO_ARTIFACTS"
        
    return " . ".join(valid_chunks) + " ."


class InferRequest(BaseModel):
    image_path: str
    prompt: str = DEFAULT_PROMPT
    session_id: str


class JobStatus(BaseModel):
    status: Literal["pending", "running", "done", "error"]
    progress: int = 0
    result: str | None = None
    detail: str | None = None  


def _run_job(job_id: str, req: InferRequest):
    import torch
    from PIL import Image
    model = processor = None
    inputs = output = None
    job = _jobs[job_id]
    job["status"] = "running"
    job["progress"] = 5
    try:
        model, processor = _load_model()
        job["progress"] = 30

        image = Image.open(req.image_path).convert("RGB")
        job["progress"] = 40

        device = get_device()
        inputs = processor(text=req.prompt, images=image, return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}
        job["progress"] = 50

        with torch.no_grad():
            output = model.generate(**inputs, max_new_tokens=100)
        job["progress"] = 90

        full_text = processor.decode(output[0], skip_special_tokens=True)

        # Strip prompt prefix; LLaVA typically echoes "USER: ... ASSISTANT: <answer>"
        if "ASSISTANT:" in full_text:
            raw_answer = full_text.split("ASSISTANT:", 1)[-1].strip()
        else:
            raw_answer = full_text.strip()

        parsed_answer = parse_fakevlm_output(raw_answer)

        job["progress"] = 100
        job["status"] = "done"
        job["result"] = parsed_answer
        job["detail"] = raw_answer 
    except Exception as exc:
        job["status"] = "error"
        job["detail"] = str(exc)
    finally:
        model = processor = None
        inputs = output = None
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