/* Мои слова — приложение для изучения английских слов из уроков.
 * Данные хранятся на телефоне (localStorage). Слова из файла words.json
 * (из репозитория) автоматически подтягиваются при каждом запуске. */
'use strict';

const DAY = 24 * 60 * 60 * 1000;
const KNOWN_INTERVAL = 21; // дней — после этого слово считаем выученным
const KEY = 'vocab.v1';

/* ---------------- Хранилище ---------------- */

const defaultSettings = { newPerDay: 10, direction: 'mixed', autoSpeak: true, rate: 0.9 };

let db = load();

function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* пусто */ }
  d = d || {};
  d.words = d.words || {};       // id -> {en, ru, ex, lesson, added, src, deleted, edited}
  d.progress = d.progress || {}; // id -> {ease, interval, due, reps, lapses, right, wrong, last}
  d.settings = Object.assign({}, defaultSettings, d.settings || {});
  d.days = d.days || {};         // 'YYYY-MM-DD' -> {reviewed, newSeen}
  return d;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Не удалось сохранить данные'); }
}

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const idOf = en => norm(en);
const today = () => dayKey(Date.now());
function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function todayStats() { return db.days[today()] || (db.days[today()] = { reviewed: 0, newSeen: 0 }); }

function activeWords() {
  return Object.entries(db.words).filter(([, w]) => !w.deleted).map(([id, w]) => Object.assign({ id }, w));
}

/** Добавить или обновить слово. Возвращает 'added' | 'updated' | 'same' | 'skipped'. */
function upsertWord(w, src) {
  if (!w || !w.en || !w.ru) return 'skipped';
  const id = idOf(w.en);
  const ex = db.words[id];
  const clean = {
    en: String(w.en).trim(),
    ru: String(w.ru).trim(),
    ex: w.ex ? String(w.ex).trim() : '',
    lesson: w.lesson ? String(w.lesson).trim() : '',
  };
  if (!ex) {
    db.words[id] = Object.assign(clean, { added: w.added || today(), src });
    return 'added';
  }
  if (src === 'repo' && (ex.deleted || ex.edited)) return 'same'; // пользователь удалил/изменил — не трогаем
  if (src !== 'repo' && ex.deleted) { delete ex.deleted; Object.assign(ex, clean); return 'added'; }
  const changed = ex.ru !== clean.ru || (clean.ex && ex.ex !== clean.ex) || (clean.lesson && ex.lesson !== clean.lesson);
  if (!changed) return 'same';
  ex.ru = clean.ru;
  if (clean.ex) ex.ex = clean.ex;
  if (clean.lesson) ex.lesson = clean.lesson;
  if (src !== 'repo') ex.edited = true;
  return 'updated';
}

/** Подтянуть слова из words.json */
async function syncRepo(manual) {
  try {
    const res = await fetch('words.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.words || []);
    let added = 0, updated = 0;
    for (const w of list) {
      const r = upsertWord(w, 'repo');
      if (r === 'added') added++;
      if (r === 'updated') updated++;
    }
    db.lastSync = Date.now();
    save();
    if (added || updated) toast(`Из уроков: +${added} новых` + (updated ? `, обновлено ${updated}` : ''));
    else if (manual) toast('Новых слов нет');
    return added;
  } catch (e) {
    if (manual) toast('Нет связи — работаю офлайн');
    return 0;
  }
}

/* ---------------- Интервальное повторение (SM-2) ---------------- */

function prog(id) {
  return db.progress[id] || null;
}

function isDue(id, now = Date.now()) {
  const p = prog(id);
  return p && p.due <= now;
}

function statusOf(id) {
  const p = prog(id);
  if (!p) return 'new';
  return p.interval >= KNOWN_INTERVAL ? 'known' : 'learning';
}

/** rating: 0 снова, 1 трудно, 2 хорошо, 3 легко */
function grade(id, rating) {
  const now = Date.now();
  const isNew = !db.progress[id];
  const p = db.progress[id] || (db.progress[id] = { ease: 2.5, interval: 0, due: now, reps: 0, lapses: 0, right: 0, wrong: 0 });
  if (isNew) todayStats().newSeen++;
  todayStats().reviewed++;
  p.last = now;

  if (rating === 0) {
    p.lapses++; p.wrong++;
    p.reps = 0;
    p.interval = 0;
    p.ease = Math.max(1.3, p.ease - 0.2);
    p.due = now + 60 * 1000; // вернётся в этой же сессии
  } else {
    p.right++;
    let iv;
    if (rating === 1) {
      iv = p.reps === 0 ? 1 : Math.max(1, Math.round(p.interval * 1.2));
      p.ease = Math.max(1.3, p.ease - 0.15);
    } else if (rating === 2) {
      iv = p.reps === 0 ? 1 : p.reps === 1 ? 3 : Math.round(p.interval * p.ease);
    } else {
      iv = p.reps === 0 ? 4 : Math.round(Math.max(p.interval, 1) * p.ease * 1.3);
      p.ease += 0.15;
    }
    p.reps++;
    p.interval = Math.min(iv, 365);
    p.due = startOfDay(now) + p.interval * DAY + 4 * 60 * 60 * 1000; // с 4 утра нужного дня
  }
  save();
}

/** Лёгкое обновление прогресса из тестов (без полного пересчёта интервала) */
function markQuiz(id, ok) {
  const now = Date.now();
  const p = db.progress[id];
  if (!p) {
    if (ok) return; // новое слово — пусть сначала пройдёт через карточки
    db.progress[id] = { ease: 2.5, interval: 0, due: now, reps: 0, lapses: 1, right: 0, wrong: 1, last: now };
    todayStats().newSeen++;
  } else if (ok) {
    p.right++;
  } else {
    p.wrong++; p.lapses++;
    p.reps = 0; p.interval = 0; p.due = now;
    p.ease = Math.max(1.3, p.ease - 0.2);
  }
  save();
}

function dueList() {
  const now = Date.now();
  return activeWords().filter(w => isDue(w.id, now)).sort((a, b) => prog(a.id).due - prog(b.id).due);
}

function newList() {
  return activeWords().filter(w => !prog(w.id)).sort((a, b) => (a.added || '').localeCompare(b.added || '') || a.en.localeCompare(b.en));
}

function newLeftToday() {
  return Math.max(0, db.settings.newPerDay - todayStats().newSeen);
}

function streak() {
  let n = 0;
  let t = Date.now();
  if (!(db.days[dayKey(t)] && db.days[dayKey(t)].reviewed)) t -= DAY; // сегодня ещё не занимались — считаем со вчера
  while (db.days[dayKey(t)] && db.days[dayKey(t)].reviewed) { n++; t -= DAY; }
  return n;
}

/* ---------------- Озвучка ---------------- */

let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang));
  voice = vs.find(v => /en[-_]US/i.test(v.lang) && /samantha|ava|allison|siri|google/i.test(v.name))
    || vs.find(v => /en[-_]US/i.test(v.lang)) || vs.find(v => /en[-_]GB/i.test(v.lang)) || vs[0] || null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice ? voice.lang : 'en-US';
  if (voice) u.voice = voice;
  u.rate = db.settings.rate;
  speechSynthesis.speak(u);
}

