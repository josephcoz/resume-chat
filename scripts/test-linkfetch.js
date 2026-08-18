#!/usr/bin/env node
// Unit tests for the pure parts of src/linkFetch.ts — no Workers runtime, no
// network. Runs in plain node so link retrieval can be verified before deploy.
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'linkFetch.ts'), 'utf8');

// Transpile the real module with the TypeScript compiler, then load it. The
// fetch half needs a Workers runtime, but the pure helpers are exercised here.
const ts = require('typescript');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const { htmlToText, redactMoney, isSafeUrl, extractUrls } = mod.exports;

let pass = 0, fail = 0;
const t = (name, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  if (ok) { pass++; }
  else { fail++; console.error(`  ✗ ${name}\n      got: ${JSON.stringify(actual)}`); }
};

console.log('extractUrls');
t('finds url', extractUrls('see https://jobs.intuit.com/job/x please')[0], 'https://jobs.intuit.com/job/x');
t('dedupes', extractUrls('https://a.com/1 https://a.com/1').length, 1);
t('none', extractUrls('no links here').length, 0);

console.log('isSafeUrl');
t('https public', isSafeUrl('https://jobs.intuit.com/job/x'), true);
t('http rejected', isSafeUrl('http://example.com'), false);
t('localhost rejected', isSafeUrl('https://localhost/x'), false);
t('private ip rejected', isSafeUrl('https://192.168.1.5/x'), false);
t('metadata ip rejected', isSafeUrl('https://169.254.169.254/latest'), false);
t('ip literal rejected', isSafeUrl('https://8.8.8.8/'), false);
t('.internal rejected', isSafeUrl('https://vault.internal/'), false);
t('file rejected', isSafeUrl('file:///etc/passwd'), false);

console.log('htmlToText');
t('strips script', htmlToText('<p>Keep</p><script>var x="DROP";</script>'), s => s.includes('Keep') && !s.includes('DROP'));
t('strips style', htmlToText('<style>.a{color:red}</style><p>Body</p>'), s => !s.includes('color') && s.includes('Body'));
t('strips nav/footer', htmlToText('<nav>Menu</nav><p>Real</p><footer>Legal</footer>'), s => !s.includes('Menu') && !s.includes('Legal') && s.includes('Real'));
t('bullets survive', htmlToText('<ul><li>Own the forecast</li><li>Run QBR</li></ul>'), s => s.includes('• Own the forecast') && s.includes('• Run QBR'));
t('entities decoded', htmlToText('<p>R&amp;D&nbsp;team</p>'), s => s.includes('R&D team'));
t('comments dropped', htmlToText('<!-- secret --><p>Shown</p>'), s => !s.includes('secret'));

console.log('redactMoney  (must satisfy the output filter in chat.ts)');
t('salary band', redactMoney('Base Pay Range: $163,000 - $220,500'), s => !/\$\s?\d/.test(s));
t('shorthand', redactMoney('raised $44M last year'), s => !/\$\s?\d/.test(s));
t('spelled out', redactMoney('a 1.7 million dollar gap'), s => !/\b\d+(?:\.\d+)?\s?(million|billion|thousand)\b/i.test(s));
t('usd suffix', redactMoney('120,000 USD annually'), s => !/\b\d[\d,.]*\s?USD\b/i.test(s));
t('non-money digits kept', redactMoney('5-8+ years of experience'), s => s.includes('5-8+ years'));

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
