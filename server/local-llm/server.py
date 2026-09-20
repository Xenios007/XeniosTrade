"""Local FinGPT (Llama-3-8B + LoRA, 4-bit NF4) behind an OpenAI-compatible endpoint.

    POST /v1/chat/completions   GET /v1/models   GET /health

The XeniosTrade AI Trading agents call this through the normal provider layer (provider id `fingpt`).
The base weights are quantised to NF4 on load (bitsandbytes) and whatever does not fit in the VRAM budget is
offloaded to system RAM. The FinGPT LoRA adapter is applied on top with peft.

Env (all optional):
    FINGPT_PORT            default 8011
    FINGPT_BASE            default NousResearch/Meta-Llama-3-8B   (ungated mirror of the adapter's base)
    FINGPT_ADAPTER         default FinGPT/fingpt-mt_llama3-8b_lora
    FINGPT_GPU_MEM_GIB     default 5.0   VRAM budget for weights; the rest of the model goes to RAM
    FINGPT_CPU_MEM_GIB     default 18
    FINGPT_MAX_NEW_TOKENS  default 700   hard cap per reply (the client asks for far more)
    FINGPT_API_KEY         bearer token required for requests that arrive through the Cloudflare tunnel (they carry a
                           Cf-Connecting-Ip header). Falls back to server/local-llm/api-key.txt. Direct local calls
                           (no Cf header) never need it; with no key configured, tunnel traffic is refused.
"""
import hmac
import json
import os
import re
import threading
import time
import uuid

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, StoppingCriteria, StoppingCriteriaList

BASE = os.environ.get("FINGPT_BASE", "NousResearch/Meta-Llama-3-8B")
ADAPTER = os.environ.get("FINGPT_ADAPTER", "FinGPT/fingpt-mt_llama3-8b_lora")
GPU_MEM_GIB = float(os.environ.get("FINGPT_GPU_MEM_GIB", "5.0"))
CPU_MEM_GIB = float(os.environ.get("FINGPT_CPU_MEM_GIB", "18"))
MAX_NEW_TOKENS = int(os.environ.get("FINGPT_MAX_NEW_TOKENS", "700"))
PORT = int(os.environ.get("FINGPT_PORT", "8011"))
MODEL_ID = "fingpt-llama3-8b"


def load_api_key():
    key = os.environ.get("FINGPT_API_KEY", "").strip()
    if key:
        return key
    try:
        with open(os.path.join(os.path.dirname(__file__), "api-key.txt"), encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


API_KEY = load_api_key()

state = {"model": None, "tokenizer": None, "status": "loading", "error": "", "loaded_at": None}
generate_lock = threading.Lock()


def load_model():
    try:
        started = time.time()
        tokenizer = AutoTokenizer.from_pretrained(BASE)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token

        quantization = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.float16,
            # Lets layers that do not fit on the GPU sit in system RAM (unquantised) instead of failing to load.
            llm_int8_enable_fp32_cpu_offload=True,
        )
        model = AutoModelForCausalLM.from_pretrained(
            BASE,
            quantization_config=quantization,
            device_map="auto",
            max_memory={0: f"{GPU_MEM_GIB}GiB", "cpu": f"{CPU_MEM_GIB}GiB"},
            torch_dtype=torch.float16,
            low_cpu_mem_usage=True,
            offload_folder=os.path.join(os.path.dirname(__file__), ".offload"),
        )
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, ADAPTER)
        model.eval()

        state.update(model=model, tokenizer=tokenizer, status="ready", loaded_at=time.time())
        placement = {}
        for device in getattr(model.base_model.model, "hf_device_map", {}).values():
            placement[str(device)] = placement.get(str(device), 0) + 1
        print(f"[fingpt] ready in {time.time() - started:.0f}s; module placement: {placement}", flush=True)
    except Exception as error:  # noqa: BLE001 - surfaced on /health
        state.update(status="error", error=f"{type(error).__name__}: {error}")
        print(f"[fingpt] load failed: {state['error']}", flush=True)


# --- Template-guided JSON ---------------------------------------------------------------------------------------
# The agent prompts end with `Reply with exactly: {"action":"LONG|SHORT|HOLD","confidence":0-100,...}`. FinGPT (a
# task-tuned LoRA) cannot be relied on to produce that structure, so the server writes the structure itself and lets the
# model choose only the values: enums by comparing the logits of each option's first token, numbers and short strings by
# greedy decoding. The result is always valid JSON in the requested shape.

