import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { chromium } from 'playwright';
import { startLocal } from './local.mjs';

let browser;
let local;
const nativeFetch = globalThis.fetch;
const authCodes = new Map();
const bindings = {
  GOOGLE_CLIENT_ID: 'browser-test-client',
  GOOGLE_CLIENT_SECRET: 'browser-test-secret',
  AI: {
    async run(model, input) {
      assert.equal(JSON.parse(input.messages[1].content).memo, '旅行を準備する');
      if (model === '@cf/meta/llama-3.1-8b-instruct-fast') {
        assert.equal(input.response_format.type, 'json_object');
        return { choices: [{ message: { content: '形式が崩れた応答' } }] };
      }
      assert.equal(model, '@cf/google/gemma-4-26b-a4b-it');
      return { choices: [{ message: { content: '{"titles":["宿を予約する","日程を決める","持ち物を確認する"]}' } }] };
    }
  }
};

before(async () => {
  globalThis.fetch = async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const code = options.body.get('code');
      const authorization = authCodes.get(code);
      authCodes.delete(code);
      if (!authorization) return new Response(null, { status: 400 });
      const verifier = options.body.get('code_verifier');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      assert.equal(Buffer.from(digest).toString('base64url'), authorization.challenge);
      assert.equal(options.body.get('redirect_uri'), local.origin + '/auth/callback');
      return Response.json({ access_token: authorization.account });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      const account = options.headers.Authorization.slice(7);
      return Response.json({ sub: account, name: account });
    }
    return nativeFetch(url, options);
  };
  local = await startLocal(bindings);
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' })
  });
});

after(async () => {
  await browser?.close();
  if (local) await new Promise(resolve => local.server.close(resolve));
  globalThis.fetch = nativeFetch;
});

async function withPage(fn, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  const navigation = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.isNavigationRequest()) navigation.push(new URL(request.url()).pathname);
  });
  try {
    await fn(page, context);
    assert.deepEqual(errors, []);
  } catch (error) {
    const notice = await page.locator('#notice').textContent({ timeout: 500 }).catch(() => null);
    throw new Error(`ブラウザ遷移: ${navigation.join(' → ')}。画面表示: ${notice ?? 'なし'}`, { cause: error });
  } finally {
    await context.close();
  }
}

async function open(page) {
  await page.goto(local.origin, { waitUntil: 'domcontentloaded' });
  return page.locator('#memo');
}

function task(page, title) {
  return page.locator('.task .cycle').filter({ hasText: title });
}

async function setupGoogle(page, account, invalidState = false) {
  // Playwright routes the first request in a redirect chain. Replace the
  // provider redirect after obtaining the actual Worker response and cookie.
  await page.route('**/auth/google', async route => {
    const start = await route.fetch({ maxRedirects: 0 });
    assert.equal(start.status(), 302);
    const url = new URL(start.headers().location);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), bindings.GOOGLE_CLIENT_ID);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const code = crypto.randomUUID();
    authCodes.set(code, { account, challenge: url.searchParams.get('code_challenge') });
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', invalidState ? 'incorrect' : url.searchParams.get('state'));
    await route.fulfill({ response: start, headers: { ...start.headers(), location: callback.href } });
  });
}

async function login(page, account) {
  await setupGoogle(page, account);
  await page.locator('#login').click();
  await page.locator('#logout').waitFor();
}

test('起動スケルトン上で通信を待たずに入力・保存できる', async () => {
  await withPage(async page => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/session', async route => { await gate; await route.continue().catch(() => {}); });
    try {
      const memo = await open(page);
      const boot = await page.evaluate(() => ({
        focused: document.activeElement.id,
        skeleton: Boolean(document.querySelector('#skeleton')),
        coverage: getComputedStyle(document.querySelector('#skeleton')).position
      }));
      assert.deepEqual(boot, { focused: 'memo', skeleton: true, coverage: 'fixed' });
      await page.keyboard.type('First memo');
      await page.keyboard.press('Enter');
      await task(page, 'First memo').waitFor();
      await page.locator('#skeleton').waitFor({ state: 'detached' });
      assert.equal(await memo.inputValue(), '');
    } finally { release(); }
  }, { viewport: { width: 1440, height: 900 } });
});

