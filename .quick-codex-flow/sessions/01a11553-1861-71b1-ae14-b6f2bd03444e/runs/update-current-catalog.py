import json
import re
from pathlib import Path

path = Path('src/models/catalog.json')
text = path.read_text(encoding='utf-8')
original = json.loads(text)

def render(value):
    return '\n'.join('    ' + line for line in json.dumps(value, indent=2, ensure_ascii=False).splitlines())

def replace_row(row):
    global text
    pattern = r'(?ms)^    \{\n      "id": "' + re.escape(row['id']) + r'".*?^    \}(?=,?\n)'
    text, count = re.subn(pattern, lambda _: render(row), text, count=1)
    assert count == 1, row['id']

rows = []
for id, name, tier, input_rate, output_rate, cached, write, effort in [
    ('gpt-6.1-sol', 'GPT-6.1 Sol', 'balanced', 2, 10, .1, 2.5, 'medium'),
    ('gpt-6-astra', 'GPT-6 Astra', 'premium', 10, 50, 1, 12.5, None),
    ('gpt-6-luna', 'GPT-6 Luna', 'fast', .1, .5, .01, .125, 'medium'),
    ('gpt-6-sol', 'GPT-6 Sol', 'balanced', 2, 10, .2, 2.5, 'medium'),
]:
    rows.append(dict(id=id, name=name, provider='openai', tier=tier,
        context_window=1050000, max_output_tokens=128000,
        input_price_per_million=input_rate, output_price_per_million=output_rate,
        cached_input_price_per_million=cached, cache_write_price_per_million=write,
        long_context_pricing=dict(input_token_threshold=272000, input_multiplier=2, output_multiplier=1.5),
        reasoning=True, thinking_type='enabled', supports_effort=True,
        default_reasoning_effort=effort, supports_vision=True,
        tier_routing=id != 'gpt-6-sol', roles=['leader', 'implement', 'verify', 'research'],
        modalities=dict(input=['text', 'image'], output=['text']),
        native_web_research=True, web_research_kind='web-tool',
        description=f'{name}: text/image input, text output, tool calling through Responses API. Standard API USD/MTok prices; prompts over272K input tokens charge2x all input/cache rates and1.5x output for the whole request. ChatGPT OAuth availability and subscription billing depend on account entitlement. Verified2026-10-08: https://developers.openai.com/api/docs/models/{id}'))

claude = []
for id, name, tier, input_rate, output_rate, cached, write, effort, alias in [
    ('claude-opus-5-5', 'Claude Opus 5.5', 'premium', 4, 20, .2, 5, 'medium', 'opus'),
    ('claude-fable-5-1', 'Claude Fable 5.1', 'premium', 10, 50, .25, 12.5, 'high', 'fable'),
    ('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'balanced', 2, 10, .1, 2.5, 'high', 'sonnet'),
    ('claude-haiku-5-5', 'Claude Haiku 5.5', 'fast', .1, .5, .01, .125, 'medium', 'haiku'),
]:
    slug=id.removeprefix('claude-')
    row = dict(id=id, name=name, provider='anthropic', tier=tier,
        context_window=1000000, max_output_tokens=128000,
        input_price_per_million=input_rate, output_price_per_million=output_rate,
        cached_input_price_per_million=cached, cache_write_price_per_million=write,
        reasoning=True, thinking_type='adaptive', supports_effort=True,
        default_reasoning_effort=effort, supports_vision=True,
        aliases=[alias, name.removeprefix('Claude ').lower().replace(' ', '-')],
        roles=['leader', 'implement', 'verify', 'research'],
        modalities=dict(input=['text', 'image'], output=['text']),
        native_web_research=True, web_research_kind='web-search',
        description=f'{name}: adaptive thinking, text/image input, text output. Standard API USD/MTok; cache write price is5-minute retention (1-hour writes cost2x base input). Omit temperature/top_p/top_k. Verified2026-10-08: https://platform.claude.com/docs/en/models/{slug}/overview')
    if alias == 'haiku':
        row['long_context_pricing'] = dict(input_token_threshold=100000, input_multiplier=5, output_multiplier=5)
        row['description'] += ' Above100K prompt tokens,5x all token rates apply to the whole request.'
    else:
        row['description'] += ' No long-context surcharge. Forced tool choice is not supported.'
    claude.append(row)

for row in original['models']:
    if row['provider'] in ['openai', 'anthropic']:
        row['tier_routing'] = False
        if row['provider'] == 'anthropic':
            row['aliases'] = [alias for alias in row.get('aliases', []) if alias not in ['opus', 'fable', 'sonnet', 'haiku']]
        if row['id'] == 'claude-sonnet-5':
            row['description'] = 'Claude Sonnet5 legacy selectable model. Standard API input/output $2/$10 perMTok, cached input $0.20. Verified2026-10-08: https://platform.claude.com/docs/en/about-claude/pricing'
        replace_row(row)

for additions, anchor in [(rows, 'gpt-5.5'), (claude, 'claude-fable-5')]:
    marker = '    {\n      "id": "' + anchor + '"'
    text = text.replace(marker, ',\n'.join(render(row) for row in additions) + ',\n' + marker, 1)

text = text.replace('"version": "2.19"', '"version": "2.20"', 1)
text = text.replace('"updated_at": "2026-09-23"', '"updated_at": "2026-10-08"', 1)
desc = original['description']
text = text.replace(json.dumps(desc, ensure_ascii=False), json.dumps(desc + ' Current OpenAI GPT6/6.1 and Claude Fable5.1/Opus5.5/Sonnet5.5/Haiku5.5 contracts and pricing verified against official model pages on2026-10-08; long_context_pricing scales the whole request above the input threshold.', ensure_ascii=False), 1)

policy = original['provider_policies']['anthropic']
policy['source_verified_at'] = '2026-10-08'
policy['policy_note'] = 'No peak/off-peak token pricing. Model rows contain standard API prices; subscription billing and account entitlement are separate. Haiku5.5 has per-request prompt-length pricing above100K, recorded in long_context_pricing.'
policy['tier_defaults'] = dict(fast='claude-haiku-5-5', balanced='claude-sonnet-5-5', premium='claude-opus-5-5')
policy['fallback_model_id'] = 'claude-sonnet-5-5'
policy['cache_multipliers']['note'] = 'Writes:5m=1.25x,1h=2x base input. Read rates vary by model; use cached_input_price_per_million from each row.'
policy['cache_multipliers'].pop('cache_read', None)
policy.pop('scheduled_price_changes', None)
pattern = r'(?ms)^    "anthropic": \{.*?^    \}(?=,?\n)'
replacement = '    "anthropic": ' + render(policy).lstrip()
text, count = re.subn(pattern, lambda _: replacement, text, count=1)
assert count == 1

# Change only the catalog's explicit Claude vision fallback, preserving other slots.
text = text.replace('"model_id": "claude-sonnet-5"', '"model_id": "claude-sonnet-5-5"')
result = json.loads(text)
assert len(result['models']) == len(original['models']) + 8
assert {m['id'] for m in original['models']} <= {m['id'] for m in result['models']}
path.write_text(text, encoding='utf-8', newline='\n')
print(json.dumps({'version': result['version'], 'model_count': len(result['models']), 'added': [r['id'] for r in rows + claude]}))