TEMPLATE_PATTERN = re.compile(r"Reply with exactly:\s*(\{.*\})", re.DOTALL)
ENUM_PATTERN = re.compile(r"^[A-Za-z_]+(\|[A-Za-z_]+)+$")
NUMBER_TOKEN = re.compile(r"^\s?-?[0-9]*\.?[0-9]*$")
WHITESPACE = " \n\t\r"


def parse_template(text, i=0):
    """Tolerant parser for the pseudo-JSON in the prompts -> (node, next_index)."""
    while text[i] in WHITESPACE:
        i += 1
    char = text[i]
    if char == "{":
        fields, i = [], i + 1
        while True:
            while text[i] in WHITESPACE + ",":
                i += 1
            if text[i] == "}":
                return {"type": "object", "fields": fields}, i + 1
            end = text.index('"', i + 1)
            key = text[i + 1:end]
            i = text.index(":", end) + 1
            node, i = parse_template(text, i)
            fields.append((key, node))
    if char == "[":
        node, i = parse_template(text, i + 1)
        while text[i] in WHITESPACE:
            i += 1
        if text[i] == "]":
            i += 1
        return {"type": "array", "item": node, "max": node.pop("array_max", 3)}, i
    if char == '"':
        end = i + 1
        while text[end] != '"' or text[end - 1] == "\\":
            end += 1
        literal = text[i + 1:end]
        if ENUM_PATTERN.match(literal):
            return {"type": "enum", "options": literal.split("|")}, end + 1
        node = {"type": "string", "tokens": 40}
        limit = re.search(r"up to (\d+)", literal)
        if limit:
            node["array_max"] = int(limit.group(1))
        return node, end + 1
    end = i
    while text[end] not in ",}]":
        end += 1
    bare = text[i:end].strip()
    if bare in ("true", "false"):
        return {"type": "boolean"}, end
    span = re.match(r"^(\d+)-(\d+)$", bare)
    if span:
        return {"type": "number", "min": int(span.group(1)), "max": int(span.group(2)), "integer": True}, end
    return {"type": "number", "integer": False}, end


