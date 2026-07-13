import json, sys
from pathlib import Path

D = Path(r'D:\Users\hudaq\Downloads')

def find_requests(pattern="*Request_*.json"):
    """Find all request body files"""
    return sorted(D.glob(pattern), key=lambda p: p.stat().st_mtime)

def analyze_pair(req_path, resp_path=None):
    """Analyze a single request+response pair"""
    with open(req_path, encoding='utf-8') as f:
        req = json.load(f)
    
    msgs = req.get('messages', [])
    
    # Count cache_control markers
    cc = 0
    for s in req.get('system', []):
        if s.get('cache_control'): cc += 1
    for m in msgs:
        if isinstance(m.get('content'), list):
            for b in m['content']:
                if b.get('cache_control'): cc += 1
    
    # Find last user msg
    last_user = None
    for i in range(len(msgs) - 1, -1, -1):
        if msgs[i].get('role') == 'user':
            last_user = i
            break
    
    sys_in = len([m for m in msgs if m.get('role') == 'system'])
    
    # Check for trailing empty system
    trailing_sys = 0
    for i in range(len(msgs) - 1, last_user if last_user is not None else 0, -1):
        if msgs[i].get('role') == 'system' and msgs[i].get('content') == []:
            trailing_sys += 1
        else:
            break
    
    result = {
        'rid': req_path.stem.split('_')[-1],
        'msgs': len(msgs),
        'cc': cc,
        'last_user': last_user,
        'sys_in': sys_in,
        'trailing_sys': trailing_sys,
        'model': req.get('model', '?'),
        'size': req_path.stat().st_size,
    }
    
    # Last 4 messages
    tail = []
    for i in range(max(0, len(msgs) - 4), len(msgs)):
        m = msgs[i]
        types = [b.get('type', '?') for b in m['content']] if isinstance(m.get('content'), list) else []
        txt = ''
        if isinstance(m.get('content'), list) and m['content']:
            for b in m['content']:
                t = b.get('text', '') or str(b.get('content', ''))
                if t.strip():
                    txt = ' | ' + t.strip()[:40]
                    break
        tail.append("  [%d] %-6s %s%s" % (i, m['role'], str(types)[:35], txt))
    result['tail'] = tail
    
    # Response cache stats
    if resp_path and resp_path.exists():
        with open(resp_path, encoding='utf-8') as f:
            resp = json.load(f)
        usage = resp.get('usage', {})
        result['cache_hit'] = usage.get('cache_read_input_tokens', usage.get('prompt_cache_hit_tokens', None))
        result['input'] = usage.get('input_tokens', usage.get('prompt_tokens', None))
        hit = result['cache_hit']
        inp = result['input']
        if hit is not None and inp is not None:
            result['hit_rate'] = hit / (hit + (inp if inp > hit else 0)) * 100 if inp > 1 else 99.9
    
    return result

def compare_requests(r1_path, r2_path):
    """Compare two consecutive requests byte-by-byte"""
    with open(r1_path, encoding='utf-8') as f:
        raw1 = f.read()
        b1 = json.loads(raw1)
    with open(r2_path, encoding='utf-8') as f:
        raw2 = f.read()
        b2 = json.loads(raw2)
    
    # First byte diff
    first_byte = None
    for k in range(min(len(raw1), len(raw2))):
        if raw1[k] != raw2[k]:
            first_byte = k
            break
    pct = first_byte / len(raw1) * 100 if first_byte else 100
    
    # First msg diff
    msgs1, msgs2 = b1['messages'], b2['messages']
    first_msg = None
    for i in range(min(len(msgs1), len(msgs2))):
        if json.dumps(msgs1[i], ensure_ascii=False, sort_keys=True) != \
           json.dumps(msgs2[i], ensure_ascii=False, sort_keys=True):
            first_msg = i
            break
    
    sys_same = json.dumps(b1.get('system', []), ensure_ascii=False, sort_keys=True) == \
               json.dumps(b2.get('system', []), ensure_ascii=False, sort_keys=True)
    tools_same = json.dumps(b1.get('tools', []), ensure_ascii=False, sort_keys=True) == \
                 json.dumps(b2.get('tools', []), ensure_ascii=False, sort_keys=True)
    
    return {
        'first_byte': first_byte,
        'pct': pct,
        'first_msg': first_msg,
        'sys_same': sys_same,
        'tools_same': tools_same,
        'growth': len(msgs2) - len(msgs1),
        'size1': len(raw1),
        'size2': len(raw2),
    }


if __name__ == '__main__':
    if len(sys.argv) > 1:
        pattern = sys.argv[1]
    else:
        pattern = "*axonhub_*Request*"
    
    files = find_requests(pattern)
    if not files:
        print("No files found for pattern:", pattern)
        sys.exit(1)
    
    print("=== Request Analysis ===\n")
    results = []
    for f in files:
        rid_suffix = f.stem.split('_')[-1]
        resp_files = list(D.glob(f"*{rid_suffix}*response*"))
        resp_file = resp_files[0] if resp_files else None
        r = analyze_pair(f, resp_file)
        results.append(r)
    
    for r in results:
        print("%s: %dmsgs cc=%d last_user=msg[%d] sys_in=%d trailing_sys=%d model=%s" % (
            r['rid'], r['msgs'], r['cc'], r['last_user'], r['sys_in'], r['trailing_sys'], r['model']))
        for t in r['tail']:
            print(t)
        if 'hit_rate' in r:
            print("  cache: hit=%s input=%s rate=%.1f%%" % (r.get('cache_hit','?'), r.get('input','?'), r['hit_rate']))
        print()
    
    # Consecutive comparison
    print("\n=== Byte-level comparison ===\n")
    for i in range(len(files) - 1):
        c = compare_requests(files[i], files[i+1])
        r1 = Path(files[i]).stem.split('_')[-1]
        r2 = Path(files[i+1]).stem.split('_')[-1]
        print("%s->%s: first_byte=%s (%.1f%%) first_msg=%s sys_same=%s tools_same=%s growth=%+d" % (
            r1, r2, c['first_byte'], c['pct'], c['first_msg'], c['sys_same'], c['tools_same'], c['growth']))