/* ---------------- Утилиты UI ---------------- */

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const $back = document.getElementById('backBtn');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
const wordsN = n => `${n} ${plural(n, 'слово', 'слова', 'слов')}`;

let currentTab = 'home';
let backHandler = null;

function setScreen(title, onBack) {
  $title.textContent = title;
  backHandler = onBack || null;
  $back.hidden = !onBack;
  window.scrollTo(0, 0);
}
$back.addEventListener('click', () => backHandler && backHandler());

document.getElementById('tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (b) go(b.dataset.tab);
});

function go(tab) {
  currentTab = tab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  ({ home: renderHome, study: renderStudy, list: renderList, add: renderAdd, settings: renderSettings })[tab]();
}

function lessons() {
  const m = new Map();
  for (const w of activeWords()) {
    const l = w.lesson || 'Без урока';
    m.set(l, (m.get(l) || 0) + 1);
  }
  return [...m.entries()];
}

/* ---------------- Главная ---------------- */

function renderHome() {
  setScreen('Мои слова');
  const all = activeWords();
  const due = dueList().length;
  const newAvail = Math.min(newList().length, newLeftToday());
  const known = all.filter(w => statusOf(w.id) === 'known').length;
  const learning = all.filter(w => statusOf(w.id) === 'learning').length;
  const st = streak();
  const td = todayStats();

  if (!all.length) {
    $view.innerHTML = `
      <div class="card empty">
        <div class="big">📘</div>
        <h2>Слов пока нет</h2>
        <p>Слова с уроков появятся здесь автоматически, когда будут добавлены в список.
        Можно также добавить их вручную или вставить список из чата с уроком.</p>
        <button class="btn" id="goAdd">Добавить слова</button>
        <button class="btn secondary" id="sync">Проверить новые слова</button>
      </div>`;
    document.getElementById('goAdd').onclick = () => go('add');
    document.getElementById('sync').onclick = async () => { await syncRepo(true); renderHome(); };
    return;
  }

  const todo = due + newAvail;
  $view.innerHTML = `
    <div class="stats">
      <div class="stat hl"><b>${todo}</b><span>на сегодня</span></div>
      <div class="stat"><b>${st} 🔥</b><span>${plural(st, 'день', 'дня', 'дней')} подряд</span></div>
      <div class="stat"><b>${all.length}</b><span>всего слов</span></div>
      <div class="stat"><b>${known}</b><span>выучено</span></div>
    </div>
    <div style="height:14px"></div>
    <button class="btn" id="start" ${todo ? '' : 'disabled'}>
      ${todo ? 'Начать занятие' : 'На сегодня всё сделано ✓'}
      <span class="sub">${due} на повторение · ${newAvail} новых</span>
    </button>
    <button class="btn secondary" id="more">Другие режимы: тест, написание</button>
    <div class="card small" style="margin-top:14px">
      <div class="kv"><span>Изучается</span><b>${learning}</b></div>
      <div class="kv"><span>Ещё не начаты</span><b>${newList().length}</b></div>
      <div class="kv"><span>Повторено сегодня</span><b>${td.reviewed}</b></div>
      <div class="kv"><span>Уроков</span><b>${lessons().length}</b></div>
    </div>
    <button class="btn secondary" id="sync">🔄 Проверить новые слова с уроков</button>
  `;
  document.getElementById('start').onclick = () => startFlash({});
  document.getElementById('more').onclick = () => go('study');
  document.getElementById('sync').onclick = async () => { await syncRepo(true); renderHome(); };
}

/* ---------------- Учить: выбор режима ---------------- */

let studyScope = 'all'; // 'all' | название урока