class Decoder:
    """Incremental decoding over a KV cache: feed literal text, then read values off the next-token logits."""

    def __init__(self, model, tokenizer, device):
        self.model, self.tokenizer, self.device = model, tokenizer, device
        self.past, self.logits = None, None
        self._digit_ids = None

    def feed(self, text):
        ids = self.tokenizer.encode(text) if self.past is None else self.tokenizer.encode(text, add_special_tokens=False)
        self.feed_ids(ids)

    def feed_ids(self, ids, chunk=384):
        # Chunked so a long prompt never materialises a big activation block; only the last position's logits are kept.
        for start in range(0, len(ids), chunk):
            piece = torch.tensor([ids[start:start + chunk]], device=self.device)
            out = self.model(input_ids=piece, past_key_values=self.past, use_cache=True, logits_to_keep=1)
            self.past, self.logits = out.past_key_values, out.logits[0, -1]

    def next_piece(self):
        token = int(torch.argmax(self.logits))
        return token, self.tokenizer.decode([token])

    def choose(self, options):
        firsts = [self.tokenizer.encode(option, add_special_tokens=False)[0] for option in options]
        return options[int(torch.argmax(torch.stack([self.logits[t] for t in firsts])))]

    def _closing_ids(self):
        """Token ids that would end a string value (quote, newline, brace, end-of-text); computed once per process."""
        if "closing" not in state:
            ids = [i for i in range(self.logits.shape[0]) if any(mark in self.tokenizer.decode([i]) for mark in ('"', "\n", "{", "}"))]
            ids.append(self.tokenizer.eos_token_id)
            state["closing"] = torch.tensor(sorted(set(ids)), device=self.logits.device)
        return state["closing"]

    def text_value(self, max_tokens, min_tokens=6):
        """Greedy text up to the next quote/newline/brace (not consumed). FinGPT wants to close a string at once, so the
        closing tokens are masked for the first `min_tokens`; a repeated 4-gram also ends it."""
        text, ids = "", []
        for step in range(max_tokens):
            if step < min_tokens:
                masked = self.logits.clone()
                masked[self._closing_ids()] = float("-inf")
                token = int(torch.argmax(masked))
                piece = self.tokenizer.decode([token])
            else:
                token, piece = self.next_piece()
                if token == self.tokenizer.eos_token_id or any(mark in piece for mark in ('"', "\n", "{", "}")):
                    break
            ids.append(token)
            text += piece
            if len(ids) >= 8 and ids[-4:] == ids[-8:-4]:
                break
            self.feed_ids([token])
        text = text.strip()
        # Ran out of tokens mid-sentence: keep whole sentences when there is at least one.
        if len(ids) >= max_tokens and text and text[-1] not in ".!?" and "." in text:
            text = text[:text.rindex(".") + 1]
        return text

    def number_value(self, node):
        if self._digit_ids is None:
            self._digit_ids = torch.tensor(
                [i for i in range(self.logits.shape[0]) if re.fullmatch(r"[0-9]{1,3}", self.tokenizer.decode([i]))],
                device=self.logits.device,
            )
        # The first token must be a digit run; after that the model may keep going (".", more digits) or stop.
        token = int(self._digit_ids[torch.argmax(self.logits[self._digit_ids])])
        text = self.tokenizer.decode([token])
        self.feed_ids([token])
        for _ in range(5):
            token, piece = self.next_piece()
            if not piece.strip() or not NUMBER_TOKEN.match(piece):
                break
            text += piece.strip()
            self.feed_ids([token])
        try:
            value = float(text)
        except ValueError:
            value = float(node.get("min", 0))
        if "min" in node:
            value = min(max(value, node["min"]), node["max"])
        return int(round(value)) if node.get("integer") else round(value, 4)

    def fill(self, node, key=""):
        kind = node["type"]
        if kind == "object":
            result = {}
            self.feed("{")
            for index, (name, child) in enumerate(node["fields"]):
                self.feed(("," if index else "") + json.dumps(name) + ":")
                result[name] = self.fill(child, name)
            self.feed("}")
            return result
        if kind == "enum":
            self.feed('"')
            value = self.choose(node["options"])
            self.feed(value + '"')
            return value
        if kind == "boolean":
            value = self.choose(["true", "false"])
            self.feed(value)
            return value == "true"
        if kind == "number":
            return self.number_value(node)
        if kind == "string":
            self.feed('"')
            value = self.text_value(110 if key == "reasoning" else node["tokens"], 24 if key == "reasoning" else 4)
            self.feed('"')
            return value
        # array: after "[" and after each element the model's own next token says "another one" or "]"
        self.feed("[")
        items = []
        while len(items) < node["max"] and not self.next_piece()[1].lstrip().startswith("]"):
            items.append(self.fill(node["item"], key))
            if len(items) < node["max"] and not self.next_piece()[1].lstrip().startswith("]"):
                self.feed(",")
        self.feed("]")
        return items


def guided_json(model, tokenizer, prompt, device):
    """Fills the last `Reply with exactly: {...}` template found in `prompt`; None when there is no template."""
    template = None
    for match in TEMPLATE_PATTERN.finditer(prompt):
        template = match.group(1)
    if template is None:
        return None
    node, _ = parse_template(template)
    decoder = Decoder(model, tokenizer, device)
    decoder.feed(prompt)
    return decoder.fill(node)


class JsonComplete(StoppingCriteria):
    """Stops once the JSON object opened by the prefill closes (braces balance, ignoring braces inside strings)."""

    def __init__(self, tokenizer, prompt_len):
        self.tokenizer, self.prompt_len = tokenizer, prompt_len

    def __call__(self, input_ids, scores, **kwargs):
        text = "{" + self.tokenizer.decode(input_ids[0][self.prompt_len:], skip_special_tokens=True)
        depth, in_string, escaped = 0, False, False
        for char in text:
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            elif char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return True
        return False


class Message(BaseModel):
    role: str
    content: str | list | None = ""


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[Message]
    max_tokens: int | None = None
    temperature: float | None = 0.2
    response_format: dict | None = None


def text_of(content):
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content or ""


def build_prompt(messages):
    """FinGPT's training template is `Instruction: ... Input: ... Answer:`; system -> Instruction, user -> Input."""
    system = "\n".join(text_of(m.content) for m in messages if m.role == "system").strip()
    user = "\n\n".join(text_of(m.content) for m in messages if m.role != "system").strip()
    return f"Instruction: {system}\nInput: {user}\nAnswer: "


