import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, splitRow } from './markdown';

describe('markdown', () => {
  it('parses a reply table with inline code', () => {
    const blocks = parseMarkdown([
      'Here is the plan:',
      '',
      '| Note | Fix |',
      '|---|---|',
      '| n1 | Replace the square bars with round maple dowels. |',
      '| n2 | Give the `grey_glass` material a tinted finish. |',
      '| n4–n6 | Put each door in its own folder. |',
    ].join('\n'));
    expect(blocks.map((b) => b.type)).toEqual(['p', 'table']);
    const table = blocks[1];
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.head).toEqual([['Note'], ['Fix']]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[1]?.[1]).toEqual(['Give the ', { code: 'grey_glass' }, ' material a tinted finish.']);
  });

  it('keeps pipes inside code and escaped pipes in one cell', () => {
    expect(splitRow('| `a|b` | c \\| d |')).toEqual(['`a|b`', 'c | d']);
  });

  it('reads column alignment and pads short rows', () => {
    const [table] = parseMarkdown('a | b | c\n:-- | :-: | --:\n1 | 2');
    if (table?.type !== 'table') throw new Error('expected a table');
    expect(table.align).toEqual(['left', 'center', 'right']);
    expect(table.rows[0]).toEqual([['1'], ['2'], []]);
  });

  it('parses headings, lists, code and rules', () => {
    const blocks = parseMarkdown('## Plan\n- one\n- two\n\n3. three\n4. four\n\n```\nx = 1\n```\n---');
    expect(blocks).toEqual([
      { type: 'h', level: 2, text: ['Plan'] },
      { type: 'list', ordered: false, start: 1, items: [['one'], ['two']] },
      { type: 'list', ordered: true, start: 3, items: [['three'], ['four']] },
      { type: 'code', text: 'x = 1' },
      { type: 'hr' },
    ]);
  });

  it('parses bold and italic but leaves snake_case and lone asterisks alone', () => {
    expect(parseInline('**bold** and *it* and grey_glass_mat and 2 * 3')).toEqual([
      { b: ['bold'] }, ' and ', { i: ['it'] }, ' and grey_glass_mat and 2 * 3',
    ]);
  });

  it('keeps plain text as one paragraph per block', () => {
    expect(parseMarkdown('line one\nline two\n\nnext')).toEqual([
      { type: 'p', text: ['line one\nline two'] },
      { type: 'p', text: ['next'] },
    ]);
  });
});
