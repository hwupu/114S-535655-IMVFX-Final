# Arg 

* image_path: the image want to test

* prompt: follow the setting in FakeVLM. Maybe can change to other to do experiment?  
    default is "\<image>Does the image looks real/fake?"

* model_path: the path to pre-trained weight, default is from huggingface lingcco/fakeVLM.

# How to run
uv run testVLM.py \--image_path "path" \--model_path "lingcco/fakeVLM"