import os

from openai import OpenAI

BASE_URL = "https://console.tenstorrent.com/v1"
MODEL = os.environ.get("MODEL", "Qwen/Qwen3-32B")

client = OpenAI(api_key=os.environ["LLM_API_KEY"], base_url=BASE_URL)

stream = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Write a 10 sentence poem."}],
    stream=True,
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)

for chunk in stream:
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)

print()
