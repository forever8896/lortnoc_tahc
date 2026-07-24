import base64, json, sys, time, urllib.request
import os
def _key():
    if os.environ.get('VENICE_API_KEY'):
        return os.environ['VENICE_API_KEY']
    d = os.getcwd()
    while True:
        p = os.path.join(d, '.env')
        if os.path.exists(p):
            for l in open(p):
                if l.startswith('VENICE_API_KEY='):
                    return l.split('=', 1)[1].strip()
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit('No VENICE_API_KEY found ($VENICE_API_KEY or .env in cwd/parents)')
        d = parent
KEY = _key()
def data_url(p):
    ext = p.rsplit('.',1)[-1]
    return f"data:image/{ext};base64," + base64.b64encode(open(p,'rb').read()).decode()
def post(path, payload):
    req = urllib.request.Request('https://api.venice.ai/api/v1'+path, json.dumps(payload).encode(),
        {'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'})
    return urllib.request.urlopen(req, timeout=300)
start, end, prompt, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
q = json.load(post('/video/queue', {
    'model': 'kling-o3-standard-image-to-video',
    'prompt': prompt, 'duration': '5s',
    'image_url': data_url(start), 'end_image_url': data_url(end),
}))
qid = q.get('queue_id') or q.get('id')
print('queued', qid, file=sys.stderr)
for _ in range(90):
    time.sleep(10)
    try:
        r = post('/video/retrieve', {'queue_id': qid, 'model': 'kling-o3-standard-image-to-video'})
        body = r.read()
        if r.headers.get('Content-Type','').startswith('video') or body[:4] == b'\x00\x00\x00' or body[4:8] == b'ftyp':
            open(out,'wb').write(body); print(out); sys.exit(0)
        d = json.loads(body)
        url = d.get('download_url') or (d.get('data') or {}).get('download_url')
        if url:
            open(out,'wb').write(urllib.request.urlopen(url, timeout=180).read()); print(out); sys.exit(0)
    except urllib.error.HTTPError as e:
        if e.code not in (404, 425):
            print('retrieve', e.code, e.read().decode()[:120], file=sys.stderr)
sys.exit('timed out')