function scopeWords() {
  const all = activeWords();
  return studyScope === 'all' ? all : all.filter(w => (w.lesson || 'Без урока') === studyScope);
}

function renderStudy() {
  setScreen('Учить');
  const ls = lessons();
  if (ls.length && studyScope !== 'all' && !ls.some(([l]) => l === studyScope)) studyScope = 'all';
  const n = scopeWords().length;
  const due = dueList().length;
  const newAvail = Math.min(newList().length, newLeftToday());
  $view.innerHTML = `
    <label>Какие слова</label>
    <select id="scope">
      <option value="all">Все слова (${activeWords().length})</option>
      ${ls.map(([l, c]) => `<option value="${esc(l)}" ${l === studyScope ? 'selected' : ''}>${esc(l)} (${c})</option>`).join('')}
    </select>
    <div class="mode-list" style="margin-top:14px">
      ${studyScope === 'all' ? `
      <button class="btn" data-m="srs" ${due + newAvail ? '' : 'disabled'}>🃏 Карточки: повторение по расписанию
        <span class="sub">${due} на повторение · ${newAvail} новых сегодня</span></button>` : ''}
      <button class="btn secondary" data-m="cards" ${n ? '' : 'disabled'}>🔁 Карточки: прогнать все выбранные слова
        <span class="sub">${wordsN(n)}, в случайном порядке</span></button>
      <button class="btn secondary" data-m="quiz" ${n >= 2 ? '' : 'disabled'}>✅ Тест: выбери перевод
        <span class="sub">4 варианта ответа</span></button>
      <button class="btn secondary" data-m="type" ${n ? '' : 'disabled'}>⌨️ Написание: напиши по-английски
        <span class="sub">проверка правописания</span></button>
      <button class="btn secondary" data-m="listen" ${n >= 2 ? '' : 'disabled'}>🎧 На слух: выбери, что услышал
        <span class="sub">тренировка восприятия</span></button>
      <button class="btn secondary" data-m="hard" ${hardWords().length ? '' : 'disabled'}>💪 Трудные слова
        <span class="sub">${wordsN(hardWords().length)} с ошибками</span></button>
    </div>
    <div class="card small">
      <b>Направление карточек:</b>
      <div class="seg" id="dir" style="margin-top:8px">
        <button data-d="en-ru">EN → RU</button>
        <button data-d="ru-en">RU → EN</button>
        <button data-d="mixed">Вперемешку</button>
      </div>
    </div>
  `;
  document.getElementById('scope').onchange = e => { studyScope = e.target.value; renderStudy(); };
  document.querySelectorAll('#dir button').forEach(b => {
    b.classList.toggle('active', b.dataset.d === db.settings.direction);
    b.onclick = () => { db.settings.direction = b.dataset.d; save(); renderStudy(); };
  });
  $view.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    const m = b.dataset.m;
    const back = () => go('study');
    if (m === 'srs') startFlash({ back });
    if (m === 'cards') startFlash({ back, cram: shuffle(scopeWords()) });
    if (m === 'hard') startFlash({ back, cram: shuffle(hardWords()), title: 'Трудные слова' });
    if (m === 'quiz') startQuiz({ back, listen: false });
    if (m === 'listen') startQuiz({ back, listen: true });
    if (m === 'type') startTyping({ back });
  });
}

function hardWords() {
  return activeWords().filter(w => {
    const p = prog(w.id);
    return p && (p.lapses >= 2 || (p.wrong > 0 && p.wrong >= p.right / 2));
  });
}

/* ---------------- Карточки ---------------- */

function cardDir() {
  const d = db.settings.direction;
  if (d === 'mixed') return Math.random() < 0.5 ? 'en-ru' : 'ru-en';
  return d;
}

