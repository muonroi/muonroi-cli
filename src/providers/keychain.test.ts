/**
 * Tests for src/providers/keychain.ts
 * Mocks keytar and env vars to verify loadKeyForProvider + firstAvailableProvider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We'll mock keytar at the module level
vi.mock('keytar', () => ({
  getPassword: vi.fn().mockResolvedValue(null),
}));

import { loadKeyForProvider, firstAvailableProvider, ProviderKeyMissingError } from './keychain.js';

describe('loadKeyForProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear env vars
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    // Restore
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('returns key from env var when keytar returns null', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai-key-longer-than-20-chars';
    const key = await loadKeyForProvider('openai');
    expect(key).toBe('sk-test-openai-key-longer-than-20-chars');
  });

  it('throws ProviderKeyMissingError when no key found for non-ollama provider', async () => {
    await expect(loadKeyForProvider('openai')).rejects.toThrow(ProviderKeyMissingError);
  });

  it('returns empty string for ollama when no key set (keyless)', async () => {
    const key = await loadKeyForProvider('ollama');
    expect(key).toBe('');
  });

  it('reads from ANTHROPIC_API_KEY env var', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-long-enough-for-validation';
    const key = await loadKeyForProvider('anthropic');
    expect(key).toBe('sk-ant-test-key-long-enough-for-validation');
  });

  it('reads from GOOGLE_API_KEY env var', async () => {
    process.env.GOOGLE_API_KEY = 'AIzaSyB_test_key_longer_than_twenty';
    const key = await loadKeyForProvider('google');
    expect(key).toBe('AIzaSyB_test_key_longer_than_twenty');
  });
});

describe('firstAvailableProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    vi.restoreAllMocks();
  });

  it('returns anthropic when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-long-enough-for-validation';
    const p = await firstAvailableProvider();
    expect(p).toBe('anthropic');
  });

  it('returns openai when only OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai-key-longer-than-20-chars';
    const p = await firstAvailableProvider();
    expect(p).toBe('openai');
  });

  it('returns ollama as fallback (keyless)', async () => {
    // No keys set — ollama is keyless so it should be found
    const p = await firstAvailableProvider();
    expect(p).toBe('ollama');
  });
});
