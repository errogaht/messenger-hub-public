import {test} from 'node:test';import assert from 'node:assert/strict';
import {protectedLiterals} from '../src/protected-literals.mjs';
const source='Контрольное число 73847. Ссылка https://example.com/a?test=73847.';
const url='https://example.com/a?test=73847';
test('complex HTML self-labelled link counts once and inline markup preserves the amount',()=>{
 // Faithful reproduction of the real model output that the old regex rejected.
 const html=`<p><a href="${url}">${url}</a></p><h3>Подробности</h3><table><tr><td>Контрольное число</td><td>73<strong>847</strong></td></tr></table><details><summary>Проверка</summary><p>Готово</p></details>`;
 assert.deepEqual(protectedLiterals(html),protectedLiterals(source));
 assert.deepEqual(protectedLiterals(`[${url}](${url}) 73847`),protectedLiterals(source));
});
test('entity escapes are transport formatting, but altered targets or duplicated facts still fail',()=>{
 // Do not deduplicate globally: an extra link/amount or changed query is still unsafe.
 const original='Цена 100 https://example.com/?a=1&b=2',expected=protectedLiterals(original);
 const href='https://example.com/?a=1&amp;b=2';
 assert.deepEqual(protectedLiterals(`<h2>Цена 100</h2><a href="${href}"><span>https://example.com/?a=1&amp;b=2</span></a>`),expected);
 assert.deepEqual(protectedLiterals(`<p>Цена &#49;00</p><a href="${href}">Открыть</a>`),expected);
 for(const html of [`<p>Цена 200</p><a href="${href}">Открыть</a>`,`<p>Цена 100 100</p><a href="${href}">Открыть</a>`,`<p>Цена 100</p><a href="${href}">Открыть</a><a href="${href}">Снова</a>`,`<p>Цена 100</p><a href="https://example.com/?a=1&amp;b=3">Открыть</a>`,`<p>Цена 100</p><a href="${href}">https://evil.example/</a>`])assert.notDeepEqual(protectedLiterals(html),expected);
 assert.notDeepEqual(protectedLiterals(`<p>Цена 100</p><a href="https://example.com/?b=2&amp;a=1">Открыть</a>`),expected);
});