test('日本語変換の Enter、複数行、下書きと再読み込み', async () => {
  await withPage(async page => {
    const memo = await open(page);
    await memo.fill('日本語メモ');
    await memo.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    assert.equal(await page.locator('.task').count(), 0);
    await memo.press('End');
    await memo.press('Shift+Enter');
    await page.keyboard.insertText('2行目');
    await page.reload();
    assert.equal(await memo.inputValue(), '日本語メモ\n2行目');
    await memo.press('Enter');
    await page.reload();
    await task(page, '日本語メモ').waitFor();
    assert.equal(await task(page, '日本語メモ').textContent(), '日本語メモ\n2行目');
  });
});

test('クリックで3状態を循環し、絞り込みと削除が保存される', async () => {
  await withPage(async page => {
    const memo = await open(page);
    await memo.fill('見積書');
    await memo.press('Enter');
    const row = task(page, '見積書');
    for (const label of ['進行中', '完了', '未着手']) {
      await row.click();
      await page.locator('.column').filter({ has: page.getByRole('heading', { name: new RegExp(label) }) })
        .locator('.cycle').filter({ hasText: '見積書' }).waitFor();
    }
    await row.click();
    await page.reload();
    await page.locator('[data-filter=done]').click();
    assert.equal(await row.count(), 0);
    await page.locator('[data-filter=doing]').click();
    await row.waitFor();
    await page.getByRole('button', { name: '見積書を削除' }).click();
    await page.reload();
    assert.equal(await row.count(), 0);
    await page.locator('[data-filter=done]').click();
    await page.keyboard.press('/');
    assert.equal(await memo.evaluate(el => el === document.activeElement), true);
  });
});

test('モバイル幅でも横スクロールせず、モーション軽減を尊重する', async () => {
  await withPage(async page => {
    const memo = await open(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#skeleton div').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    await memo.fill('携帯から追加');
    await page.locator('button[type=submit]').click();
    await task(page, '携帯から追加').waitFor();
  }, { viewport: { width: 360, height: 780 }, reducedMotion: 'reduce' });
});

test('OAuth state 不一致を拒否し、未認証の同期 API を保護する', async () => {
  await withPage(async page => {
    await open(page);
    await setupGoogle(page, 'invalid-user', true);
    await page.locator('#login').click();
    await page.locator('#notice').filter({ hasText: /ログインを完了できません/ }).waitFor();
    assert.equal((await page.request.get(local.origin + '/api/tasks')).status(), 401);
    const post = await page.request.post(local.origin + '/api/tasks', { headers: { origin: 'https://example.org' }, data: [] });
    assert.equal(post.status(), 403);
  });
});

test('Google OAuth・SQLite 同期・アカウント分離・AI 提案の選択追加', async () => {
  await withPage(async (page, context) => {
    const memo = await open(page);
    await memo.fill('ログイン前のメモ');
    await memo.press('Enter');
    await login(page, 'user-a');
    await page.getByText('同期済み · user-a').waitFor();
    const api = await (await context.request.get(local.origin + '/api/tasks')).json();
    assert.equal(api.tasks[0].title, 'ログイン前のメモ');

    await memo.fill('旅行を準備する');
    await page.locator('#ai').click();
    await page.getByRole('checkbox', { name: '持ち物を確認する' }).uncheck();
    await page.locator('#add-suggestions').click();
    await task(page, '宿を予約する').waitFor();
    assert.equal(await task(page, '持ち物を確認する').count(), 0);
    await task(page, '宿を予約する').click();
    await page.getByText('同期済み · user-a').waitFor();

    await withPage(async other => {
      await open(other);
      await login(other, 'user-b');
      await other.getByText('同期済み · user-b').waitFor();
      assert.equal(await other.locator('.task').count(), 0);
    });
    await withPage(async secondDevice => {
      await open(secondDevice);
      await login(secondDevice, 'user-a');
      await secondDevice.getByText('同期済み · user-a').waitFor();
      const doing = secondDevice.locator('.column').filter({ has: secondDevice.getByRole('heading', { name: /進行中/ }) });
      await doing.locator('.cycle').filter({ hasText: '宿を予約する' }).waitFor();
    });
    await page.locator('#logout').click();
    await page.locator('#login').waitFor();
    assert.equal(await page.locator('.task').count(), 0);
    assert.equal((await page.request.get(local.origin + '/api/tasks')).status(), 401);
  });
});