function startFlash({ back, cram, title }) {
  const backFn = back || (() => go('home'));
  let queue;
  const isCram = !!cram;
  if (isCram) {
    queue = cram.slice();
  } else {
    const newOnes = newList().slice(0, newLeftToday());
    const due = dueList();
    // перемешиваем новые с повторениями, чтобы не было «стены» новых слов
    queue = due.slice();
    newOnes.forEach((w, i) => queue.splice(Math.min(queue.length, i * 3 + 2), 0, w));
  }
  const total = queue.length;
  let done = 0;
  let stats = { again: 0, ok: 0 };

  function next() {
    if (!queue.length) return finish();
    const w = queue[0];
    const dir = cardDir();
    let shown = false;
    const front = dir === 'en-ru' ? w.en : w.ru;
    const backTxt = dir === 'en-ru' ? w.ru : w.en;
    setScreen(title || (isCram ? 'Карточки' : 'Занятие'), backFn);
    const isNew = !prog(w.id);
    $view.innerHTML = `
      <div class="progress"><div style="width:${total ? (done / total * 100) : 0}%"></div></div>
      <div class="muted small" style="text-align:center;margin-bottom:8px">${done} из ${total}${isNew ? ' · <b>новое слово</b>' : ''}</div>
      <div class="card flash" id="fc">
        ${w.lesson ? `<div class="lesson-tag">${esc(w.lesson)}</div>` : ''}
        <button class="speak" id="sp" aria-label="Произнести">🔊</button>
        <div class="q">${esc(front)}</div>
        <div id="backside"></div>
        <div class="hint" id="hint">Нажмите, чтобы увидеть ответ</div>
      </div>
      <div id="controls"></div>
    `;
    const sp = document.getElementById('sp');
    // При RU→EN кнопка озвучки скрыта до показа ответа, иначе это подсказка
    if (dir === 'ru-en') sp.style.visibility = 'hidden';
    sp.onclick = e => { e.stopPropagation(); speak(w.en); };
    if (dir === 'en-ru' && db.settings.autoSpeak) speak(w.en);

    const reveal = () => {
      if (shown) return;
      shown = true;
      sp.style.visibility = 'visible';
      document.getElementById('hint').remove();
      document.getElementById('backside').innerHTML = `
        <div class="divider" style="margin:18px auto 0"></div>
        <div class="a">${esc(backTxt)}</div>
        ${w.ex ? `<div class="ex">${esc(w.ex)}</div>` : ''}`;
      if (dir === 'ru-en' && db.settings.autoSpeak) speak(w.en);
      const c = document.getElementById('controls');
      if (isCram) {
        c.innerHTML = `<div class="row-btns" style="grid-template-columns:1fr 1fr">
          <button class="btn b-again" data-r="0">Не помню</button>
          <button class="btn b-good" data-r="2">Помню</button></div>`;
      } else {
        const p = prog(w.id);
        const pv = r => previewInterval(p, r);
        c.innerHTML = `<div class="row-btns">
          <button class="btn b-again" data-r="0">Снова<small>${pv(0)}</small></button>
          <button class="btn b-hard" data-r="1">Трудно<small>${pv(1)}</small></button>
          <button class="btn b-good" data-r="2">Хорошо<small>${pv(2)}</small></button>
          <button class="btn b-easy" data-r="3">Легко<small>${pv(3)}</small></button></div>`;
      }
      c.querySelectorAll('[data-r]').forEach(b => b.onclick = () => answer(+b.dataset.r));
    };

    const answer = r => {
      queue.shift();
      if (isCram) {
        if (r === 0) {
          stats.again++;
          queue.splice(Math.min(queue.length, 3), 0, w); // ещё раз через пару карточек
          markQuiz(w.id, false);
        } else { stats.ok++; done++; markQuiz(w.id, true); }
      } else {
        grade(w.id, r);
        if (r === 0) {
          stats.again++;
          queue.splice(Math.min(queue.length, 4), 0, w);
        } else { stats.ok++; done++; }
      }
      next();
    };

    document.getElementById('fc').onclick = reveal;
  }

  function finish() {
    setScreen('Готово', backFn);
    $view.innerHTML = `
      <div class="card done">
        <div class="big">🎉</div>
        <h2>Отлично!</h2>
        <p>Пройдено: <b>${wordsN(total)}</b><br>
        ${stats.again ? `Повторов из-за ошибок: ${stats.again}` : 'Без единой ошибки!'}</p>
      </div>
      <button class="btn" id="fin">Готово</button>`;
    document.getElementById('fin').onclick = backFn;
  }

  if (!total) {
    toast('Сейчас нечего повторять');
    return backFn();
  }
  next();
}

function fmtIv(days) {
  if (days <= 0) return '<1 мин';
  if (days < 30) return days + ' дн';
  if (days < 365) return Math.round(days / 30) + ' мес';
  return Math.round(days / 365) + ' г';
}

function previewInterval(p, r) {
  const reps = p ? p.reps : 0, iv = p ? p.interval : 0, ease = p ? p.ease : 2.5;
  if (r === 0) return fmtIv(0);
  if (r === 1) return fmtIv(reps === 0 ? 1 : Math.max(1, Math.round(iv * 1.2)));
  if (r === 2) return fmtIv(reps === 0 ? 1 : reps === 1 ? 3 : Math.round(iv * ease));
  return fmtIv(reps === 0 ? 4 : Math.round(Math.max(iv, 1) * ease * 1.3));
}

/* ---------------- Тест с вариантами ---------------- */

function startQuiz({ back, listen }) {
  const pool = scopeWords();
  const all = activeWords();
  const items = shuffle(pool).slice(0, 20);
  let i = 0, right = 0;
  const mistakes = [];

  function next() {
    if (i >= items.length) return finish();
    const w = items[i];
    const dir = listen ? 'en-ru' : cardDir();
    const q = dir === 'en-ru' ? w.en : w.ru;
    const key = dir === 'en-ru' ? 'ru' : 'en';
    const distract = shuffle(all.filter(x => x.id !== w.id && norm(x[key]) !== norm(w[key]))).slice(0, 3);
    const opts = shuffle([w, ...distract]);
    setScreen(listen ? 'На слух' : 'Тест', back);
    $view.innerHTML = `
      <div class="progress"><div style="width:${i / items.length * 100}%"></div></div>
      <div class="muted small" style="text-align:center;margin-bottom:8px">${i + 1} из ${items.length} · верно ${right}</div>
      <div class="card flash" style="min-height:170px">
        <button class="speak" id="sp">🔊</button>
        <div class="q">${listen ? '🎧' : esc(q)}</div>
        ${listen ? '<div class="hint">Нажмите 🔊, чтобы послушать ещё раз</div>' : ''}
      </div>
      <div class="options">
        ${opts.map((o, k) => `<button class="opt" data-k="${k}">${esc(o[key])}</button>`).join('')}
      </div>
      <div id="fb"></div>
    `;
    const sp = document.getElementById('sp');
    if (dir === 'ru-en' && !listen) sp.style.visibility = 'hidden';
    sp.onclick = () => speak(w.en);
    if (dir === 'en-ru' && (listen || db.settings.autoSpeak)) speak(w.en);

    let answered = false;
    $view.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      if (answered) return;
      answered = true;
      const o = opts[+b.dataset.k];
      const ok = o.id === w.id;
      $view.querySelectorAll('.opt').forEach(x => {
        if (opts[+x.dataset.k].id === w.id) x.classList.add('correct');
      });
      if (!ok) b.classList.add('wrong');
      if (ok) right++; else mistakes.push(w);
      markQuiz(w.id, ok);
      sp.style.visibility = 'visible';
      document.getElementById('fb').innerHTML = `
        <div class="feedback ${ok ? 'ok' : 'no'}"><b>${esc(w.en)}</b> — ${esc(w.ru)}${w.ex ? `<br><i class="small">${esc(w.ex)}</i>` : ''}</div>
        <button class="btn" id="nx">Дальше</button>`;
      if (dir === 'ru-en' || listen) speak(w.en);
      document.getElementById('nx').onclick = () => { i++; next(); };
    });
  }

  function finish() { showResult(right, items.length, mistakes, back); }
  next();
}

