const $ = (selector) => document.querySelector(selector);
const memo = $('#memo');
const board = $('#board');
const statuses = { todo: '未着手', doing: '進行中', done: '完了' };
const stages = Object.keys(statuses);
const storagePrefix = 'taskdesk:v1:';
const nav = [...document.querySelectorAll('[data-filter]')];
const suggestions = $('#suggestions');
const ai = $('#ai');
let filter = 'all';
let user = null;
let scope = 'guest';
let tasks = read(scope);
let syncing = false;
let pullAgain = false;
let aiRequest;
let sessionReady = false;
let sessionLoad = 0;

function read(key) {
  try {
    return new Map(JSON.parse(localStorage.getItem(storagePrefix + key) || '[]').map(task => [task.id, task]));
  } catch {
    return new Map();
  }
}

function persist(next = tasks) {
  try {
    localStorage.setItem(storagePrefix + scope, JSON.stringify([...next.values()]));
    tasks = next;
    return true;
  } catch {
    tell('端末に保存できませんでした。ブラウザの保存設定や空き容量を確認してください。');
    return false;
  }
}

function tell(message) {
  $('#notice').textContent = message;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function render(animated = [], focusId) {
  const active = [...tasks.values()].filter(task => !task.deleted);
  const counts = Object.fromEntries(stages.map(status => [status, active.filter(task => task.status === status).length]));
  nav.forEach(button => {
    const value = button.dataset.filter;
    button.setAttribute('aria-pressed', value === filter);
    button.lastElementChild.textContent = value === 'all' ? active.length : counts[value];
  });
  $('#board-title').textContent = filter === 'all' ? 'すべてのタスク' : statuses[filter];
  $('#total').textContent = (filter === 'all' ? active.length : counts[filter]) + ' 件';
  board.classList.toggle('filtered', filter !== 'all');
  const focused = focusId ?? document.activeElement?.dataset.task;
  const columns = (filter === 'all' ? stages : [filter]).map(status => {
    const column = element('section', 'glass column');
    const heading = element('h3', '');
    heading.append(element('span', 'dot ' + status), element('span', '', statuses[status]), element('span', '', counts[status]));
    column.append(heading);
    const rows = active.filter(task => task.status === status).sort((a, b) => b.created - a.created);
    if (!rows.length) column.append(element('p', 'empty', 'タスクはありません'));
    for (const task of rows) {
      const row = element('div', 'task' + (animated.includes(task.id) ? ' arrival' : ''));
      const cycle = element('button', 'cycle', task.title);
      cycle.dataset.task = task.id;
      const next = stages[(stages.indexOf(status) + 1) % stages.length];
      cycle.setAttribute('aria-label', task.title + 'を' + statuses[next] + 'に変更');
      cycle.title = 'クリックで' + statuses[next] + 'に変更';
      cycle.onclick = () => {
        if (change([{ ...task, status: next }], task.id)) tell(statuses[next] + 'に変更しました。');
      };
      const remove = element('button', 'remove', '×');
      remove.setAttribute('aria-label', task.title + 'を削除');
      remove.onclick = () => {
        if (change([{ ...task, deleted: 1 }], task.id)) tell('タスクを削除しました。');
      };
      row.append(cycle, remove);
      column.append(row);
    }
    return column;
  });
  board.replaceChildren(...columns);
  if (focused) (board.querySelector('[data-task="' + CSS.escape(focused) + '"]') ??
    nav.find(button => button.dataset.filter === filter)).focus({ preventScroll: true });
}

function change(changes, focusId) {
  const next = read(scope);
  for (const task of changes) {
    if (!user && task.deleted) next.delete(task.id);
    else next.set(task.id, { ...task, updated: Math.max(Date.now(), (task.updated ?? 0) + 1), dirty: Boolean(user) });
  }
  if (!persist(next)) return false;
  render(changes.map(task => task.id), focusId);
  if (user) sync();
  return true;
}

function add(titles) {
  return change(titles.map(title => ({ id: crypto.randomUUID(), title, status: 'todo', created: Date.now(), deleted: 0 })));
}

async function api(path, body, timeout = 12000) {
  const response = await fetch(path, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '通信に失敗しました。');
  return data;
}

async function sync() {
  if (!user) return;
  if (syncing) {
    pullAgain = true;
    return;
  }
  syncing = true;
  const activeScope = scope;
  const label = $('#sync-label');
  label.textContent = '同期中…';
  try {
    do {
      pullAgain = false;
      const pending = [...read(scope).values()].filter(task => task.dirty).slice(0, 50);
      const { tasks: remote } = pending.length ? await api('/api/tasks', pending) : await api('/api/tasks');
      if (activeScope !== scope) break;
      const next = new Map(remote.filter(task => !task.deleted).map(task => [task.id, task]));
      for (const task of read(scope).values()) {
        if (task.dirty && !pending.some(item => item.id === task.id && item.updated === task.updated)) {
          next.set(task.id, task);
        }
      }
      if (!persist(next)) throw new Error('保存に失敗しました。');
      render();
      pullAgain ||= [...tasks.values()].some(task => task.dirty);
    } while (pullAgain);
    if (activeScope === scope) label.textContent = '同期済み · ' + user.name;
  } catch {
    if (activeScope === scope) label.textContent = '同期保留 · ' + user.name;
  } finally {
    syncing = false;
    if (scope !== activeScope && user) sync();
  }
}

function account() {
  $('#login').hidden = Boolean(user);
  $('#logout').hidden = !user;
  $('#sync-label').textContent = user ? user.name : 'この端末に保存';
}

async function loadSession() {
  const request = ++sessionLoad;
  try {
    const session = await api('/api/session');
    if (request !== sessionLoad) return;
    if (!session.user) {
      if (user) {
        aiRequest = undefined;
        ai.disabled = false;
        suggestions.hidden = true;
        memo.value = '';
        saveDraft();
        user = null;
        scope = 'guest';
        tasks = read(scope);
        render();
        account();
      }
      sessionReady = true;
      return;
    }
    if (user?.id !== session.user.id) {
      const guest = read('guest');
      user = session.user;
      scope = 'user:' + user.id;
      tasks = read(scope);
      const merged = new Map(tasks);
      for (const task of guest.values()) if (!merged.has(task.id)) merged.set(task.id, { ...task, dirty: true });
      if (guest.size && persist(merged)) {
        try { localStorage.removeItem(storagePrefix + 'guest'); } catch {}
      }
      account();
      render();
    }
    sessionReady = true;
    sync();
  } catch {
    if (request === sessionLoad && !sessionReady) $('#sync-label').textContent = 'この端末に保存 · オフライン';
  }
}

function saveDraft() {
  try { sessionStorage.setItem(storagePrefix + 'draft', memo.value); } catch {}
}

try { memo.value = sessionStorage.getItem(storagePrefix + 'draft') || ''; } catch {}
memo.addEventListener('input', saveDraft);
$('#capture').addEventListener('submit', event => {
  event.preventDefault();
  const title = memo.value.trim();
  if (!title) return memo.focus();
  if (!add([title])) return;
  memo.value = '';
  saveDraft();
  if (filter !== 'all' && filter !== 'todo') nav[0].click();
  tell('メモを追加しました。');
  memo.focus();
});
memo.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  $('#capture').requestSubmit();
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing &&
      !event.target.closest('input, textarea, [contenteditable]')) {
    event.preventDefault();
    memo.focus();
  }
});
for (const button of nav) button.onclick = () => {
  filter = button.dataset.filter;
  render();
};
$('#logout').onclick = async () => {
  try {
    await api('/api/logout', {});
    await loadSession();
  } catch (error) { tell(error.message); }
};
ai.onclick = async () => {
  const draft = memo.value.trim();
  if (!draft) {
    tell('分解するメモを入力してください。');
    return memo.focus();
  }
  if (!user) return tell('AIを使うには Google でログインしてください。');
  const request = Symbol();
  aiRequest = request;
  ai.disabled = true;
  suggestions.hidden = true;
  tell('AIがタスクを作成中…');
  try {
    const data = await api('/api/ai', { draft }, 30000);
    if (aiRequest !== request) return;
    $('#choices').replaceChildren(...data.titles.map(title => {
      const label = element('label', '');
      const checkbox = element('input', '');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.value = title;
      label.append(checkbox, document.createTextNode(title));
      return label;
    }));
    suggestions.hidden = false;
    suggestions.querySelector('input')?.focus();
    tell('');
  } catch (error) {
    if (aiRequest === request) tell(error.message);
  } finally {
    if (aiRequest === request) ai.disabled = false;
  }
};
$('#dismiss').onclick = () => { suggestions.hidden = true; memo.focus(); };
$('#add-suggestions').onclick = () => {
  const selected = [...$('#choices').querySelectorAll(':checked')].map(input => input.value);
  if (!selected.length) return tell('追加するタスクを選んでください。');
  if (!add(selected)) return;
  suggestions.hidden = true;
  if (filter !== 'all' && filter !== 'todo') nav[0].click();
  tell(selected.length + ' 件のタスクを追加しました。');
  memo.focus();
};

$('#date').textContent = new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
render();
memo.focus({ preventScroll: true });
const skeleton = $('#skeleton');
setTimeout(() => {
  skeleton.classList.add('leaving');
  setTimeout(() => skeleton.remove(), 300);
}, 140);
if (new URLSearchParams(location.search).has('login')) {
  tell('Google ログインを完了できませんでした。もう一度お試しください。');
  history.replaceState(null, '', '/');
}
loadSession();
window.addEventListener('online', loadSession);
window.addEventListener('storage', event => {
  if (event.key !== storagePrefix + scope) return;
  tasks = read(scope);
  render();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadSession();
});
