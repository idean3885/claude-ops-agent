#!/usr/bin/env node
// job-crawler 결정적 자체 테스트. 네트워크·Chromium 없이 `node selftest.js` 로 돈다.
// 가짜 브라우저·가짜 페이지와 순수 함수만 쓴다.

const assert = require('assert');
const { selectTargets } = require('./crawl');
const { collectOne } = require('./lib/collect');
const { compileRules } = require('./lib/scorer');
const { renderReport, linkHostMismatch } = require('./lib/report');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// 대상마다 목록이 다른 가짜 브라우저. 기본 컨텍스트(browser.newPage)는 모든 대상이
// 공유하는 상태(마지막에 본 목록)를 갖고, 격리 컨텍스트는 매번 비어 있다.
function fakeBrowser(listsByUrl) {
  const log = { contexts: 0, closed: 0, sharedPages: 0 };
  let shared = null;
  const makePage = (state) => {
    let current = null;
    return {
      setUserAgent: async () => {},
      setViewport: async () => {},
      goto: async (url) => { current = url; state.last = state.last || listsByUrl[url]; },
      waitForSelector: async () => { throw new Error('timeout'); },
      evaluate: async () => {},
      $$eval: async () => state.last || [],
      close: async () => {},
      url: () => current,
    };
  };
  return {
    log,
    newPage: async () => {
      log.sharedPages++;
      shared = shared || {};
      return makePage(shared);
    },
    createBrowserContext: async () => {
      log.contexts++;
      const state = {};
      return { newPage: async () => makePage(state), close: async () => { log.closed++; } };
    },
  };
}

const ctx = {
  threshold: 3,
  linkPattern: /Engineer/i,
  rules: compileRules([{ pattern: 'Engineer', delta: 5, label: 'eng' }]),
};
const A = 'https://a.example/jobs';
const B = 'https://b.example/jobs';
const lists = {
  [A]: [{ text: 'A Backend Engineer', href: 'https://a.example/1' }],
  [B]: [{ text: 'B Platform Engineer', href: 'https://b.example/2' }],
};

test('939 대상마다 격리 컨텍스트를 열고 닫는다 (대상 사이 상태 공유 없음)', async () => {
  const browser = fakeBrowser(lists);
  const ra = await collectOne(browser, 'A', { url: A, extract: { container: 'li' } }, ctx);
  const rb = await collectOne(browser, 'B', { url: B, extract: { container: 'li' } }, ctx);
  assert.strictEqual(browser.log.sharedPages, 0);
  assert.strictEqual(browser.log.contexts, 2);
  assert.strictEqual(browser.log.closed, 2);
  assert.deepStrictEqual(ra.jobs.map((j) => j.url), ['https://a.example/1']);
  assert.deepStrictEqual(rb.jobs.map((j) => j.url), ['https://b.example/2']);
});

test('939 waitFor 실패는 결과에 기록되고 리포트가 경고한다', async () => {
  const browser = fakeBrowser(lists);
  const r = await collectOne(browser, 'A', { url: A, waitFor: '.list', extract: { container: 'li' } }, ctx);
  assert.strictEqual(r.waitForFailed, '.list');
  const md = renderReport([r], { ...ctx, detail: false, restCap: 10 });
  assert.match(md, /렌더 대기 실패/);
});

test('939 링크 호스트가 대상 호스트와 하나도 안 맞으면 경고한다', () => {
  assert.deepStrictEqual(
    linkHostMismatch(A, [{ url: 'https://b.example/2' }, { url: 'https://c.example/3' }]),
    ['b.example', 'c.example']
  );
  assert.strictEqual(linkHostMismatch(A, [{ url: 'https://b.example/2' }, { url: 'https://www.a.example/1' }]), null);
  assert.strictEqual(linkHostMismatch(A, [{ url: 'https://jobs.a.example/1' }]), null);
  const r = { name: 'A', url: A, count: 1, jobs: [{ title: 'x', url: 'https://b.example/2', score: 5, verdict: '핏 후보', reasons: [] }] };
  const md = renderReport([r], { ...ctx, detail: false, restCap: 10 });
  assert.match(md, /링크 호스트 불일치/);
});

test('939 --url 은 프로파일 targets 를 건너뛰고 그 대상 하나만 돈다', () => {
  const profile = { targets: { P1: { url: A }, P2: { url: B } } };
  const cli = { only: [], adhoc: { url: 'https://x.example/jobs', name: 'X' } };
  assert.deepStrictEqual(selectTargets(profile, cli), [['X', { url: 'https://x.example/jobs' }]]);
  assert.strictEqual(selectTargets(profile, { only: [], adhoc: {} }).length, 2);
  assert.throws(() => selectTargets(profile, { only: [], adhoc: { url: A } }), /함께/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} 통과`);
  process.exit(failed ? 1 : 0);
})();
