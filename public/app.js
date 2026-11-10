const $ = (selector) => document.querySelector(selector);
const memo = $('#memo');
const board = $('#board');
const statuses = { todo: '未着手', doing: '進行中', done: '完了' };
const stages = Object.keys(statuses);
const storagePrefix = 'taskdesk:v1:';
const nav = [...document.querySelectorAll('[data-filter]')];
const suggestions = $('#suggestions');
const ai = $('#ai');
const historyDialog = $('#history');
const historyText = $('#history-text');
const historyNotice = $('#history-notice');
const historyDate = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
let filter = 'all';
let user = null;
let scope = 'guest';
let tasks = read(scope);
let syncing = false;
let pullAgain = false;
let aiRequest;
let sessionReady = false;
let sessionLoad = 0;
let historyTaskId;

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
      const action = status === 'done' ? 'の履歴を開く' : 'を' + statuses[next] + 'に変更';
      cycle.setAttribute('aria-label', task.title + action);
      cycle.title = status === 'done' ? 'クリックで履歴を開く' : 'クリックで' + statuses[next] + 'に変更';
      cycle.onclick = () => {
        if (status === 'done') return openHistory(task.id);
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
  if (historyDialog.open) renderHistory();
  if (focused) (board.querySelector('[data-task="' + CSS.escape(focused) + '"]') ??
    nav.find(button => button.dataset.filter === filter)).focus({ preventScroll: true });
}

function renderHistory() {
  const task = tasks.get(historyTaskId);
  if (!task || task.deleted || task.status !== 'done') return historyDialog.close();
  $('#history-task').textContent = task.title;
  const entries = [...(task.history ?? [])].sort((a, b) => b.created - a.created);
  $('#history-entries').replaceChildren(...(entries.length ? entries.map(entry => {
    const item = element('li', '');
    const time = element('time', '', historyDate.format(entry.created));
    time.dateTime = new Date(entry.created).toISOString();
    item.append(element('strong', '', entry.kind === 'result' ? '結果' : 'コメント'), time, element('p', '', entry.text));
    return item;
  }) : [element('li', 'empty', '記録はまだありません')]));
}

function openHistory(id) {
  historyTaskId = id;
  $('#history-form').reset();
  historyNotice.textContent = '';
  renderHistory();
  historyDialog.showModal();
}

$('#close-history').onclick = () => historyDialog.close();
historyDialog.addEventListener('close', () => {
  (board.querySelector('[data-task="' + CSS.escape(historyTaskId) + '"]') ??
    nav.find(button => button.dataset.filter === filter)).focus({ preventScroll: true });
});
$('#history-form').onsubmit = event => {
  event.preventDefault();
  const text = historyText.value.trim();
  if (!text) {
    historyNotice.textContent = '内容を入力してください。';
    return historyText.focus();
  }
  const next = read(scope);
  const task = next.get(historyTaskId);
  if (task?.status !== 'done' || task.deleted) return historyDialog.close();
  const entry = { id: crypto.randomUUID(), kind: $('#history-kind').value, text, created: Date.now(), pending: Boolean(user) };
  next.set(task.id, { ...task, history: [...(task.history ?? []), entry] });
  if (!persist(next)) {
    historyNotice.textContent = '端末に保存できませんでした。';
    return;
  }
  historyText.value = '';
  historyNotice.textContent = '履歴に追加しました。';
  renderHistory();
  historyText.focus();
  if (user) sync();
};
$('#reopen-task').onclick = () => {
  const task = read(scope).get(historyTaskId);
  if (task?.status !== 'done' || task.deleted) return historyDialog.close();
  if (change([{ ...task, status: 'todo' }], task.id)) tell('未着手に戻しました。');
  else historyNotice.textContent = '端末に保存できませんでした。';
};

function change(changes, focusId) {
  const next = read(scope);
  for (const task of changes) {
    if (!user && task.deleted) next.delete(task.id);
    else {
      const saved = next.get(task.id);
      next.set(task.id, { ...task, history: saved?.history ?? task.history,
        updated: Math.max(Date.now(), (saved?.updated ?? task.updated ?? 0) + 1), dirty: Boolean(user) });
    }
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
      const pending = [...read(scope).values()].filter(task => task.dirty || task.history?.some(entry => entry.pending))
        .slice(0, 10).map(({ history, ...task }) => ({
          ...task, historyAdditions: (history ?? []).filter(entry => entry.pending).slice(0, 1)
        }));
      const { tasks: remote } = pending.length ? await api('/api/tasks', pending) : await api('/api/tasks');
      if (activeScope !== scope) break;
      const next = new Map(remote.filter(task => !task.deleted).map(task => [task.id, task]));
      for (const task of read(scope).values()) {
        const sent = pending.find(item => item.id === task.id);
        const server = next.get(task.id);
        const dirty = task.dirty && task.updated !== sent?.updated;
        const current = dirty ? task : server;
        if (!current) continue;
        const history = new Map((server?.history ?? []).map(entry => [entry.id, entry]));
        for (const entry of task.history ?? []) {
          if (entry.pending && !history.has(entry.id) && !sent?.historyAdditions.some(item => item.id === entry.id)) history.set(entry.id, entry);
        }
        next.set(task.id, { ...current, history: [...history.values()] });
      }
      if (!persist(next)) throw new Error('保存に失敗しました。');
      render();
      pullAgain ||= [...tasks.values()].some(task => task.dirty || task.history?.some(entry => entry.pending));
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
      for (const task of guest.values()) {
        if (!merged.has(task.id)) merged.set(task.id, { ...task, dirty: true,
          history: (task.history ?? []).map(entry => ({ ...entry, pending: true })) });
      }
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
