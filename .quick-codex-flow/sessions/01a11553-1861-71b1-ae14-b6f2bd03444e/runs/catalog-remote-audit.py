import hashlib
import json
import pathlib
import subprocess
import urllib.request

def output(args):
    return subprocess.check_output(args, text=True)

container = json.loads(output(['docker', 'inspect', 'muonroi-catalog-1']))[0]
labels = container['Config']['Labels']
report = {
    'container': container['Name'], 'image_id': container['Image'],
    'working_dir': labels.get('com.docker.compose.project.working_dir'),
    'config_files': labels.get('com.docker.compose.project.config_files'),
    'project': labels.get('com.docker.compose.project'),
    'mounts': [{k: item.get(k) for k in ['Type', 'Source', 'Destination']} for item in container['Mounts']],
}
files = report['config_files'].split(',')
compose = ['docker', 'compose']
for file in files:
    compose.extend(['-f', file])
config = json.loads(output(compose + ['config', '--format', 'json']))
service = config['services']['catalog']
report['service'] = {key: service.get(key) for key in ['build', 'image', 'ports', 'volumes']}
raw = subprocess.check_output(['docker', 'exec', 'muonroi-catalog-1', 'cat', '/app/catalog.json'])
catalog = json.loads(raw)
report['catalog'] = {
    'version': catalog['version'], 'updated_at': catalog['updated_at'],
    'sha256': hashlib.sha256(raw).hexdigest(), 'model_count': len(catalog['models']),
    'target_ids': [row['id'] for row in catalog['models'] if row['provider'] in ['openai', 'anthropic']],
}
print(json.dumps(report, indent=2))
