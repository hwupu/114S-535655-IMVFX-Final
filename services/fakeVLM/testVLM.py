import torch
import argparse
from PIL import Image
from transformers import AutoProcessor, LlavaForConditionalGeneration, BitsAndBytesConfig

def parse_args():
    parser = argparse.ArgumentParser(description="LLaVA Single Image Inference")
    # Need to change to your own test image path, or place your test image in the same directory as this script and use the filename directly
    parser.add_argument("--image_path", default="your_test_image.jpg", type=str, help="Path to your test image")
    parser.add_argument("--prompt", default="<image>Does the image looks real/fake?", type=str, help="Prompt for LLaVA")
    parser.add_argument("--model_path", default="lingcco/fakeVLM", type=str)
    return parser.parse_args()

def load_model_and_processor(model_path):
    print("Loading model and processor...")
    
    # 4-bit to reduce memory usage, you can adjust the quantization settings as needed
    quantization_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True
    )
    
    # check Flash Attention 2
    try:
        import flash_attn
        attn_impl = "flash_attention_2"
    except ImportError:
        attn_impl = "sdpa"

    # download and load the model and processor
    processor = AutoProcessor.from_pretrained(model_path)
    model = LlavaForConditionalGeneration.from_pretrained(
        model_path, 
        quantization_config=quantization_config,
        low_cpu_mem_usage=True, 
        attn_implementation=attn_impl,
        device_map="auto"
    )
    return model, processor

def main():
    args = parse_args()
    
    # 1. load model and processor
    model, processor = load_model_and_processor(args.model_path)
    
    # 2. load test image and prepare prompt
    print(f"Loading image from: {args.image_path}")
    image = Image.open(args.image_path).convert("RGB")
    
    # 3. process input data
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    inputs = processor(text=args.prompt, images=image, return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}
    
    # 4. generate response
    print("Generating response...")
    with torch.no_grad():
        output = model.generate(**inputs, max_new_tokens=100)
    
    # 5. decode and print the result
    response = processor.decode(output[0], skip_special_tokens=True)
    
    print("\n" + "="*40)
    print(f"Prompt: {args.prompt}")
    print(f"Model Response:\n{response}")
    print("="*40)

if __name__ == "__main__":
    main()