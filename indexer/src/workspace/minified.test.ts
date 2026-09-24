import { describe, expect, test } from 'bun:test';
import { detectMinified } from './minified.ts';

describe('detectMinified', () => {
  test('normal source code with regular lines is not minified', () => {
    const normalTs = [
      "import { useState } from 'react';",
      '',
      'export function Counter() {',
      '  const [count, setCount] = useState(0);',
      '',
      '  function increment() {',
      '    setCount(count + 1);',
      '  }',
      '',
      '  return (',
      '    <button onClick={increment}>',
      '      Clicked {count} times',
      '    </button>',
      '  );',
      '}',
    ]
      .join('\n')
      .repeat(10); // make it > 1.5KB

    const result = detectMinified('src/components/Counter.tsx', normalTs, normalTs.length);
    expect(result.isMinified).toBe(false);
  });

  test('normal file with an embedded long line (e.g. SVG or base64) is not minified', () => {
    const regularLines = 'const x = 1;\n'.repeat(50);
    const longSvgLine = `const svg = "${'a'.repeat(1200)}";\n`;
    const moreRegular = 'const y = 2;\n'.repeat(50);
    const content = regularLines + longSvgLine + moreRegular;

    const result = detectMinified('src/assets/icon.ts', content, content.length);
    expect(result.isMinified).toBe(false);
  });

  test('file with .min.js extension is detected as minified', () => {
    const content = 'var a=1;'.repeat(100); // > 512 bytes
    const result = detectMinified('vendor/jquery.min.js', content, content.length);
    expect(result.isMinified).toBe(true);
    expect(result.reason).toContain('minified extension');
  });

  test('file with extreme line length (> 10,000 chars) is detected', () => {
    const content = 'a'.repeat(12000);
    const result = detectMinified('unknown/packed.js', content, content.length);
    expect(result.isMinified).toBe(true);
    expect(result.reason).toContain('extreme line length');
  });

  test('webpack bundle in public/js/ is detected', () => {
    const chunkLine =
      '/*! For license information */ window.webpackChunk=window.webpackChunk||[];' +
      'var a=1;'.repeat(200) +
      '\n';
    const codeLine = `function(e,t,n){${'var r=n(1);'.repeat(200)}}\n`;
    const content = chunkLine + codeLine;

    const result = detectMinified('backend/public/js/app.js', content, content.length);
    expect(result.isMinified).toBe(true);
    expect(result.reason).toContain('public/dist asset directory');
  });

  test('bundle containing signatures with lines > 1,000 chars is detected', () => {
    const content = `/* webpackChunkName */ var x = 1; ${'foo();'.repeat(300)}\nvar y = 2;\n`;
    const result = detectMinified('assets/chunk.js', content, content.length);
    expect(result.isMinified).toBe(true);
    expect(result.reason).toContain('bundle signatures');
  });

  test('high average line length (> 500 chars) across few lines is detected', () => {
    const lines = ['a'.repeat(800), 'b'.repeat(700), 'c'.repeat(900)].join('\n');

    const result = detectMinified('build/out.js', lines, lines.length);
    expect(result.isMinified).toBe(true);
    expect(result.reason).toContain('average line length');
  });

  test('small file (< 1.5 KB) is not minified even if on 1 line', () => {
    const small = 'export default { message: "hello world" };';
    const result = detectMinified('src/config.js', small, small.length);
    expect(result.isMinified).toBe(false);
  });
});
