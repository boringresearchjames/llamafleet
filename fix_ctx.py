import json
with open('/var/lib/llamafleet/api/state.json') as f: s=json.load(f)
for ic in s.get('instanceConfigs',[]):
    for inst in ic.get('instances',[]):
        if '86562188' in inst.get('id',''):
            inst['contextLength'] = 131072
            print('updated', inst['id'][:8])
with open('/var/lib/llamafleet/api/state.json','w') as f: json.dump(s,f,indent=2)