app = FastAPI(title="FinGPT local")


@app.middleware("http")
async def require_key_through_tunnel(request: Request, call_next):
    """Cloudflare adds Cf-Connecting-Ip to everything it proxies (and overwrites a client-supplied one), so its
    presence means the request came from the internet. Those need the bearer token; /health stays open (status only)."""
    if request.url.path.startswith("/v1") and request.headers.get("cf-connecting-ip"):
        supplied = request.headers.get("authorization", "")
        expected = f"Bearer {API_KEY}"
        if not API_KEY or not hmac.compare_digest(supplied.encode(), expected.encode()):
            return JSONResponse({"error": {"message": "Unauthorized."}}, status_code=401)
    return await call_next(request)


@app.on_event("startup")
def start_loading():
    threading.Thread(target=load_model, daemon=True).start()


@app.get("/health")
def health():
    gpu = torch.cuda.memory_allocated(0) / 2**30 if torch.cuda.is_available() else 0
    return {"status": state["status"], "error": state["error"], "model": MODEL_ID, "gpuAllocatedGiB": round(gpu, 2)}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}]}


def completion(text, finish_reason, prompt_ids, generated_ids):
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text.strip()}, "finish_reason": finish_reason}],
        "usage": {
            "prompt_tokens": len(prompt_ids),
            "completion_tokens": len(generated_ids),
            "total_tokens": len(prompt_ids) + len(generated_ids),
        },
    }


@app.post("/v1/chat/completions")
def chat(request: ChatRequest):
    if state["status"] == "loading":
        raise HTTPException(status_code=503, detail="FinGPT is still loading.")
    if state["status"] == "error":
        raise HTTPException(status_code=500, detail=state["error"])

    model, tokenizer = state["model"], state["tokenizer"]
    prompt = build_prompt(request.messages)
    wants_json = bool(request.response_format and request.response_format.get("type") == "json_object")
    device = next(p.device for p in model.parameters() if p.device.type == "cuda") if torch.cuda.is_available() else "cpu"

    # Agent prompts carry a `Reply with exactly: {...}` template: fill it (always valid JSON) instead of free generation.
    if wants_json and TEMPLATE_PATTERN.search(prompt):
        with generate_lock, torch.inference_mode():
            started = time.time()
            filled = guided_json(model, tokenizer, prompt, device)
        text = json.dumps(filled)
        print(f"[fingpt] guided reply in {time.time() - started:.1f}s: {text[:160]}", flush=True)
        return completion(text, "stop", tokenizer.encode(prompt), [])

    # The model is task-tuned, not chat-tuned: starting the answer with "{" keeps a JSON request on-format.
    prefill = "{" if wants_json else ""
    inputs = tokenizer(prompt + prefill, return_tensors="pt", add_special_tokens=True)
    inputs = {key: value.to(device) for key, value in inputs.items()}
    max_new = max(16, min(request.max_tokens or MAX_NEW_TOKENS, MAX_NEW_TOKENS))
    temperature = request.temperature if request.temperature is not None else 0.2
    # FinGPT was tuned for one-word answers and emits end-of-text straight after "{"; hold it back until a JSON body exists.
    json_args = {"min_new_tokens": 24, "stopping_criteria": StoppingCriteriaList([JsonComplete(tokenizer, inputs["input_ids"].shape[1])])} if wants_json else {}
    sampling = {"do_sample": True, "temperature": max(temperature, 0.05), "top_p": 0.9} if temperature > 0 else {"do_sample": False}

    with generate_lock, torch.inference_mode():
        output = model.generate(
            **inputs,
            max_new_tokens=max_new,
            pad_token_id=tokenizer.pad_token_id,
            eos_token_id=[tokenizer.eos_token_id, tokenizer.convert_tokens_to_ids("<|eot_id|>")],
            **sampling,
            **json_args,
        )
    generated = output[0][inputs["input_ids"].shape[1]:]
    text = prefill + tokenizer.decode(generated, skip_special_tokens=True)
    hit_limit = generated.shape[0] >= max_new

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text.strip()},
            "finish_reason": "length" if hit_limit else "stop",
        }],
        "usage": {
            "prompt_tokens": int(inputs["input_ids"].shape[1]),
            "completion_tokens": int(generated.shape[0]),
            "total_tokens": int(inputs["input_ids"].shape[1] + generated.shape[0]),
        },
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
