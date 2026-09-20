"""Fetches FinGPT's Llama-3-8B LoRA adapter and its base model into the Hugging Face cache.

The adapter (FinGPT/fingpt-mt_llama3-8b_lora) was trained on Meta-Llama-3-8B. Meta's own repo is gated, so the
ungated NousResearch mirror of the same weights is used as the base.
"""
from huggingface_hub import snapshot_download

BASE = "NousResearch/Meta-Llama-3-8B"
ADAPTER = "FinGPT/fingpt-mt_llama3-8b_lora"

print("adapter ->", snapshot_download(ADAPTER), flush=True)
print("base    ->", snapshot_download(BASE, allow_patterns=["*.json", "*.safetensors"]), flush=True)
print("DONE", flush=True)
