import { parseJsonSafely } from '../src/lib/parseJsonSafely.js';

describe('parseJsonSafely', () => {
  test('should parse clean JSON', () => {
    const cleanJson = '{"name": "test", "value": 123}';
    const result = parseJsonSafely(cleanJson);
    
    expect(result.ok).toBe(true);
    expect(result.json).toEqual({ name: 'test', value: 123 });
    expect(result.error).toBeNull();
  });

  test('should parse JSON with noisy prefix/suffix', () => {
    const noisyJson = 'Here is the response:\n{"name": "test", "value": 123}\nEnd of response.';
    const result = parseJsonSafely(noisyJson);
    
    expect(result.ok).toBe(true);
    expect(result.json).toEqual({ name: 'test', value: 123 });
  });

  test('should handle smart quotes', () => {
    const smartQuotesJson = '{"name": "test", "description": "smart quotes"}';
    const result = parseJsonSafely(smartQuotesJson);
    
    expect(result.ok).toBe(true);
    expect(result.json).toEqual({ name: 'test', description: 'smart quotes' });
  });

  test('should handle trailing commas', () => {
    const trailingCommaJson = '{"name": "test", "value": 123,}';
    const result = parseJsonSafely(trailingCommaJson);
    
    expect(result.ok).toBe(true);
    expect(result.json).toEqual({ name: 'test', value: 123 });
  });

  test('should handle unparseable input', () => {
    const unparseable = 'This is not JSON at all';
    const result = parseJsonSafely(unparseable);
    
    expect(result.ok).toBe(false);
    expect(result.json).toBeNull();
    expect(result.error).toBeTruthy();
  });

  test('should handle non-string input', () => {
    const result = parseJsonSafely(null);
    
    expect(result.ok).toBe(false);
    expect(result.json).toBeNull();
    expect(result.error).toBeTruthy();
  });

  test('should handle complex nested JSON', () => {
    const complexJson = `Some text before
    {
      "user": {
        "name": "John",
        "scores": [85, 90, 75],
        "active": true
      }
    }
    Some text after`;
    const result = parseJsonSafely(complexJson);
    
    expect(result.ok).toBe(true);
    expect(result.json.user.name).toBe('John');
    expect(result.json.user.scores).toEqual([85, 90, 75]);
  });
});

