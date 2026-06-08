"""
Optional: pre-download models from HuggingFace before the first request.
Models are also downloaded automatically on first use.

  cd services/grounded_sam
  uv sync
  uv run python setup.py
"""
from transformers import (
    AutoProcessor,
    AutoModelForZeroShotObjectDetection,
    SamProcessor,
    SamModel,
)

print("Downloading GroundingDINO (grounding-dino-base)...")
AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
AutoModelForZeroShotObjectDetection.from_pretrained("IDEA-Research/grounding-dino-base")

print("Downloading SAM (sam-vit-large)...")
SamProcessor.from_pretrained("facebook/sam-vit-large")
SamModel.from_pretrained("facebook/sam-vit-large")

print("\nSetup complete. You can now run: bash start.sh")
