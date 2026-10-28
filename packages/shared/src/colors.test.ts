import { describe, expect, it } from 'vitest';
import { highlightMarkdown, textColorMarkdown, withoutColors } from './colors';

describe('colours', () => {
  it('writes the default highlight in the short form', () => {
    expect(highlightMarkdown('a', 'yellow')).toBe('==a==');
    expect(highlightMarkdown('a', 'green')).toBe('<mark style="background: green">a</mark>');
    expect(textColorMarkdown('a', 'red')).toBe('<span style="color: red">a</span>');
  });

  it('strips colour markup, also nested', () => {
    expect(withoutColors('Some ==marked== and <span style="color: red">red</span> text.')).toBe('Some marked and red text.');
    expect(withoutColors('<mark style="background: blue"><span style="color: yellow;">both</span></mark>')).toBe('both');
    expect(withoutColors('<span style="color: blue">==inner==</span>')).toBe('inner');
  });

  it('keeps other HTML and equals signs', () => {
    expect(withoutColors('<span style="color: #f00">x</span>')).toBe('<span style="color: #f00">x</span>');
    expect(withoutColors('a == b == c')).toBe('a == b == c');
  });
});
