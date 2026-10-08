import hashlib
import json
import pathlib
import subprocess
import urllib.error
import urllib.request

release = pathlib.Path('/opt/muonroi/catalog-releases/20261008-2.20-a95fbfe00871')
container = json.loads(subprocess.check_output(['docker', 'inspect', 'muonroi-catalog-1'], text=True))[0]
environment = dict(entry.split('=', 1) for entry in container['Config']['Env'] if '=' in entry)
key = environment.get('CATALOG_API_KEY', '')
headers = {'X-API-Key': key} if key else {}
headers['Cache-Control'] = 'no-cache'
headers['User-Agent'] = 'undici'
source = json.loads((release / 'src/models/catalog.json').read_text())
new_models = [model for model in source['models'] if model['id'] in {
    'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
    'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'}]
report = []
for name, base in [('localhost', 'http://127.0.0.1:8086'), ('public', 'https://catalog.muonroi.com')]:
    url = base + '/api/v1/models?release=2.20-a95fbfe00871'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as response:
            payload = json.load(response)
            status, etag = response.status, response.headers.get('ETag')
    except urllib.error.HTTPError as error:
        print(json.dumps({'endpoint': name, 'status': error.code, 'error': str(error), 'body': error.read().decode()[:300]}))
        raise
    except Exception as error:
        print(json.dumps({'endpoint': name, 'error': str(error)}))
        raise
    assert payload['version'] == '2.20'
    assert {m['id'] for m in payload['models']} == {m['id'] for m in source['models']}
    by_id = {row['id']: row for row in payload['models']}
    for model in new_models:
        for field in ['context_window', 'max_output_tokens', 'input_price_per_million', 'output_price_per_million',
                'cached_input_price_per_million', 'cache_write_price_per_million', 'thinking_type',
                'supports_effort', 'supports_vision', 'modalities', 'long_context_pricing']:
            if field in model:
                assert by_id[model['id']][field] == model[field], (name, model['id'], field)
    (release / (name + '-response.json')).write_text(json.dumps(payload, indent=2))
    report.append({'endpoint': name, 'status': status, 'version': payload['version'], 'model_count': len(payload['models']),
        'new_models_verified': len(new_models), 'etag': etag})
assert len(new_models) == 8
expected = json.loads((release / 'manifest.json').read_text())['files']
for relative, checksum in expected.items():
    assert hashlib.sha256((pathlib.Path('/opt/muonroi/muonroi-cli') / relative).read_bytes()).hexdigest() == checksum
result = {'endpoints': report, 'remote_source_checksums_match': True,
    'image_id': container['Image'], 'health': container['State'].get('Health', {}).get('Status')}
(release / 'verification-result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
