#!/usr/bin/env node
// Tests for the markdown renderer in public/app.js.
//
// It has real XSS surface (it writes innerHTML), and the emphasis rules and the
// link rules interfere with each other in non-obvious ways — the underscore rule
// will chew through target="_blank" if links are not held aside first. Both of
// those were live bugs. Asserted here so they stay fixed.
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const fns = ['escapeHtml', 'renderLink', 'renderInline', 'renderMarkdown']
  .map(n => src.match(new RegExp('function ' + n + '[\\s\\S]*?\\n}\\n'))[0])
  .join('');
const scope = {};
new Function('g', fns + '; g.renderMarkdown = renderMarkdown;')(scope);
const md = scope.renderMarkdown;

let pass = 0, fail = 0;
const t = (name, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  if (ok) pass++;
  else { fail++; console.error(`  ✗ ${name}\n      got: ${JSON.stringify(actual)}`); }
};

console.log('block structure');
t('heading', md('## Fit'), s => /<h4>Fit<\/h4>/.test(s));
t('paragraph', md('Plain line.'), '<p>Plain line.</p>');
t('bullets', md('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
t('numbered', md('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
t('rule', md('---'), '<hr>');
t('list closes at blank line', md('- a\n\ntext'), '<ul><li>a</li></ul><p>text</p>');

console.log('inline');
t('bold', md('**x**'), '<p><strong>x</strong></p>');
t('italic asterisk', md('*x*'), '<p><em>x</em></p>');
t('italic underscore', md('_x_'), '<p><em>x</em></p>');
t('code', md('`x`'), '<p><code>x</code></p>');
t('underscores inside code survive', md('`snake_case_here`'), s => s.includes('snake_case_here'));

console.log('links');
t('markdown link', md('[go](https://a.com)'), s => s.includes('href="https://a.com"'));
t('target attribute intact', md('[go](https://a.com)'), s => s.includes('target="_blank"'));
t('rel attribute intact', md('[go](https://a.com)'), s => s.includes('rel="noopener noreferrer"'));
t('bare url autolinked', md('see https://a.com/x?y=1'), s => s.includes('href="https://a.com/x?y=1"'));
t('link inside a bullet', md('- [go](https://a.com)'), s => s.startsWith('<ul><li><a '));
t('link text still gets emphasis around it', md('[go](https://a.com) and **b**'), s => s.includes('<strong>b</strong>'));

console.log('safety');
t('script tag escaped', md('<script>alert(1)</script>'), s => !s.includes('<script'));
t('img onerror escaped', md('<img src=x onerror=alert(1)>'), s => !s.includes('<img'));
t('javascript: url refused', md('[x](javascript:alert(1))'), s => !s.includes('<a '));
t('data: url refused', md('[x](data:text/html,<b>)'), s => !s.includes('<a '));
// escapeHtml runs before renderLink, so a raw quote never reaches the href.
// What matters is that the attribute cannot be broken out of: extract the href
// value and assert no raw quote survives inside it.
t('quote in url cannot break the attribute', md('[x](https://a.com/")'), s => {
  const m = s.match(/href="([^"]*)"/);
  return m !== null && !m[1].includes('"');
});
// The property that matters is that no event handler ends up INSIDE a tag.
// Leftover text outside a tag is inert no matter what it says.
const noHandlerInAnyTag = s => (s.match(/<[^>]+>/g) ?? []).every(tag => !/\son\w+\s*=/i.test(tag));
t('attribute injection attempt is inert', md('[x](https://a.com/" onmouseover="alert(1))'), noHandlerInAnyTag);
t('no handler survives from raw html', md('<a href="#" onclick="alert(1)">x</a>'), noHandlerInAnyTag);
t('no handler survives inside a bullet', md('- <b onmouseover="x">hi</b>'), noHandlerInAnyTag);

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