function showResult(right, total, mistakes, back) {
  setScreen('Результат', back);
  const pct = total ? Math.round(right / total * 100) : 0;
  $view.innerHTML = `
    <div class="card done">
      <div class="big">${pct >= 90 ? '🏆' : pct >= 60 ? '👍' : '💪'}</div>
      <h2>${right} из ${total} (${pct}%)</h2>
    </div>
    ${mistakes.length ? `<div class="group-title">Ошибки — они попадут в повторение</div>
      <ul class="word-list">${mistakes.map(w => `<li class="word-item"><div class="w"><div class="en">${esc(w.en)}</div><div class="ru">${esc(w.ru)}</div></div></li>`).join('')}</ul>
      <button class="btn secondary" id="redo">Повторить ошибки карточками</button>` : ''}
    <button class="btn" id="fin">Готово</button>`;
  document.getElementById('fin').onclick = back;
  const r = document.getElementById('redo');
  if (r) r.onclick = () => startFlash({ back, cram: shuffle(mistakes), title: 'Ошибки' });
}

/* ---------------- Написание ---------------- */

function simplify(s) {
  return norm(s).replace(/[’‘`]/g, "'").replace(/[.,!?;:"«»()]/g, '').replace(/\s+/g, ' ').trim();
}

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function checkTyped(input, target) {
  const a = simplify(input);
  // допускаем варианты через «/», а также ответ без "to " у глаголов
  const variants = String(target).split('/').map(simplify).flatMap(v => [v, v.replace(/^to /, ''), v.replace(/^(a|an|the) /, '')]);
  if (variants.includes(a) || variants.includes(a.replace(/^to /, ''))) return 'ok';
  const best = Math.min(...variants.map(v => lev(a, v)));
  const len = simplify(target).length;
  if (a && best <= (len > 7 ? 2 : len > 3 ? 1 : 0)) return 'almost';
  return 'no';
}

function startTyping({ back }) {
  const items = shuffle(scopeWords()).slice(0, 20);
  let i = 0, right = 0;
  const mistakes = [];

  function next() {
    if (i >= items.length) return showResult(right, items.length, mistakes, back);
    const w = items[i];
    setScreen('Написание', back);
    $view.innerHTML = `
      <div class="progress"><div style="width:${i / items.length * 100}%"></div></div>
      <div class="muted small" style="text-align:center;margin-bottom:8px">${i + 1} из ${items.length} · верно ${right}</div>
      <div class="card flash" style="min-height:150px">
        <div class="q">${esc(w.ru)}</div>
        ${w.ex ? `<div class="ex">${esc(maskExample(w.ex, w.en))}</div>` : ''}
      </div>
      <form id="f" autocomplete="off">
        <input type="text" class="big-input" id="inp" placeholder="по-английски…" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="btn" type="submit">Проверить</button>
      </form>
      <button class="btn secondary" id="skip">Не знаю — показать</button>
      <div id="fb"></div>
    `;
    const inp = document.getElementById('inp');
    setTimeout(() => inp.focus(), 50);
    let answered = false;
    const reveal = res => {
      if (answered) return;
      answered = true;
      inp.disabled = true;
      const ok = res !== 'no';
      if (ok) right++; else mistakes.push(w);
      markQuiz(w.id, ok);
      speak(w.en);
      const msg = res === 'ok' ? 'Верно!' : res === 'almost' ? 'Почти! Небольшая опечатка:' : 'Правильно:';
      document.getElementById('f').remove();
      document.getElementById('skip').remove();
      document.getElementById('fb').innerHTML = `
        <div class="feedback ${res}">${msg} <b>${esc(w.en)}</b>${w.ex ? `<br><i class="small">${esc(w.ex)}</i>` : ''}</div>
        <button class="btn" id="nx">Дальше</button>`;
      const nx = document.getElementById('nx');
      nx.focus();
      nx.onclick = () => { i++; next(); };
    };
    document.getElementById('f').onsubmit = e => {
      e.preventDefault();
      if (!inp.value.trim()) return;
      reveal(checkTyped(inp.value, w.en));
    };
    document.getElementById('skip').onclick = () => reveal('no');
  }
  next();
}

function maskExample(ex, en) {
  // прячем все значимые слова выражения вместе с окончаниями (look → looking)
  const tokens = String(en).toLowerCase().split(/[^a-z']+/)
    .filter(t => t.length >= 3 && !['the', 'and', 'for', 'smb', 'sth', 'one', "one's"].includes(t));
  let out = ex;
  for (const t of tokens) {
    const stem = t.length > 4 ? t.replace(/e$/, '') : t;
    out = out.replace(new RegExp('\\b' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "[a-z']*", 'ig'), '…');
  }
  return out;
}

/* ---------------- Список слов ---------------- */

let listQuery = '';
let listFilter = 'all';

function renderList() {
  setScreen('Слова');
  const all = activeWords();
  if (!all.length) {
    $view.innerHTML = `<div class="card empty"><div class="big">📭</div><p>Список пуст</p>
      <button class="btn" id="goAdd">Добавить слова</button></div>`;
    document.getElementById('goAdd').onclick = () => go('add');
    return;
  }
  $view.innerHTML = `
    <input type="search" id="q" placeholder="Поиск по-английски или по-русски" value="${esc(listQuery)}">
    <div class="seg" id="flt" style="margin-top:10px">
      <button data-f="all">Все</button>
      <button data-f="new">Новые</button>
      <button data-f="learning">Учу</button>
      <button data-f="known">Выучено</button>
    </div>
    <div id="lst"></div>`;
  const q = document.getElementById('q');
  q.oninput = () => { listQuery = q.value; drawList(); };
  document.querySelectorAll('#flt button').forEach(b => {
    b.classList.toggle('active', b.dataset.f === listFilter);
    b.onclick = () => { listFilter = b.dataset.f; renderList(); };
  });
  drawList();
}

function drawList() {
  const q = norm(listQuery);
  const words = activeWords()
    .filter(w => listFilter === 'all' || statusOf(w.id) === listFilter)
    .filter(w => !q || norm(w.en).includes(q) || norm(w.ru).includes(q));
  const groups = new Map();
  // новые уроки — сверху
  words.sort((a, b) => (b.added || '').localeCompare(a.added || '') || a.en.localeCompare(b.en));
  for (const w of words) {
    const l = w.lesson || 'Без урока';
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(w);
  }
  const label = { new: 'новое', learning: 'учу', known: 'выучено' };
  const el = document.getElementById('lst');
  if (!words.length) { el.innerHTML = '<div class="empty">Ничего не найдено</div>'; return; }
  el.innerHTML = [...groups.entries()].map(([l, ws]) => `
    <div class="group-title">${esc(l)} · ${ws.length}</div>
    <ul class="word-list">
      ${ws.map(w => {
        const s = statusOf(w.id);
        return `<li class="word-item">
          <button class="speak" data-say="${esc(w.en)}">🔊</button>
          <div class="w" data-edit="${esc(w.id)}"><div class="en">${esc(w.en)}</div><div class="ru">${esc(w.ru)}</div></div>
          <span class="badge ${s}">${label[s]}</span>
        </li>`;
      }).join('')}
    </ul>`).join('');
  el.querySelectorAll('[data-say]').forEach(b => b.onclick = () => speak(b.dataset.say));
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => renderEdit(b.dataset.edit));
}

function renderEdit(id) {
  const w = db.words[id];
  if (!w) return renderList();
  const p = prog(id);
  const backFn = () => go('list');
  setScreen('Слово', backFn);
  $view.innerHTML = `
    <div class="card">
      <form id="ef">
        <label>По-английски</label><input type="text" id="en" value="${esc(w.en)}" autocapitalize="off">
        <label>Перевод</label><input type="text" id="ru" value="${esc(w.ru)}">
        <label>Пример (необязательно)</label><input type="text" id="ex" value="${esc(w.ex || '')}" autocapitalize="off">
        <label>Урок / тема</label><input type="text" id="ls" value="${esc(w.lesson || '')}">
        <button class="btn" type="submit">Сохранить</button>
      </form>
    </div>
    <div class="card small">
      <div class="kv"><span>Статус</span><b>${({ new: 'новое', learning: 'изучается', known: 'выучено' })[statusOf(id)]}</b></div>
      ${p ? `
      <div class="kv"><span>Следующее повторение</span><b>${p.due <= Date.now() ? 'сейчас' : new Date(p.due).toLocaleDateString('ru-RU')}</b></div>
      <div class="kv"><span>Интервал</span><b>${fmtIv(p.interval)}</b></div>
      <div class="kv"><span>Верно / ошибок</span><b>${p.right} / ${p.wrong}</b></div>` : ''}
      <div class="kv"><span>Добавлено</span><b>${esc(w.added || '—')}</b></div>
    </div>
    <button class="btn secondary" id="reset">Учить заново (сбросить прогресс)</button>
    <button class="btn danger" id="del">Удалить слово</button>
  `;
  document.getElementById('ef').onsubmit = e => {
    e.preventDefault();
    const en = document.getElementById('en').value.trim();
    const ru = document.getElementById('ru').value.trim();
    if (!en || !ru) return toast('Заполните слово и перевод');
    const nid = idOf(en);
    const data = { en, ru, ex: document.getElementById('ex').value.trim(), lesson: document.getElementById('ls').value.trim() };
    if (nid !== id) {
      if (db.words[nid] && !db.words[nid].deleted) return toast('Такое слово уже есть');
      db.words[nid] = Object.assign({}, w, data, { edited: true });
      if (db.progress[id]) db.progress[nid] = db.progress[id];
      delete db.progress[id];
      w.deleted = true; // чтобы старое написание не вернулось из words.json
    } else {
      Object.assign(w, data, { edited: true });
    }
    save(); toast('Сохранено'); backFn();
  };
  document.getElementById('reset').onclick = () => {
    if (!confirm('Сбросить прогресс по этому слову?')) return;
    delete db.progress[id]; save(); toast('Прогресс сброшен'); renderEdit(id);
  };
  document.getElementById('del').onclick = () => {
    if (!confirm(`Удалить «${w.en}»?`)) return;
    w.deleted = true; delete db.progress[id]; save(); toast('Удалено'); backFn();
  };
}

/* ---------------- Добавление ---------------- */

/** Разбор текста: каждая строка «english — перевод — пример». Поддерживает и JSON. */
function parseBulk(text, defaultLesson) {
  text = String(text || '').trim();
  if (!text) return [];
  // JSON-формат (массив слов или {words:[...]})
  const jm = text.match(/[[{][\s\S]*[\]}]/);
  if (jm) {
    try {
      const d = JSON.parse(jm[0]);
      const arr = Array.isArray(d) ? d : (d.words || []);
      if (arr.length && arr[0].en) return arr.map(w => Object.assign({ lesson: defaultLesson }, w));
    } catch (e) { /* не JSON — разбираем построчно */ }
  }
  const out = [];
  let lesson = defaultLesson;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || /^```/.test(line)) continue;
    // строка вида «# Урок 5: Past Simple» или «Урок: ...» задаёт урок для следующих слов
    if (/^#+\s*\S/.test(line)) { lesson = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim(); continue; }
    if (/^урок\b/i.test(line) && !/[|\t=]|\s[—–-]\s/.test(line)) { lesson = line.replace(/\*\*/g, '').trim(); continue; }
    line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''); // маркеры списка
    line = line.replace(/\*\*/g, '');
    let parts;
    if (line.includes('|')) parts = line.split('|');
    else if (line.includes('\t')) parts = line.split('\t');
    else if (/\s[—–]\s/.test(line)) parts = line.split(/\s[—–]\s/);
    else if (/\s-\s/.test(line)) parts = line.split(/\s-\s/);
    else if (line.includes(' = ')) parts = line.split(' = ');
    else if (line.includes('=')) parts = line.split('=');
    else continue;
    parts = parts.map(p => p.trim()).filter((p, idx) => p || idx < 2);
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    out.push({ en: parts[0], ru: parts[1], ex: parts.slice(2).join(' — '), lesson });
  }
  return out;
}

