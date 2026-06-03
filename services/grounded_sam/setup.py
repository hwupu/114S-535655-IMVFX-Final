"""
Run once to install Grounding DINO and SAM 2 from source and download checkpoints.

  uv run python setup.py
"""
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
CHECKPOINTS = HERE / "checkpoints"
CHECKPOINTS.mkdir(exist_ok=True)


def run(cmd: list[str], **kwargs):
    print(f">>> {' '.join(cmd)}")
    subprocess.run(cmd, check=True, **kwargs)


def download(url: str, dest: Path):
    if dest.exists():
        print(f"Already exists: {dest.name}")
        return
    print(f"Downloading {dest.name}...")
    run(["curl", "-L", "-o", str(dest), url])


# Install Grounding DINO
gdino_dir = HERE / "vendor" / "GroundingDINO"
if not gdino_dir.exists():
    gdino_dir.parent.mkdir(exist_ok=True)
    run(["git", "clone", "https://github.com/IDEA-Research/GroundingDINO.git", str(gdino_dir)])
run([sys.executable, "-m", "pip", "install", "-e", str(gdino_dir)])

# Install SAM 2
sam2_dir = HERE / "vendor" / "sam2"
if not sam2_dir.exists():
    run(["git", "clone", "https://github.com/facebookresearch/sam2.git", str(sam2_dir)])
run([sys.executable, "-m", "pip", "install", "-e", str(sam2_dir)])

# Download Grounding DINO checkpoint
download(
    "https://github.com/IDEA-Research/GroundingDINO/releases/download/v0.1.0-alpha/groundingdino_swint_ogc.pth",
    CHECKPOINTS / "groundingdino_swint_ogc.pth",
)
# Config file
gdino_cfg_src = gdino_dir / "groundingdino" / "config" / "GroundingDINO_SwinT_OGC.py"
gdino_cfg_dst = CHECKPOINTS / "groundingdino_swint_ogc.py"
if not gdino_cfg_dst.exists():
    import shutil
    shutil.copy(gdino_cfg_src, gdino_cfg_dst)

# Download SAM 2 large checkpoint
download(
    "https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_large.pt",
    CHECKPOINTS / "sam2_hiera_large.pt",
)

print("\nSetup complete. You can now run: bash start.sh")
