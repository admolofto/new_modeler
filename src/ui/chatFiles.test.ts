import { describe, expect, it } from 'vitest';
import { classifyFile, fileBlock, fitWithin, MAX_TEXT_CHARS } from './chatFiles';

describe('chat files', () => {
  it('sends pictures as images and text files inline', () => {
    expect(classifyFile('shot.png', 'image/png')).toBe('image');
    expect(classifyFile('photo.webp', 'image/webp')).toBe('image');
    expect(classifyFile('cuts.csv', '')).toBe('text');
    expect(classifyFile('notes.md', 'text/markdown')).toBe('text');
    expect(classifyFile('data.json', 'application/json')).toBe('text');
    expect(classifyFile('logo.svg', 'image/svg+xml')).toBe('text');
  });

  it('explains what it cannot send', () => {
    expect(classifyFile('plans.pdf', 'application/pdf')).toEqual({ unsupported: expect.stringContaining('PDF') });
    expect(classifyFile('model.skp', 'application/octet-stream')).toEqual({ unsupported: expect.stringContaining('model.skp') });
  });

  it('scales big pictures down to the longest side, never up', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('wraps text files with their name and cuts very long ones', () => {
    expect(fileBlock('cuts.csv', 'a,b')).toBe('<file name="cuts.csv">\na,b\n</file>');
    const long = fileBlock('big.txt', 'x'.repeat(MAX_TEXT_CHARS + 10));
    expect(long).toContain('was cut off');
    expect(long.length).toBeLessThan(MAX_TEXT_CHARS + 200);
  });
});