function renderAdd() {
  setScreen('Добавить');
  const defLesson = 'Урок ' + new Date().toLocaleDateString('ru-RU');
  $view.innerHTML = `
    <div class="seg" id="am">
      <button data-a="bulk" class="active">Список из урока</button>
      <button data-a="one">Одно слово</button>
    </div>
    <div id="apane"></div>`;
  const pane = document.getElementById('apane');
  const one = () => {
    pane.innerHTML = `
      <div class="card">
        <form id="af" autocomplete="off">
          <label>Слово или выражение по-английски</label>
          <div class="flex"><input class="grow" type="text" id="en" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="to look forward to">
          <button type="button" class="speak" id="sp">🔊</button></div>
          <label>Перевод</label><input type="text" id="ru" placeholder="с нетерпением ждать">
          <label>Пример (необязательно)</label><input type="text" id="ex" autocapitalize="off" placeholder="I'm looking forward to the weekend.">
          <label>Урок / тема</label><input type="text" id="ls" value="${esc(db.lastLesson || defLesson)}">
          <button class="btn" type="submit">Добавить</button>
        </form>
      </div>`;
    document.getElementById('sp').onclick = () => speak(document.getElementById('en').value);
    document.getElementById('af').onsubmit = e => {
      e.preventDefault();
      const w = { en: val('en'), ru: val('ru'), ex: val('ex'), lesson: val('ls') };
      if (!w.en || !w.ru) return toast('Заполните слово и перевод');
      const r = upsertWord(w, 'user');
      db.lastLesson = w.lesson;
      save();
      toast(r === 'added' ? `Добавлено: ${w.en}` : r === 'updated' ? 'Слово уже было — обновлено' : 'Такое слово уже есть');
      ['en', 'ru', 'ex'].forEach(k => { document.getElementById(k).value = ''; });
      document.getElementById('en').focus();
    };
  };
  const bulk = () => {
    pane.innerHTML = `
      <div class="card">
        <p class="small muted" style="margin-top:0">Вставьте список слов из чата с уроком. Каждое слово — с новой строки:</p>
        <pre>word — перевод — пример
to give up — сдаваться — Don't give up!</pre>
        <label>Урок / тема (если в тексте не указан)</label>
        <input type="text" id="ls" value="${esc(defLesson)}">
        <label>Слова</label>
        <textarea id="txt" placeholder="Вставьте сюда…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
        <button class="btn secondary" id="paste" type="button">📋 Вставить из буфера обмена</button>
        <div id="prev" class="small muted"></div>
        <button class="btn" id="imp" type="button" disabled>Добавить</button>
      </div>`;
    const txt = document.getElementById('txt');
    const ls = document.getElementById('ls');
    const preview = () => {
      const items = parseBulk(txt.value, ls.value.trim());
      const imp = document.getElementById('imp');
      imp.disabled = !items.length;
      imp.textContent = items.length ? `Добавить ${wordsN(items.length)}` : 'Добавить';
      document.getElementById('prev').innerHTML = items.length
        ? `<div class="group-title">Распознано</div>` + items.slice(0, 50).map(w => `<div class="kv"><span><b>${esc(w.en)}</b></span><span>${esc(w.ru)}</span></div>`).join('') + (items.length > 50 ? '<div>…</div>' : '')
        : (txt.value.trim() ? '<p>Не удалось распознать строки. Используйте формат «слово — перевод».</p>' : '');
    };
    txt.oninput = preview; ls.oninput = preview;
    document.getElementById('paste').onclick = async () => {
      try { txt.value = await navigator.clipboard.readText(); preview(); }
      catch (e) { toast('Нажмите в поле и выберите «Вставить»'); txt.focus(); }
    };
    document.getElementById('imp').onclick = () => {
      const items = parseBulk(txt.value, ls.value.trim());
      let a = 0, u = 0;
      for (const w of items) { const r = upsertWord(w, 'user'); if (r === 'added') a++; if (r === 'updated') u++; }
      save();
      toast(`Добавлено ${a}` + (u ? `, обновлено ${u}` : '') + (items.length - a - u ? `, уже были: ${items.length - a - u}` : ''));
      txt.value = ''; preview();
    };
  };
  document.querySelectorAll('#am button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#am button').forEach(x => x.classList.toggle('active', x === b));
    b.dataset.a === 'one' ? one() : bulk();
  });
  bulk();
}

