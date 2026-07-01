import json, urllib.request

def bench(label, n_tokens_approx):
    paragraph = "The field of artificial intelligence has undergone remarkable transformations since its formal inception at the Dartmouth Conference in 1956. Early AI research focused on symbolic reasoning, expert systems, and rule-based approaches. These systems struggled with complexity and ambiguity. Machine learning shifted the paradigm toward data-driven approaches. Neural networks showed early promise but faced significant challenges. "
    chars_needed = n_tokens_approx * 4
    long_ctx = (paragraph * (chars_needed // len(paragraph) + 1))[:chars_needed]
    data = json.dumps({
        "model": "x",
        "messages": [{"role": "user", "content": long_ctx + "\n\nWhen was the Dartmouth Conference? One sentence."}],
        "max_tokens": 60, "temperature": 0
    }).encode()
    req = urllib.request.Request("http://127.0.0.1:1234/v1/chat/completions",
        data=data, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        resp = json.load(r)
    t = resp["timings"]
    cached = resp["usage"]["prompt_tokens_details"]["cached_tokens"]
    ptok = resp["usage"]["prompt_tokens"]
    print(f"{label:<6}  ctx={ptok:6d}  cached={cached:6d}  prefill={t['prompt_per_second']:6.1f} t/s  decode={t['predicted_per_second']:5.1f} t/s")

print("label   ctx       cached    prefill          decode")
print("-" * 62)
for label, n in [("2k",2000),("4k",4000),("8k",8000),("12k",12000),("20k",20000),("37k",37000),("55k",55000)]:
    bench(label, n)
