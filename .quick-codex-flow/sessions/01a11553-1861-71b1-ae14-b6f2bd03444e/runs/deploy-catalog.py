import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request

release = pathlib.Path(sys.argv[1]).resolve()
assert release.parent == pathlib.Path('/opt/muonroi/catalog-releases')
manifest = json.loads((release / 'manifest.json').read_text())
for relative, expected in manifest['files'].items():
    assert hashlib.sha256((release / relative).read_bytes()).hexdigest() == expected, relative

def run(args, capture=False):
    return subprocess.check_output(args, text=True) if capture else subprocess.check_call(args)

before = json.loads(run(['docker', 'inspect', 'muonroi-catalog-1'], True))[0]
image_name = before['Config']['Image']
assert image_name == 'muonroi-catalog'
old_image = before['Image']
labels = before['Config']['Labels']
compose = ['docker', 'compose']
for file in labels['com.docker.compose.project.config_files'].split(','):
    compose += ['-f', file]
checkout = pathlib.Path('/opt/muonroi/muonroi-cli')
paths = list(manifest['files'])
assert not run(['git', '-C', str(checkout), 'status', '--porcelain', '--', *paths], True).strip(), 'Remote target files have WIP'
containers_before = [json.loads(line) for line in run(['docker', 'ps', '--format', 'json'], True).splitlines()]
candidate = 'muonroi-catalog:catalog-2.20-' + manifest['files']['src/models/catalog.json'][:12]
rollback = 'muonroi-catalog:rollback-20261008-' + old_image.split(':')[1][:12]
run(['docker', 'tag', old_image, rollback])
(release / 'rollback.json').write_text(json.dumps({'old_image': old_image, 'rollback_tag': rollback,
    'compose_files': labels['com.docker.compose.project.config_files'], 'source_paths': paths,
    'other_containers': [{'name': c['Names'], 'id': c['ID']} for c in containers_before if c['Names'] != 'muonroi-catalog-1']}, indent=2))
print(json.dumps({'stage': 'build', 'candidate': candidate, 'rollback': rollback}), flush=True)
run(['docker', 'build', '-f', str(release / 'services/catalog-api/Dockerfile'), '-t', candidate, str(release)])
smoke = """import json,main
from fastapi.testclient import TestClient
from pathlib import Path
source=json.loads(Path('/app/catalog.json').read_text())
response=TestClient(main.app).get('/api/v1/models')
assert response.status_code==200,response.text
served=response.json()
assert served['version']=='2.20'
assert len(served['models'])==len(source['models'])
rows={r['id']:r for r in served['models']}
for model in source['models']:
 for field in ['modalities','long_context_pricing']:
  if field in model: assert rows[model['id']][field]==model[field],(model['id'],field)
print(json.dumps({'stage':'image-smoke','version':served['version'],'models':len(rows)}))
"""
run(['docker', 'run', '--rm', candidate, 'python', '-c', smoke])

# Preserve source files for rollback and keep the next ordinary Compose build current.
backup = release / 'source-before'
for relative in paths:
    target = checkout / relative
    previous = backup / relative
    previous.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(target, previous)
changed = False
try:
    assert not run(['git', '-C', str(checkout), 'status', '--porcelain', '--', *paths], True).strip(), 'Remote target files changed during build'
    changed = True
    for relative in paths:
        target = checkout / relative
        temporary = target.with_name(target.name + '.catalog-release-tmp')
        shutil.copyfile(release / relative, temporary)
        temporary.replace(target)
    run(['docker', 'tag', candidate, image_name])
    run(compose + ['up', '-d', '--no-deps', '--no-build', 'catalog'])
    for attempt in range(60):
        container = json.loads(run(['docker', 'inspect', 'muonroi-catalog-1'], True))[0]
        if container['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(1)
    else:
        raise RuntimeError('Catalog container did not become healthy within60s')
    with urllib.request.urlopen('http://127.0.0.1:8086/health', timeout=10) as response:
        health = json.load(response)
    assert health['version'] == '2.20', health
    containers_after = [json.loads(line) for line in run(['docker', 'ps', '--format', 'json'], True).splitlines()]
    after_ids = {c['Names']: c['ID'] for c in containers_after}
    for c in containers_before:
        if c['Names'] != 'muonroi-catalog-1':
            assert after_ids.get(c['Names']) == c['ID'], 'Other container changed: ' + c['Names']
    result = dict(stage='deployed', candidate=candidate, image_id=container['Image'],
        health=health, other_containers_unchanged=len(containers_before)-1, rollback=rollback)
    (release / 'deployment-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
except Exception as error:
    print(json.dumps({'stage': 'deployment-failed', 'error': str(error), 'rollback': rollback}), file=sys.stderr, flush=True)
    if changed:
        for relative in paths:
            shutil.copy2(backup / relative, checkout / relative)
        run(['docker', 'tag', old_image, image_name])
        run(compose + ['up', '-d', '--no-deps', '--no-build', 'catalog'])
    raise
