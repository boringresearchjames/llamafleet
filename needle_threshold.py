import requests
BASE = "http://127.0.0.1:1234"
NEEDLE = "The secret passphrase is: COBALT-PENGUIN-7749."
FILLER = ("Scientists have long studied the effects of climate on ecosystems. "
          "The migration patterns of birds change with seasonal temperature variations. "
          "Researchers observe that urban development affects biodiversity in measurable ways. ")

def run(label, reps):
    filler = FILLER * reps
    mid = len(filler) // 2
    prompt = filler[:mid] + " " + NEEDLE + " " + filler[mid:] + "\n\nWhat is the secret passphrase?\nAnswer:"
    r = requests.post(BASE + "/completion", json={"prompt": prompt, "n_predict": 40, "temperature": 0})
    d = r.json()
    u = d.get("timings", {})
    ctx = u.get("prompt_n", 0) + u.get("cache_n", 0)
    reply = d.get("content", "")
    found = any(x in reply for x in ["COBALT", "PENGUIN", "7749"])
    print(f"{label}  ctx={ctx:>6}  {'PASS' if found else 'FAIL'}  {repr(reply[:100])}", flush=True)

run("  50 reps (~500 tok)",   50)
run(" 200 reps (~2k tok)",   200)
run(" 500 reps (~5k tok)",   500)
run("1500 reps (~15k tok)", 1500)
run("3000 reps (~30k tok)", 3000)