function val(id) { return document.getElementById(id).value.trim(); }

/* ---------------- Настройки ---------------- */

function renderSettings() {
  setScreen('Ещё');
  const s = db.settings;
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  $view.innerHTML = `
    ${standalone ? '' : `
    <div class="card">
      <h2>📲 Иконка на экране «Домой»</h2>
      <p class="small">В Safari нажмите <b>«Поделиться»</b> (квадрат со стрелкой) → <b>«На экран „Домой“»</b> → <b>«Добавить»</b>.
      После этого приложение запускается отдельной иконкой, как обычное, и работает без интернета.</p>
    </div>`}
    <div class="card">
      <h2>Занятия</h2>
      <label>Новых слов в день</label>
      <input type="number" id="npd" min="0" max="100" value="${s.newPerDay}">
      <div class="switch-row"><span>Автоматически произносить слова</span><input type="checkbox" id="as" ${s.autoSpeak ? 'checked' : ''}></div>
      <label>Скорость речи</label>
      <select id="rate">
        ${[[0.7, 'Медленно'], [0.9, 'Обычно'], [1.05, 'Быстро']].map(([v, t]) => `<option value="${v}" ${s.rate == v ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <button class="btn secondary" id="test">🔊 Проверить голос</button>
    </div>
    <div class="card">
      <h2>Резервная копия</h2>
      <p class="small muted">Все слова и прогресс хранятся на этом телефоне. Время от времени сохраняйте копию (например, в «Файлы» или себе в заметки).</p>
      <button class="btn secondary" id="exp">💾 Сохранить копию</button>
      <button class="btn secondary" id="imp">📂 Восстановить из копии</button>
      <input type="file" id="file" accept=".json,application/json" hidden>
      <button class="btn secondary" id="csv">📤 Экспорт слов (текстом)</button>
    </div>
    <div class="card small">
      <div class="kv"><span>Последняя синхронизация</span><b>${db.lastSync ? new Date(db.lastSync).toLocaleString('ru-RU') : '—'}</b></div>
      <button class="btn secondary" id="sync">🔄 Проверить новые слова с уроков</button>
    </div>
    <button class="btn danger" id="wipe">Сбросить весь прогресс</button>
  `;
  document.getElementById('npd').onchange = e => { s.newPerDay = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)); save(); };
  document.getElementById('as').onchange = e => { s.autoSpeak = e.target.checked; save(); };
  document.getElementById('rate').onchange = e => { s.rate = parseFloat(e.target.value); save(); };
  document.getElementById('test').onclick = () => speak("Hello! Let's learn some new words.");
  document.getElementById('exp').onclick = () => shareFile(`my-words-${today()}.json`, JSON.stringify(db, null, 1), 'application/json');
  document.getElementById('csv').onclick = () => {
    const lines = activeWords().map(w => [w.en, w.ru, w.ex].filter(Boolean).join(' — '));
    shareFile(`words-${today()}.txt`, lines.join('\n'), 'text/plain');
  };
  const file = document.getElementById('file');
  document.getElementById('imp').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d.words || !d.progress) throw new Error('bad');
      if (!confirm('Заменить текущие данные данными из копии?')) return;
      localStorage.setItem(KEY, JSON.stringify(d));
      db = load();
      toast('Восстановлено');
      go('home');
    } catch (e) { toast('Файл не похож на резервную копию'); }
  };
  document.getElementById('sync').onclick = async () => { await syncRepo(true); renderSettings(); };
  document.getElementById('wipe').onclick = () => {
    if (!confirm('Сбросить прогресс по ВСЕМ словам? Слова останутся.')) return;
    db.progress = {}; db.days = {}; save(); toast('Прогресс сброшен'); go('home');
  };
}

async function shareFile(name, content, type) {
  const blob = new Blob([content], { type });
  try {
    const f = new File([blob], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      await navigator.share({ files: [f], title: name });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------------- Запуск ---------------- */

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

go('home');
syncRepo(false).then(n => { if (n && currentTab === 'home') renderHome(); });

// при возврате в приложение — обновить главную (новый день, новые слова)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncRepo(false).then(() => { if (currentTab === 'home') renderHome(); });
  }
});
