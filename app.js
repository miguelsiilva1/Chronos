'use strict';

const CLIENT_ID = (window.GOOGLE_CLIENT_ID || '').trim();
const AUTH_URL = (window.CHRONOS_AUTH_URL || '').trim().replace(/\/$/, '');
const IS_DEMO = !CLIENT_ID;

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GIS_URL = 'https://accounts.google.com/gsi/client';
const SCOPE_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const SCOPE_CALENDARS = 'https://www.googleapis.com/auth/calendar.calendarlist';
const SCOPE_MANAGE = 'https://www.googleapis.com/auth/calendar.calendars';
const SCOPES = [SCOPE_EVENTS, SCOPE_CALENDARS, SCOPE_MANAGE, 'openid', 'email'].join(' ');
const GOOGLE_LINK_HOSTS = ['www.google.com', 'calendar.google.com'];

const TOKEN_MARGIN = 60 * 1000;
const SYNC_INTERVAL = 5 * 60 * 1000;
const FOCUS_THROTTLE = 10 * 1000;
const SNAP_MINUTES = 15;
const DAY_MINUTES = 24 * 60;
const MIN_EVENT_MINUTES = 20;
const SHORT_EVENT_MINUTES = 40;
const MONTH_LINE = 20;

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DAYS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
const DAYS_SHORT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const DAYS_MINI = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D'];
const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const RRULE_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const MAX_OCCURRENCES = 2000;
const PANEL_DAYS = 90;
const AGENDA_DAYS = 30;
const LOADED_DAYS = 70;
const DRAG_THRESHOLD = 5;
const SEARCH_DELAY = 300;
const SEARCH_MIN_CHARS = 2;
const SEARCH_RESULTS_PER_CALENDAR = 50;
const CALENDAR_COLORS = ['#d50000', '#e67c73', '#f4511e', '#f6bf26', '#33b679', '#0b8043', '#039be5', '#3f51b5', '#7986cb', '#8e24aa', '#616161', '#795548'];

const $ = id => document.getElementById(id);

/* Dates */

const pad = n => String(n).padStart(2, '0');
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
const weekdayIndex = d => (d.getDay() + 6) % 7;
const startOfWeek = d => addDays(startOfDay(d), -weekdayIndex(d));
const isWeekend = d => weekdayIndex(d) >= 5;
const minutesOf = d => d.getHours() * 60 + d.getMinutes();
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDateValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtLong = d => `${DAYS[weekdayIndex(d)]}, ${d.getDate()} de ${MONTHS[d.getMonth()].toLowerCase()}`;

// Calendar days between two dates, safe across DST changes.
const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 864e5);

function parseDateValue(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function atMinutes(day, minutes) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

function addMonths(d, n) {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
}

// Accepts "9", "930", "9:30" and "09:30".
function parseTime(value) {
  const match = value.trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/* Recurrence */

const isRRule = line => line.startsWith('RRULE:');
const compactDate = d => fmtDateValue(d).replaceAll('-', '');
const compactUtc = d => `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

function parseUntil(value) {
  const [, y, m, d, time] = value.match(/^(\d{4})(\d{2})(\d{2})(T\d{6}Z)?$/) || [];
  if (!y) return null;
  if (!time) return new Date(y, m - 1, d, 23, 59, 59);
  return new Date(`${y}-${m}-${d}T${time.slice(1, 3)}:${time.slice(3, 5)}:${time.slice(5, 7)}Z`);
}

// Returns null for rules the editor cannot show, such as "second Tuesday of the month".
function parseRule(line) {
  const fields = Object.fromEntries(line.replace(/^RRULE:/, '').split(';').map(part => part.split('=')));
  const { FREQ, INTERVAL, BYDAY, COUNT, UNTIL, WKST, ...others } = fields;
  const byDay = BYDAY ? BYDAY.split(',') : null;
  const until = UNTIL ? parseUntil(UNTIL) : null;
  const plainDays = !byDay || (FREQ === 'WEEKLY' && byDay.every(d => RRULE_DAYS.includes(d)));
  if (!RRULE_FREQS.includes(FREQ) || !plainDays || Object.keys(others).length || (UNTIL && !until)) return null;
  return { freq: FREQ, interval: Number(INTERVAL || 1), byDay, count: COUNT ? Number(COUNT) : null, until };
}

function formatRule(rule, allDay) {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${allDay ? compactDate(rule.until) : compactUtc(rule.until)}`);
  return `RRULE:${parts.join(';')}`;
}

// Ends a rule just before an occurrence. Used to split a series in two.
function endRuleBefore(line, ev) {
  const start = ev.originalStart || ev.start;
  const kept = line.split(';').filter(part => !/^(COUNT|UNTIL)=/.test(part)).join(';');
  return `${kept};UNTIL=${ev.allDay ? compactDate(addDays(start, -1)) : compactUtc(new Date(start.getTime() - 1000))}`;
}

// Yields each start of a rule the demo calendar uses, up to `limit`.
function* occurrences(rule, start, limit) {
  const time = minutesOf(start);
  const days = rule.byDay ? rule.byDay.map(d => RRULE_DAYS.indexOf(d)).sort((a, b) => a - b) : [weekdayIndex(start)];
  let produced = 0;

  const candidates = function* () {
    for (let n = 0; n < MAX_OCCURRENCES; n++) {
      const step = n * rule.interval;
      if (rule.freq === 'DAILY') yield addDays(start, step);
      else if (rule.freq === 'WEEKLY') for (const d of days) yield addDays(startOfWeek(start), step * 7 + d);
      else {
        const months = rule.freq === 'MONTHLY' ? step : step * 12;
        const day = new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
        if (day.getDate() === start.getDate()) yield day;
      }
    }
  };

  for (const candidate of candidates()) {
    const occurrence = atMinutes(candidate, time);
    if (occurrence < start) continue;
    if (occurrence >= limit || (rule.until && occurrence > rule.until) || (rule.count && produced >= rule.count)) return;
    produced++;
    yield occurrence;
  }
}

// Applies an edit made on one occurrence to the whole series.
function shiftSeries(series, ev, d) {
  const shift = dayDiff(ev.originalStart || ev.start, d.start);
  const day = addDays(series.start, shift);
  const start = d.allDay ? startOfDay(day) : atMinutes(day, minutesOf(d.start));
  const end = d.allDay ? addDays(start, dayDiff(d.start, d.end)) : new Date(start.getTime() + (d.end - d.start));
  return { ...d, start, end };
}

// Moving a weekly event to another weekday moves that day in its rule too.
function retargetRecurrence(recurrence, from, to, allDay) {
  const oldDay = RRULE_DAYS[weekdayIndex(from)];
  const newDay = RRULE_DAYS[weekdayIndex(to)];
  return recurrence.map(line => {
    const rule = isRRule(line) ? parseRule(line) : null;
    if (oldDay === newDay || !rule?.byDay?.includes(oldDay)) return line;
    return formatRule({ ...rule, byDay: [...new Set(rule.byDay.map(d => (d === oldDay ? newDay : d)))] }, allDay);
  });
}

const isFirstOccurrence = (ev, series) => (ev.originalStart || ev.start).getTime() === series.start.getTime();

/* Storage */

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`chronos.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`chronos.${key}`, JSON.stringify(value));
    } catch {
      toast('Não foi possível guardar neste browser.');
    }
  },
};

/* DOM */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key.startsWith('--')) el.style.setProperty(key, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
  return el;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/* State */

const state = {
  view: store.get('view', 'week'),
  date: startOfDay(new Date()),
  miniMonth: startOfDay(new Date()),
  calendars: [],
  events: [],
  // Older versions stored access tokens here, so only known fields are kept.
  accounts: store.get('accounts', []).map(({ email, session, calendars, scopes }) => ({ email, session, calendars, scopes })),
  order: store.get('calendarOrder', []),
  visibility: store.get('visibility', {}),
  loaded: null,
  updatedAt: null,
  syncFailed: false,
};

const calendarByKey = key => state.calendars.find(c => c.key === key);
const isVisible = cal => state.visibility[cal.key] ?? cal.selected;
const titleOf = ev => ev.title || 'Sem título';
const colorOf = ev => calendarByKey(ev.calendarKey)?.color || 'var(--text-3)';
const isAccountLive = account => Boolean(account.session);
const hasAllScopes = account => (account.scopes || '').split(' ').includes(SCOPE_MANAGE);
const expiredAccounts = () => state.accounts.filter(a => !isAccountLive(a) || !hasAllScopes(a));

// Google has no calendar order, so it is kept in this browser. Unknown calendars go last.
function orderedCalendars(calendars) {
  const rank = cal => {
    const index = state.order.indexOf(cal.key);
    return index < 0 ? Infinity : index;
  };
  return [...calendars].sort((a, b) => rank(a) - rank(b));
}

const writableCalendars = () => orderedCalendars(state.calendars).filter(c => c.writable);

function visibleEvents() {
  return state.events.filter(ev => {
    const cal = calendarByKey(ev.calendarKey);
    return cal && isVisible(cal);
  });
}

// Timed events of 24h or more sit in the all-day row, as in Google Calendar.
const inAllDayRow = ev => ev.allDay || ev.end - ev.start >= 864e5;

/* Demo backend */

const DEMO_CALENDARS = [
  { key: 'faculdade', name: 'Faculdade', color: '#3b82f6' },
  { key: 'pessoal', name: 'Pessoal', color: '#34a853' },
  { key: 'treino', name: 'Treino', color: '#f59e42' },
].map(c => ({ ...c, id: c.key, account: null, writable: true, selected: true, owner: true, primary: false }));

function demoSeed() {
  const week = startOfWeek(new Date());
  const events = [];
  const add = (calendarId, title, day, startMin, endMin, extra) => events.push({
    id: `seed-${events.length}`,
    calendarId,
    title,
    allDay: false,
    start: atMinutes(addDays(week, day), startMin).toISOString(),
    end: atMinutes(addDays(week, day), endMin).toISOString(),
    location: '',
    notes: '',
    recurrence: [],
    exceptions: [],
    seed: true,
    ...extra,
  });
  const addAllDay = (calendarId, title, day, length) => add(calendarId, title, day, 0, 0, {
    allDay: true,
    end: addDays(week, day + length).toISOString(),
  });

  const weekly = { recurrence: ['RRULE:FREQ=WEEKLY'] };
  add('faculdade', 'Aula teórica', -21, 540, 660, { ...weekly, location: 'Sala B201' });
  add('faculdade', 'Aula teórica', -18, 540, 660, { ...weekly, location: 'Sala B201' });
  add('faculdade', 'Aula prática', -20, 840, 960, { ...weekly, location: 'Laboratório 3' });
  add('treino', 'Ginásio', -21, 1140, 1230, weekly);
  add('treino', 'Ginásio', -19, 1140, 1230, weekly);
  add('treino', 'Ginásio', -17, 1080, 1170, weekly);

  add('pessoal', 'Dentista', 1, 600, 645, { location: 'Clínica da Baixa' });
  add('faculdade', 'Reunião de grupo', 2, 1080, 1140, { notes: 'Rever a apresentação e dividir tarefas.' });
  add('pessoal', 'Almoço com a Marta', 3, 750, 810);
  add('faculdade', 'Orientação de projeto', 3, 780, 840, { location: 'Gabinete 2.14' });
  addAllDay('faculdade', 'Entrega do projeto', 4, 1);
  add('pessoal', 'Jantar de família', 5, 1200, 1320);
  add('pessoal', 'Consulta de rotina', 8, 930, 975);
  addAllDay('faculdade', 'Semana de exames', 14, 5);
  addAllDay('pessoal', 'Aniversário da Inês', -5, 1);

  return events;
}

function demoData() {
  const data = store.get('demo-v2', { week: null, events: [] });
  const week = fmtDateValue(startOfWeek(new Date()));
  data.calendars ||= DEMO_CALENDARS;
  if (data.week !== week) {
    data.week = week;
    data.events = data.events.filter(e => !e.seed).concat(demoSeed());
    store.set('demo-v2', data);
  }
  return data;
}

function demoFields(d) {
  return {
    calendarId: d.calendarKey,
    title: d.title,
    allDay: d.allDay,
    start: d.start.toISOString(),
    end: d.end.toISOString(),
    location: d.location,
    notes: d.notes,
    recurrence: d.recurrence || [],
    seed: false,
  };
}

function demoEvent(stored, start, end) {
  const recurring = stored.recurrence.length > 0;
  const key = recurring ? `${stored.id}@${fmtDateValue(start)}` : stored.id;
  return {
    key,
    id: key,
    storedId: stored.id,
    recurringId: recurring ? stored.id : null,
    originalStart: recurring ? start : null,
    calendarKey: stored.calendarId,
    title: stored.title,
    allDay: stored.allDay,
    start,
    end,
    location: stored.location,
    notes: stored.notes,
    recurring,
    link: null,
  };
}

function demoExpand(stored, to) {
  const start = new Date(stored.start);
  const end = new Date(stored.end);
  const [line] = stored.recurrence.filter(isRRule);
  if (!line) return [demoEvent(stored, start, end)];

  const days = dayDiff(start, end);
  const duration = end - start;
  return [...occurrences(parseRule(line), start, to)]
    .filter(s => !stored.exceptions.includes(fmtDateValue(s)))
    .map(s => demoEvent(stored, s, stored.allDay ? addDays(s, days) : new Date(s.getTime() + duration)));
}

const newDemoId = () => `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const Demo = {
  async refresh(from, to) {
    const data = demoData();
    const events = data.events
      .flatMap(e => demoExpand(e, to))
      .filter(e => e.start < to && e.end > from);
    return { calendars: data.calendars, events, failures: 0 };
  },

  async listCalendarEvents(calendar, from, to) {
    return demoData().events
      .filter(e => e.calendarId === calendar.key)
      .flatMap(e => demoExpand(e, to))
      .filter(e => e.start < to && e.end > from);
  },

  async search(query, from, to) {
    const text = query.toLowerCase();
    return demoData().events
      .filter(e => [e.title, e.location, e.notes].some(field => field.toLowerCase().includes(text)))
      .flatMap(e => demoExpand(e, to))
      .filter(e => e.end > from);
  },

  async createCalendar({ name, color }) {
    const data = demoData();
    const key = newDemoId();
    data.calendars.push({ key, id: key, name, color, account: null, writable: true, selected: true, owner: true, primary: false });
    store.set('demo-v2', data);
  },

  async updateCalendar(calendar, { name, color }) {
    const data = demoData();
    Object.assign(data.calendars.find(c => c.key === calendar.key), { name, color });
    store.set('demo-v2', data);
  },

  async deleteCalendar(calendar) {
    const data = demoData();
    data.calendars = data.calendars.filter(c => c.key !== calendar.key);
    data.events = data.events.filter(e => e.calendarId !== calendar.key);
    store.set('demo-v2', data);
  },

  async create(d) {
    const data = demoData();
    data.events.push({ id: newDemoId(), exceptions: [], ...demoFields(d) });
    store.set('demo-v2', data);
  },

  async getSeries(ev) {
    const stored = demoData().events.find(e => e.id === ev.storedId);
    return { allDay: stored.allDay, start: new Date(stored.start), end: new Date(stored.end), recurrence: stored.recurrence };
  },

  async update(ev, d, scope = 'this') {
    const data = demoData();
    const stored = data.events.find(e => e.id === ev.storedId);
    const add = fields => data.events.push({ id: newDemoId(), exceptions: [], ...demoFields(fields) });

    if (!ev.recurring) {
      Object.assign(stored, demoFields(d));
    } else if (scope === 'this') {
      stored.exceptions.push(fmtDateValue(ev.originalStart));
      add({ ...d, recurrence: [] });
    } else {
      const series = await Demo.getSeries(ev);
      if (scope === 'following' && !isFirstOccurrence(ev, series)) {
        stored.recurrence = stored.recurrence.map(l => (isRRule(l) ? endRuleBefore(l, ev) : l));
        add(d);
      } else {
        Object.assign(stored, demoFields(shiftSeries(series, ev, d)));
      }
    }
    store.set('demo-v2', data);
  },

  async remove(ev, scope = 'this') {
    const data = demoData();
    const stored = data.events.find(e => e.id === ev.storedId);
    const series = await Demo.getSeries(ev);

    if (!ev.recurring || scope === 'all' || (scope === 'following' && isFirstOccurrence(ev, series))) {
      data.events = data.events.filter(e => e !== stored);
    } else if (scope === 'following') {
      stored.recurrence = stored.recurrence.map(l => (isRRule(l) ? endRuleBefore(l, ev) : l));
    } else {
      stored.exceptions.push(fmtDateValue(ev.originalStart));
    }
    store.set('demo-v2', data);
  },
};

/* Google backend */

const accessTokens = new Map();

function saveAccounts() {
  store.set('accounts', state.accounts);
}

function accountOf(calendar) {
  return state.accounts.find(a => a.email === calendar.account);
}

function authPost(path, body) {
  return fetch(`${AUTH_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XmlHttpRequest' },
    body: JSON.stringify(body),
  });
}

function endSession(account) {
  account.session = null;
  accessTokens.delete(account.email);
  saveAccounts();
  renderSession();
  return new Error(`A sessão de ${account.email} expirou. Usa "reativar" no topo.`);
}

async function fetchAccessToken(account) {
  const res = await authPost('/auth/refresh', { session: account.session });
  if (res.status === 401) throw endSession(account);
  if (!res.ok) throw new Error('Não foi possível renovar o acesso. Tenta de novo.');
  const { access_token: token, expires_in: expiresIn, session } = await res.json();
  account.session = session;
  saveAccounts();
  return { token, expiresAt: Date.now() + expiresIn * 1000 };
}

// Access tokens live only in memory. Concurrent callers share one refresh.
async function accessToken(account) {
  const current = await accessTokens.get(account.email);
  if (current && current.expiresAt - TOKEN_MARGIN > Date.now()) return current.token;

  const refreshing = fetchAccessToken(account);
  accessTokens.set(account.email, refreshing);
  try {
    const fresh = await refreshing;
    accessTokens.set(account.email, fresh);
    return fresh.token;
  } catch (err) {
    accessTokens.delete(account.email);
    throw err;
  }
}

async function googleFetch(account, path, options = {}, isRetry = false) {
  if (!isAccountLive(account)) throw new Error(`A sessão de ${account.email} expirou. Usa "reativar" no topo.`);
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${await accessToken(account)}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) {
    if (isRetry) throw endSession(account);
    accessTokens.delete(account.email);
    return googleFetch(account, path, options, true);
  }
  if (res.status === 429) throw new Error('O Google recebeu demasiados pedidos. Espera um pouco e tenta de novo.');
  if (res.status === 403) throw new Error('O Google recusou esta operação: não tens permissão neste calendário ou evento.');
  if (!res.ok) throw new Error(`O Google devolveu o erro ${res.status}. Tenta de novo.`);
  return res.status === 204 ? null : res.json();
}

async function googleList(account, path, params) {
  const items = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ ...params, ...(pageToken ? { pageToken } : {}) });
    const page = await googleFetch(account, `${path}?${query}`);
    items.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

// Event descriptions from Google can hold HTML. Only the text is ever shown.
function htmlToText(html) {
  if (!html) return '';
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n');
  return new DOMParser().parseFromString(withBreaks, 'text/html').body.textContent.trim();
}

function fromGoogle(item, calendar) {
  const allDay = Boolean(item.start.date);
  const read = t => (allDay ? parseDateValue(t.date) : new Date(t.dateTime));
  return {
    key: `${calendar.key}|${item.id}`,
    id: item.id,
    calendarKey: calendar.key,
    title: item.summary || '',
    allDay,
    start: read(item.start),
    end: read(item.end),
    location: item.location || '',
    notes: htmlToText(item.description),
    recurring: Boolean(item.recurringEventId),
    recurringId: item.recurringEventId || null,
    originalStart: item.originalStartTime ? read(item.originalStartTime) : null,
    link: safeGoogleLink(item.htmlLink),
  };
}

function safeGoogleLink(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && GOOGLE_LINK_HOSTS.includes(hostname) ? url : null;
  } catch {
    return null;
  }
}

function toCalendar(item, email) {
  return {
    key: `${email}|${item.id}`,
    id: item.id,
    account: email,
    name: item.summaryOverride || item.summary,
    color: /^#[0-9a-f]{6}$/i.test(item.backgroundColor) ? item.backgroundColor : '#8e8e93',
    writable: item.accessRole === 'owner' || item.accessRole === 'writer',
    owner: item.accessRole === 'owner',
    selected: Boolean(item.selected),
    primary: Boolean(item.primary),
  };
}

// patching: PATCH merges start and end, so switching to or from all-day must clear the other field.
function toGoogleTime(date, allDay, patching) {
  if (allDay) return { date: fmtDateValue(date), ...(patching ? { dateTime: null } : {}) };
  return {
    dateTime: date.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(patching ? { date: null } : {}),
  };
}

const eventsPath = calendar => `/calendars/${encodeURIComponent(calendar.id)}/events`;
const eventPath = (calendar, id) => `${eventsPath(calendar)}/${encodeURIComponent(id)}`;
const listEntryPath = id => `/users/me/calendarList/${encodeURIComponent(id)}`;

function readableTextColor(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#000000' : '#ffffff';
}

function patchListEntry(account, id, fields) {
  return googleFetch(account, `${listEntryPath(id)}?colorRgbFormat=true`, { method: 'PATCH', body: JSON.stringify(fields) });
}

function eventBody(d, patching) {
  return {
    summary: d.title,
    location: d.location,
    start: toGoogleTime(d.start, d.allDay, patching),
    end: toGoogleTime(d.end, d.allDay, patching),
  };
}

const Google = {
  async refresh(from, to) {
    const events = [];
    let failures = 0;

    await Promise.all(state.accounts.map(async account => {
      const previous = () => state.events.filter(e => calendarByKey(e.calendarKey)?.account === account.email);
      if (!isAccountLive(account)) {
        events.push(...previous());
        return;
      }
      try {
        const items = await googleList(account, '/users/me/calendarList', { maxResults: 250 });
        account.calendars = items.map(item => toCalendar(item, account.email));
      } catch (err) {
        if (isAccountLive(account)) failures++;
        events.push(...previous());
        return;
      }
      await Promise.all(account.calendars.map(async calendar => {
        try {
          const items = await googleList(account, eventsPath(calendar), {
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: 2500,
          });
          events.push(...items.filter(i => i.status !== 'cancelled').map(i => fromGoogle(i, calendar)));
        } catch (err) {
          if (isAccountLive(account)) failures++;
        }
      }));
    }));

    saveAccounts();
    return { calendars: state.accounts.flatMap(a => a.calendars), events, failures };
  },

  async listCalendarEvents(calendar, from, to) {
    const items = await googleList(accountOf(calendar), eventsPath(calendar), {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: 250,
    });
    return items.filter(i => i.status !== 'cancelled').map(i => fromGoogle(i, calendar));
  },

  async search(query, from, to) {
    const params = new URLSearchParams({
      q: query,
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: SEARCH_RESULTS_PER_CALENDAR,
    });
    const calendars = state.accounts.filter(isAccountLive).flatMap(a => a.calendars);
    const results = await Promise.allSettled(calendars.map(async calendar => {
      const page = await googleFetch(accountOf(calendar), `${eventsPath(calendar)}?${params}`);
      return (page.items || []).filter(i => i.status !== 'cancelled').map(i => fromGoogle(i, calendar));
    }));
    if (calendars.length && results.every(r => r.status === 'rejected')) throw new Error('Não foi possível pesquisar.');
    return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  },

  async createCalendar({ email, name, color }) {
    const account = state.accounts.find(a => a.email === email);
    const created = await googleFetch(account, '/calendars', {
      method: 'POST',
      body: JSON.stringify({ summary: name, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    await patchListEntry(account, created.id, { backgroundColor: color, foregroundColor: readableTextColor(color), selected: true });
  },

  // Only secondary calendars you own can be renamed. Others keep a private name in your list.
  async updateCalendar(calendar, { name, color }) {
    const account = accountOf(calendar);
    const renamesOriginal = calendar.owner && !calendar.primary;
    if (renamesOriginal && name !== calendar.name) {
      await googleFetch(account, `/calendars/${encodeURIComponent(calendar.id)}`, { method: 'PATCH', body: JSON.stringify({ summary: name }) });
    }
    await patchListEntry(account, calendar.id, {
      backgroundColor: color,
      foregroundColor: readableTextColor(color),
      summaryOverride: renamesOriginal ? null : name,
    });
  },

  async deleteCalendar(calendar) {
    const path = calendar.owner ? `/calendars/${encodeURIComponent(calendar.id)}` : listEntryPath(calendar.id);
    await googleFetch(accountOf(calendar), path, { method: 'DELETE' });
  },

  async create(d) {
    const calendar = calendarByKey(d.calendarKey);
    await googleFetch(accountOf(calendar), eventsPath(calendar), {
      method: 'POST',
      body: JSON.stringify({
        ...eventBody(d, false),
        description: d.notes,
        ...(d.recurrence?.length ? { recurrence: d.recurrence } : {}),
      }),
    });
  },

  async getSeries(ev) {
    const calendar = calendarByKey(ev.calendarKey);
    const item = await googleFetch(accountOf(calendar), eventPath(calendar, ev.recurringId));
    const allDay = Boolean(item.start.date);
    const read = t => (allDay ? parseDateValue(t.date) : new Date(t.dateTime));
    return { allDay, start: read(item.start), end: read(item.end), recurrence: item.recurrence || [] };
  },

  async patchAndMove(ev, id, patch, target) {
    const source = calendarByKey(ev.calendarKey);
    const account = accountOf(source);
    const path = eventPath(source, id);
    await googleFetch(account, path, { method: 'PATCH', body: JSON.stringify(patch) });
    if (source.key !== target.key) {
      const query = new URLSearchParams({ destination: target.id });
      await googleFetch(account, `${path}/move?${query}`, { method: 'POST' });
    }
  },

  async endSeriesBefore(ev, series) {
    const calendar = calendarByKey(ev.calendarKey);
    const recurrence = series.recurrence.map(l => (isRRule(l) ? endRuleBefore(l, ev) : l));
    await googleFetch(accountOf(calendar), eventPath(calendar, ev.recurringId), {
      method: 'PATCH',
      body: JSON.stringify({ recurrence }),
    });
  },

  async update(ev, d, scope = 'this') {
    const source = calendarByKey(ev.calendarKey);
    const target = calendarByKey(d.calendarKey);
    const otherAccount = source.account !== target.account;

    if (ev.recurring && scope !== 'this') {
      const series = await Google.getSeries(ev);
      if (scope === 'following' && !isFirstOccurrence(ev, series)) {
        await Google.create(d);
        await Google.endSeriesBefore(ev, series);
        return;
      }
      const shifted = shiftSeries(series, ev, d);
      if (otherAccount) {
        await Google.create(shifted);
        await Google.remove(ev, 'all');
        return;
      }
      const patch = { ...eventBody(shifted, true), recurrence: d.recurrence };
      if (d.notes !== ev.notes) patch.description = d.notes;
      await Google.patchAndMove(ev, ev.recurringId, patch, target);
      return;
    }

    // The move endpoint works within one account and rejects recurring instances.
    if (source.key !== target.key && (otherAccount || ev.recurring)) {
      await Google.create(d);
      await Google.remove(ev);
      return;
    }

    const patch = eventBody(d, true);
    // Rewriting unchanged notes would drop the HTML formatting of the original.
    if (d.notes !== ev.notes) patch.description = d.notes;
    if (!ev.recurring && d.recurrence?.length) patch.recurrence = d.recurrence;
    await Google.patchAndMove(ev, ev.id, patch, target);
  },

  async remove(ev, scope = 'this') {
    const calendar = calendarByKey(ev.calendarKey);
    const account = accountOf(calendar);
    if (ev.recurring && scope !== 'this') {
      const series = await Google.getSeries(ev);
      if (scope === 'following' && !isFirstOccurrence(ev, series)) {
        await Google.endSeriesBefore(ev, series);
        return;
      }
      await googleFetch(account, eventPath(calendar, ev.recurringId), { method: 'DELETE' });
      return;
    }
    await googleFetch(account, eventPath(calendar, ev.id), { method: 'DELETE' });
  },
};

const backend = IS_DEMO ? Demo : Google;

/* Google sign-in */

function requestCode(loginHint) {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('O início de sessão do Google ainda não carregou. Verifica a ligação e tenta de novo.'));
      return;
    }
    const expectedState = crypto.randomUUID();
    const client = google.accounts.oauth2.initCodeClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      ux_mode: 'popup',
      state: expectedState,
      login_hint: loginHint,
      select_account: !loginHint,
      callback: response => {
        const granted = (response.scope || '').split(' ');
        if (response.error) reject(new Error(`O Google recusou o acesso (${response.error}).`));
        else if (response.state !== expectedState) reject(new Error('A resposta do Google não é válida. Tenta de novo.'));
        else if (![SCOPE_EVENTS, SCOPE_CALENDARS, SCOPE_MANAGE].every(s => granted.includes(s))) {
          reject(new Error('Falta dar acesso ao calendário. Tenta de novo e marca todas as permissões.'));
        } else resolve(response.code);
      },
      error_callback: error => {
        reject(new Error(error.type === 'popup_failed_to_open'
          ? 'O browser bloqueou a janela do Google. Permite pop-ups neste site e tenta de novo.'
          : 'A janela do Google foi fechada antes de terminar.'));
      },
    });
    client.requestCode();
  });
}

// Must run directly from a click: the popup is blocked otherwise.
async function connectAccount(loginHint) {
  try {
    const code = await requestCode(loginHint);
    const res = await authPost('/auth/exchange', { code });
    if (res.status === 409) throw new Error('O Google precisa de confirmar as permissões. Liga a conta mais uma vez.');
    if (!res.ok) throw new Error('Não foi possível ligar a conta. Tenta de novo.');
    const { email, session, scope, access_token: token, expires_in: expiresIn } = await res.json();

    let account = state.accounts.find(a => a.email === email);
    if (!account) {
      account = { email, calendars: [] };
      state.accounts.push(account);
    }
    account.session = session;
    account.scopes = scope;
    accessTokens.set(email, { token, expiresAt: Date.now() + expiresIn * 1000 });
    saveAccounts();
    await refresh();
  } catch (err) {
    toast(err.message);
  }
}

function removeAccount(account) {
  if (account.session) authPost('/auth/revoke', { session: account.session }).catch(() => {});
  accessTokens.delete(account.email);
  state.accounts = state.accounts.filter(a => a !== account);
  saveAccounts();

  for (const key of Object.keys(state.visibility)) {
    if (key.startsWith(`${account.email}|`)) delete state.visibility[key];
  }
  store.set('visibility', state.visibility);
  if (store.get('lastCalendar', '')?.startsWith(`${account.email}|`)) store.set('lastCalendar', null);

  state.calendars = state.accounts.flatMap(a => a.calendars);
  state.events = state.events.filter(e => calendarByKey(e.calendarKey));
  render();
}

function loadGoogleScript() {
  document.head.append(h('script', { src: GIS_URL, async: true, defer: true }));
}

/* Loading */

function viewDays() {
  if (state.view === 'day') return [state.date];
  const first = startOfWeek(state.date);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

function monthGridStart(date) {
  return startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1));
}

// Reaches past the month grid so the agenda always has its 30 days.
function loadRange(date) {
  const first = monthGridStart(date);
  return { from: addDays(first, -7), to: addDays(first, LOADED_DAYS) };
}

function isLoaded(date) {
  const { loaded } = state;
  if (!loaded) return false;
  const { from, to } = loadRange(date);
  return from >= loaded.from && to <= loaded.to;
}

let refreshRun = 0;
async function refresh() {
  const run = ++refreshRun;
  const range = loadRange(state.date);
  try {
    const { calendars, events, failures } = await backend.refresh(range.from, range.to);
    if (run !== refreshRun) return;
    state.calendars = calendars;
    state.events = events;
    state.loaded = range;
    state.syncFailed = failures > 0;
    if (!failures) state.updatedAt = new Date();
  } catch (err) {
    if (run !== refreshRun) return;
    state.syncFailed = true;
  }
  render();
  if (panel.calendarKey) loadCalendarPanel();
  if (panel.searching) runSearch();
}

/* Navigation */

function goTo(date, view) {
  state.date = startOfDay(date);
  state.miniMonth = state.date;
  if (view && view !== state.view) {
    state.view = view;
    store.set('view', view);
  }
  closePopover();
  render();
  if (!isLoaded(state.date)) refresh();
}

function step(direction) {
  const stepDays = { day: 1, week: 7, agenda: AGENDA_DAYS };
  if (state.view === 'month') goTo(addMonths(state.date, direction));
  else goTo(addDays(state.date, direction * stepDays[state.view]));
}

/* Rendering */

function render() {
  if (drag) {
    drag.renderPending = true;
    return;
  }
  renderTitle();
  renderStatus();
  renderSession();
  renderMini();
  renderSidebar();
  renderView();
}

function titleParts() {
  const d = state.date;
  if (state.view === 'month' || state.view === 'agenda') return [MONTHS[d.getMonth()], d.getFullYear()];
  if (state.view === 'day') return [`${d.getDate()} de ${MONTHS[d.getMonth()].toLowerCase()}`, d.getFullYear()];

  const a = startOfWeek(d);
  const b = addDays(a, 6);
  if (a.getMonth() === b.getMonth()) return [MONTHS[a.getMonth()], a.getFullYear()];
  const first = MONTHS_SHORT[a.getMonth()];
  const capitalised = first[0].toUpperCase() + first.slice(1);
  if (a.getFullYear() === b.getFullYear()) return [`${capitalised} – ${MONTHS_SHORT[b.getMonth()]}`, a.getFullYear()];
  return [`${capitalised} ${a.getFullYear()} – ${MONTHS_SHORT[b.getMonth()]}`, b.getFullYear()];
}

function renderTitle() {
  const [main, year] = titleParts();
  $('title').replaceChildren(main, h('span', {}, year));
  for (const button of $('views').children) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }
}

function renderStatus() {
  let text = '';
  if (IS_DEMO) text = 'Modo demonstração';
  else if (!state.accounts.length) text = 'Adiciona uma conta Google para ver os teus eventos';
  else if (state.syncFailed) text = 'Não foi possível atualizar';
  else if (state.updatedAt) text = `Atualizado às ${fmtTime(state.updatedAt)}`;
  $('status').textContent = text;
}

function renderSession() {
  const expired = expiredAccounts();
  const button = $('reauth');
  button.hidden = !expired.length;
  const label = expired.every(isAccountLive) ? 'Novas permissões' : 'Sessão expirada';
  button.textContent = `${label} · reativar${expired.length > 1 ? ` (${expired.length})` : ''}`;
  button.title = expired.map(a => a.email).join(', ');
}

function renderMini() {
  const month = state.miniMonth;
  $('mini-title').textContent = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;

  const today = new Date();
  const first = monthGridStart(month);
  const hasRange = state.view === 'day' || state.view === 'week';
  const rangeStart = hasRange ? viewDays()[0] : null;
  const rangeEnd = hasRange ? viewDays().at(-1) : null;

  const cells = DAYS_MINI.map(label => h('div', { class: 'mini-label' }, label));
  for (let i = 0; i < 42; i++) {
    const day = addDays(first, i);
    const classes = ['mini-day'];
    if (day.getMonth() !== month.getMonth()) classes.push('is-out');
    if (sameDay(day, today)) classes.push('is-today');
    if (rangeStart && day >= rangeStart && day <= rangeEnd) {
      classes.push('in-range');
      if (sameDay(day, rangeStart)) classes.push('range-start');
      if (sameDay(day, rangeEnd)) classes.push('range-end');
    }
    cells.push(h('button', {
      class: classes.join(' '),
      type: 'button',
      'aria-label': fmtLong(day),
      onclick: () => { goTo(day); closeDrawer(); },
    }, h('span', {}, day.getDate())));
  }
  $('mini-grid').replaceChildren(...cells);
}

function renderSidebar() {
  const groups = IS_DEMO
    ? [{ name: null, calendars: state.calendars }]
    : state.accounts.map(a => ({ name: a.email, calendars: a.calendars }));

  if (!calendarDragActive) {
    $('calendar-list').replaceChildren(...groups.map(group => h('div', { class: 'cal-group' },
      group.name && h('div', { class: 'cal-group-name' }, group.name),
      orderedCalendars(group.calendars).map(calendarRow),
    )));
  }

  $('account-section').hidden = IS_DEMO;
  $('demo-note').hidden = !IS_DEMO;
  $('account-list').replaceChildren(...state.accounts.map(account => h('li', { class: isAccountLive(account) ? '' : 'is-expired' },
    h('span', { title: account.email }, account.email),
    h('button', { class: 'link-btn', type: 'button', onclick: () => removeAccount(account) }, 'Remover'),
  )));
}

function calendarRow(cal) {
  const isOpen = panel.calendarKey === cal.key;
  return h('div', {
    class: isOpen ? 'cal-row is-open' : 'cal-row',
    'data-key': cal.key,
    '--c': cal.color,
    onpointerdown: startCalendarDrag,
    onkeydown: moveCalendarWithKeys,
  },
    h('span', { class: 'cal-grip', title: 'Arrastar para reorganizar', 'aria-hidden': 'true' }),
    h('input', {
      type: 'checkbox',
      'aria-label': `Mostrar ${cal.name}`,
      checked: isVisible(cal),
      onchange: e => {
        state.visibility[cal.key] = e.target.checked;
        store.set('visibility', state.visibility);
        closePopover();
        renderView();
      },
    }),
    h('button', { class: 'cal-name', type: 'button', title: `Ver eventos de ${cal.name}`, onclick: () => toggleCalendarPanel(cal) }, cal.name),
    h('button', { class: 'cal-more', type: 'button', 'aria-label': `Editar ${cal.name}`, title: 'Editar calendário', onclick: () => openCalendarEditor(cal) }, '⋯'),
  );
}

function saveCalendarOrder() {
  state.order = [...$('calendar-list').querySelectorAll('.cal-row')].map(row => row.dataset.key);
  store.set('calendarOrder', state.order);
}

let calendarDragActive = false;

// The click that ends a drag must not also activate what is under the pointer.
function swallowNextClick() {
  const swallow = ev => ev.stopPropagation();
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 0);
}

function startCalendarDrag(e) {
  const row = e.currentTarget;
  const onGrip = e.target.closest('.cal-grip');
  if (e.button !== 0 || e.target.closest('input, .cal-more') || (e.pointerType === 'touch' && !onGrip)) return;

  const startY = e.clientY;
  const list = row.parentElement;

  const move = ev => {
    if (!calendarDragActive) {
      if (Math.abs(ev.clientY - startY) < 5) return;
      calendarDragActive = true;
      row.classList.add('is-dragging');
    }
    const others = [...list.querySelectorAll('.cal-row')].filter(r => r !== row);
    const next = others.find(r => {
      const box = r.getBoundingClientRect();
      return ev.clientY < box.top + box.height / 2;
    });
    list.insertBefore(row, next || null);
  };

  const finish = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    if (!calendarDragActive) return;

    calendarDragActive = false;
    row.classList.remove('is-dragging');
    saveCalendarOrder();

    swallowNextClick();
  };

  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

function moveCalendarWithKeys(e) {
  if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const row = e.currentTarget;
  const focused = document.activeElement;
  if (e.key === 'ArrowUp' && row.previousElementSibling?.matches('.cal-row')) row.previousElementSibling.before(row);
  if (e.key === 'ArrowDown' && row.nextElementSibling) row.nextElementSibling.after(row);
  focused.focus();
  saveCalendarOrder();
}

function renderView() {
  if (state.view === 'month') renderMonth();
  else if (state.view === 'agenda') renderAgenda();
  else renderTimeView(viewDays());
}

/* Agenda view */

function agendaEvent(ev) {
  return h('button', { class: 'agenda-ev', type: 'button', '--c': colorOf(ev), onclick: e => openPopover(ev, e.currentTarget) },
    h('time', {}, inAllDayRow(ev) ? 'Dia todo' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`),
    h('strong', {}, titleOf(ev)),
    ev.location && h('span', {}, ev.location),
  );
}

function renderAgenda() {
  const today = new Date();
  const events = visibleEvents();
  const days = Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(state.date, i));

  const sections = days.flatMap(day => {
    const next = addDays(day, 1);
    const items = events
      .filter(ev => ev.start < next && ev.end > day)
      .sort((a, b) => inAllDayRow(b) - inAllDayRow(a) || a.start - b.start);
    if (!items.length) return [];
    return h('section', { class: sameDay(day, today) ? 'agenda-day is-today' : 'agenda-day' },
      h('button', { class: 'agenda-date', type: 'button', 'aria-label': fmtLong(day), onclick: () => goTo(day, 'day') },
        h('b', {}, day.getDate()),
        h('span', {}, DAYS_SHORT[weekdayIndex(day)]),
      ),
      h('div', { class: 'agenda-items' }, items.map(agendaEvent)),
    );
  });

  $('view').replaceChildren(h('div', { class: 'agenda' },
    sections.length ? sections : h('p', { class: 'agenda-empty' }, `Sem eventos nos próximos ${AGENDA_DAYS} dias.`),
  ));
}

/* Search */

let searchTimer;

function openSearch() {
  closePopover();
  closeDrawer();
  panel.calendarKey = null;
  panel.run++;
  panel.searching = true;
  renderSidebar();

  const input = h('input', {
    class: 'input',
    id: 'search-input',
    type: 'search',
    placeholder: 'Título, local ou notas',
    'aria-label': 'Pesquisar eventos',
    autocomplete: 'off',
    oninput: () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, SEARCH_DELAY);
    },
  });

  $('cal-panel').replaceChildren(
    h('header', { class: 'panel-head' },
      h('h2', {}, 'Pesquisar'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar', onclick: closeCalendarPanel }, '×'),
    ),
    input,
    h('p', { class: 'panel-summary', id: 'search-summary' }),
    h('div', { class: 'panel-list', id: 'search-results' }),
  );
  $('cal-panel').hidden = false;
  input.focus();
}

function renderSearchResults(events) {
  $('search-summary').textContent = `${events.length} ${events.length === 1 ? 'resultado' : 'resultados'}`;
  $('search-results').replaceChildren(...eventsByDay(events).map(({ day, events: items }) => daySection(day, items, true)));
}

async function runSearch() {
  const query = $('search-input')?.value.trim() || '';
  const run = ++panel.run;
  if (query.length < SEARCH_MIN_CHARS) {
    $('search-summary').textContent = '';
    $('search-results').replaceChildren();
    return;
  }

  const today = startOfDay(new Date());
  $('search-summary').textContent = 'A pesquisar...';
  try {
    const found = await backend.search(query, addDays(today, -365), addDays(today, 730));
    if (run !== panel.run) return;
    // Upcoming events first, then past ones from the most recent.
    const upcoming = found.filter(ev => ev.end > today).sort((a, b) => a.start - b.start);
    const past = found.filter(ev => ev.end <= today).sort((a, b) => b.start - a.start);
    renderSearchResults([...upcoming, ...past]);
  } catch (err) {
    if (run !== panel.run) return;
    $('search-summary').textContent = err.message;
    $('search-results').replaceChildren();
  }
}

/* Calendar panel */

const panel = {
  calendarKey: null,
  days: PANEL_DAYS,
  events: [],
  loading: false,
  failed: false,
  searching: false,
  run: 0,
};

function toggleCalendarPanel(cal) {
  if (panel.calendarKey === cal.key) {
    closeCalendarPanel();
    return;
  }
  closePopover();
  closeDrawer();
  Object.assign(panel, { calendarKey: cal.key, days: PANEL_DAYS, events: [], failed: false, searching: false });
  renderSidebar();
  loadCalendarPanel();
}

function closeCalendarPanel() {
  clearTimeout(searchTimer);
  panel.calendarKey = null;
  panel.searching = false;
  panel.run++;
  $('cal-panel').hidden = true;
  // Removing the search field also releases its focus, so shortcuts work straight away.
  $('cal-panel').replaceChildren();
  renderSidebar();
}

async function loadCalendarPanel() {
  const calendar = calendarByKey(panel.calendarKey);
  if (!calendar) {
    closeCalendarPanel();
    return;
  }
  const run = ++panel.run;
  const from = startOfDay(new Date());
  panel.loading = true;
  renderCalendarPanel();
  try {
    const events = await backend.listCalendarEvents(calendar, from, addDays(from, panel.days));
    if (run !== panel.run) return;
    panel.events = events.sort((a, b) => a.start - b.start);
    panel.failed = false;
  } catch (err) {
    if (run !== panel.run) return;
    panel.failed = true;
  }
  panel.loading = false;
  renderCalendarPanel();
}

// Events already under way can be listed from `earliest` instead of their start day.
function eventsByDay(events, earliest) {
  const days = new Map();
  for (const ev of events) {
    const day = earliest && ev.start < earliest ? earliest : startOfDay(ev.start);
    const key = fmtDateValue(day);
    if (!days.has(key)) days.set(key, { day, events: [] });
    days.get(key).events.push(ev);
  }
  return [...days.values()];
}

function panelEvent(ev, showColor) {
  return h('button', { class: 'panel-ev', type: 'button', '--c': colorOf(ev), onclick: e => openPopover(ev, e.currentTarget) },
    h('time', {}, inAllDayRow(ev) ? 'Dia todo' : fmtTime(ev.start)),
    h('span', {}, showColor && h('i', {}), titleOf(ev)),
  );
}

function daySection(day, events, showColor) {
  const year = day.getFullYear() === new Date().getFullYear() ? '' : ` de ${day.getFullYear()}`;
  return h('section', { class: 'panel-day' },
    h('button', { class: 'panel-date', type: 'button', onclick: () => goTo(day, 'day') }, `${fmtLong(day)}${year}`),
    events.map(ev => panelEvent(ev, showColor)),
  );
}

function renderCalendarPanel() {
  const calendar = calendarByKey(panel.calendarKey);
  const element = $('cal-panel');
  if (!calendar) return;

  const count = panel.events.length;
  const summary = `${count} ${count === 1 ? 'evento' : 'eventos'} nos próximos ${panel.days} dias`;
  let body;
  if (panel.failed) body = h('p', { class: 'panel-note' }, 'Não foi possível carregar os eventos. Tenta de novo.');
  else if (panel.loading && !count) body = h('p', { class: 'panel-note' }, 'A carregar...');
  else if (!count) body = h('p', { class: 'panel-note' }, `Sem eventos nos próximos ${panel.days} dias.`);
  else {
    body = eventsByDay(panel.events, startOfDay(new Date())).map(({ day, events }) => daySection(day, events, false));
  }

  element.replaceChildren(
    h('header', { class: 'panel-head', '--c': calendar.color },
      h('i', {}),
      h('h2', {}, calendar.name),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar', onclick: closeCalendarPanel }, '×'),
    ),
    h('p', { class: 'panel-summary' }, summary),
    h('div', { class: 'panel-list' }, body),
    !panel.failed && !panel.loading && h('button', {
      class: 'btn btn-block',
      type: 'button',
      onclick: () => {
        panel.days += PANEL_DAYS;
        loadCalendarPanel();
      },
    }, 'Mostrar mais'),
  );
  element.hidden = false;
}

/* Calendar editor */

const calendarEditor = {
  calendar: null,
  color: CALENDAR_COLORS[6],
};

function setCalendarColor(color) {
  calendarEditor.color = color;
  $('cal-color').value = color;
  for (const swatch of $('cal-swatches').children) {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color));
  }
}

function showCalendarError(message) {
  const el = $('cal-error');
  el.textContent = message;
  el.hidden = !message;
}

function openCalendarEditor(calendar) {
  if (!IS_DEMO && !state.accounts.length) {
    toast('Adiciona uma conta Google para criar calendários.');
    return;
  }
  closePopover();
  closeDrawer();
  calendarEditor.calendar = calendar || null;

  const isAlias = calendar && (!calendar.owner || calendar.primary);
  $('cal-editor-title').textContent = calendar ? 'Editar calendário' : 'Novo calendário';
  $('cal-name').value = calendar?.name || '';
  $('cal-note').hidden = !isAlias;
  $('cal-account-row').hidden = IS_DEMO || Boolean(calendar) || state.accounts.length < 2;
  $('cal-account').replaceChildren(...state.accounts.map(a => h('option', { value: a.email }, a.email)));
  $('cal-delete').hidden = !calendar || calendar.primary;
  $('cal-delete').textContent = calendar?.owner ? 'Apagar calendário' : 'Remover da lista';
  $('cal-confirm').hidden = true;
  $('cal-save-actions').hidden = false;
  setCalendarColor(calendar?.color || CALENDAR_COLORS[6]);
  showCalendarError('');

  $('cal-editor').showModal();
  $('cal-name').focus();
}

async function saveCalendar(e) {
  e.preventDefault();
  const name = $('cal-name').value.trim();
  if (!name) {
    showCalendarError('Indica um nome para o calendário.');
    return;
  }

  const button = $('cal-save');
  const { calendar, color } = calendarEditor;
  button.disabled = true;
  try {
    if (calendar) await backend.updateCalendar(calendar, { name, color });
    else await backend.createCalendar({ email: $('cal-account').value || state.accounts[0]?.email, name, color });
    $('cal-editor').close();
    await refresh();
  } catch (err) {
    showCalendarError(err.message);
  } finally {
    button.disabled = false;
  }
}

function askCalendarDelete() {
  const { calendar } = calendarEditor;
  $('cal-save-actions').hidden = true;
  $('cal-confirm').hidden = false;
  $('cal-confirm-row').hidden = !calendar.owner;
  $('cal-confirm-name').value = '';
  $('cal-confirm-text').textContent = calendar.owner
    ? `Isto apaga "${calendar.name}" e todos os seus eventos para sempre. Escreve o nome do calendário para confirmar.`
    : `Remover "${calendar.name}" da tua lista? O calendário continua a existir.`;
  $('cal-confirm-delete').textContent = calendar.owner ? 'Apagar para sempre' : 'Remover';
  updateCalendarConfirm();
  if (calendar.owner) $('cal-confirm-name').focus();
}

function updateCalendarConfirm() {
  const { calendar } = calendarEditor;
  $('cal-confirm-delete').disabled = calendar.owner && $('cal-confirm-name').value.trim() !== calendar.name;
}

async function deleteCalendar() {
  const { calendar } = calendarEditor;
  const button = $('cal-confirm-delete');
  button.disabled = true;
  try {
    await backend.deleteCalendar(calendar);
    delete state.visibility[calendar.key];
    store.set('visibility', state.visibility);
    state.order = state.order.filter(key => key !== calendar.key);
    store.set('calendarOrder', state.order);
    $('cal-editor').close();
    await refresh();
  } catch (err) {
    showCalendarError(err.message);
    updateCalendarConfirm();
  }
}

/* Week and day view */

function allDayPlacements(days) {
  const first = days[0];
  const count = days.length;
  const after = addDays(first, count);
  const lanes = [];

  return visibleEvents()
    .filter(ev => inAllDayRow(ev) && ev.start < after && ev.end > first)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map(ev => {
      const endsAtMidnight = minutesOf(ev.end) === 0;
      const from = Math.max(0, dayDiff(first, ev.start));
      const to = Math.min(count, dayDiff(first, ev.end) + (endsAtMidnight ? 0 : 1));
      let lane = lanes.findIndex(end => end <= from);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = to;
      return { ev, from, to, lane };
    });
}

function timedSegments(day) {
  const next = addDays(day, 1);
  return visibleEvents()
    .filter(ev => !inAllDayRow(ev) && ev.start < next && ev.end > day)
    .map(ev => {
      const start = ev.start < day ? 0 : minutesOf(ev.start);
      const end = ev.end >= next ? DAY_MINUTES : minutesOf(ev.end);
      return { ev, day, start, end: Math.min(DAY_MINUTES, Math.max(end, start + MIN_EVENT_MINUTES)), endsToday: ev.end <= next };
    });
}

// Overlapping events share the column width.
function layoutOverlaps(segments) {
  segments.sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [];
  let clusterEnd = 0;

  const flush = () => {
    const columns = [];
    for (const seg of cluster) {
      let col = columns.findIndex(end => end <= seg.start);
      if (col < 0) col = columns.length;
      columns[col] = seg.end;
      seg.col = col;
    }
    for (const seg of cluster) seg.cols = columns.length;
    cluster = [];
  };

  for (const seg of segments) {
    if (seg.start >= clusterEnd) flush();
    cluster.push(seg);
    clusterEnd = cluster.length === 1 ? seg.end : Math.max(clusterEnd, seg.end);
  }
  flush();
  return segments;
}

function eventBlock(seg) {
  const { ev } = seg;
  const time = `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
  const isShort = seg.end - seg.start < SHORT_EVENT_MINUTES;
  return h('button', {
    class: isShort ? 'ev ev--short' : 'ev',
    type: 'button',
    '--top': seg.start,
    '--dur': seg.end - seg.start,
    '--col': seg.col,
    '--cols': seg.cols,
    '--c': colorOf(ev),
    onclick: e => openPopover(ev, e.currentTarget),
    onpointerdown: e => startEventDrag(e, seg),
  },
    h('strong', {}, titleOf(ev)),
    h('span', {}, isShort ? fmtTime(ev.start) : time),
    !isShort && ev.location && h('span', {}, ev.location),
    seg.endsToday && canEdit(ev) && h('i', { class: 'ev-resize', title: 'Arrastar para mudar a duração' }),
  );
}

function renderTimeView(days) {
  const today = new Date();
  const previous = $('view').querySelector('.tv');
  const previousScroll = previous ? previous.scrollTop : null;
  const count = days.length;

  const headers = days.map(day => h('button', {
    class: `tv-day${sameDay(day, today) ? ' is-today' : ''}${count === 1 ? ' is-single' : ''}`,
    type: 'button',
    'aria-label': fmtLong(day),
    onclick: () => goTo(day, 'day'),
  },
    h('span', { class: 'day-long' }, DAYS[weekdayIndex(day)]),
    h('span', { class: 'day-short' }, DAYS_SHORT[weekdayIndex(day)]),
    h('b', {}, day.getDate()),
  ));

  const allDayCells = days.map(day => h('div', {
    class: 'tv-allday-cell',
    'data-date': fmtDateValue(day),
    ondblclick: () => openEditor(null, { allDay: true, start: day, end: addDays(day, 1) }),
  }));

  const allDayEvents = allDayPlacements(days).map(({ ev, from, to, lane }) => h('button', {
    class: 'tv-allday-ev',
    type: 'button',
    '--from': from + 1,
    '--to': to + 1,
    '--lane': lane + 1,
    '--c': colorOf(ev),
    title: titleOf(ev),
    onclick: e => openPopover(ev, e.currentTarget),
    onpointerdown: e => startDayDrag(e, ev, '.tv-allday-cell'),
  }, titleOf(ev)));

  const hours = Array.from({ length: 23 }, (_, i) => h('div', { class: 'tv-hour', '--h': i + 1, 'data-hour': i + 1 }, `${pad(i + 1)}:00`));

  const columns = days.map(day => h('div', {
    class: `tv-col${isWeekend(day) ? ' is-weekend' : ''}`,
    'data-date': fmtDateValue(day),
  },
    layoutOverlaps(timedSegments(day)).map(eventBlock),
    sameDay(day, today) && h('div', { class: 'tv-now-mark' }),
  ));

  const hasToday = days.some(day => sameDay(day, today));
  const gutter = h('div', { class: 'tv-gutter' }, hours, hasToday && h('div', { class: 'tv-now-time' }));
  const body = h('div', { class: 'tv-body', onpointerdown: startDrag, onclick: tapCreate },
    gutter,
    columns,
    hasToday && h('div', { class: 'tv-now-line' }),
  );

  const scroller = h('div', { class: count === 1 ? 'tv tv--day' : 'tv', '--days': count },
    h('div', { class: 'tv-sticky' },
      h('div', { class: 'tv-days' }, h('div', {}), headers),
      h('div', { class: 'tv-allday' },
        h('div', { class: 'tv-allday-label' }, 'dia todo'),
        h('div', { class: 'tv-allday-grid' }, h('div', { class: 'tv-allday-cells' }, allDayCells), allDayEvents),
      ),
    ),
    body,
  );

  $('view').replaceChildren(scroller);
  updateNow();

  if (previousScroll !== null) {
    scroller.scrollTop = previousScroll;
  } else {
    const nowY = (minutesOf(today) / DAY_MINUTES) * body.offsetHeight;
    scroller.scrollTop = Math.max(0, nowY - scroller.clientHeight / 3);
  }
}

function updateNow() {
  const body = $('view').querySelector('.tv-body');
  if (!body) return;
  const now = new Date();
  const minutes = minutesOf(now);
  body.style.setProperty('--now', minutes);

  const label = body.querySelector('.tv-now-time');
  if (label) label.textContent = fmtTime(now);
  for (const hour of body.querySelectorAll('.tv-hour')) {
    hour.classList.toggle('is-near-now', Boolean(label) && Math.abs(hour.dataset.hour * 60 - minutes) < 12);
  }
}

/* Drag to create */

let drag = null;
let dismissedAt = -1;
let tapPending = false;

function dragRange() {
  return { start: Math.min(drag.anchor, drag.current), end: Math.max(drag.anchor, drag.current) };
}

const snapMinutes = minutes => Math.min(DAY_MINUTES, Math.max(0, Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES));

function rawPointerMinutes(e, column) {
  const rect = column.getBoundingClientRect();
  return ((e.clientY - rect.top) / rect.height) * DAY_MINUTES;
}

const pointerMinutes = (e, column) => snapMinutes(rawPointerMinutes(e, column));

function openDraft(day, start, end) {
  const from = start === end ? Math.min(start, DAY_MINUTES - 60) : start;
  const to = start === end ? from + 60 : end;
  openEditor(null, { allDay: false, start: atMinutes(day, from), end: atMinutes(day, to) });
}

function startDrag(e) {
  tapPending = false;
  const column = e.target.closest('.tv-col');
  if (!column || e.target.closest('.ev') || e.button !== 0 || e.timeStamp === dismissedAt) return;

  // Touch drags scroll the grid. A tap creates an event from the click that follows.
  if (e.pointerType === 'touch') {
    tapPending = true;
    return;
  }

  const anchor = pointerMinutes(e, column);
  drag = { column, day: parseDateValue(column.dataset.date), anchor, current: anchor, ghost: null, renderPending: false };

  const body = e.currentTarget;
  e.preventDefault();
  body.setPointerCapture(e.pointerId);

  const move = ev => {
    if (!drag) return;
    drag.current = pointerMinutes(ev, drag.column);
    drawGhost();
  };
  const finish = ev => {
    body.removeEventListener('pointermove', move);
    body.removeEventListener('pointerup', finish);
    body.removeEventListener('pointercancel', finish);
    if (!drag) return;

    const { day, renderPending } = drag;
    const { start, end } = dragRange();
    const commit = ev.type === 'pointerup';
    cancelDrag();
    if (renderPending) render();
    if (commit) openDraft(day, start, end);
  };

  body.addEventListener('pointermove', move);
  body.addEventListener('pointerup', finish);
  body.addEventListener('pointercancel', finish);
}

function tapCreate(e) {
  if (!tapPending) return;
  tapPending = false;
  const column = e.target.closest('.tv-col');
  if (!column || e.target.closest('.ev')) return;
  const minutes = pointerMinutes(e, column);
  openDraft(parseDateValue(column.dataset.date), minutes, minutes);
}

function paintGhost(column, day, start, end, color) {
  if (!drag.ghost) drag.ghost = h('div', { class: 'ev ev--ghost', '--col': 0, '--cols': 1, '--c': color }, h('span', {}));
  if (drag.ghost.parentElement !== column) column.append(drag.ghost);
  drag.ghost.style.setProperty('--top', start);
  drag.ghost.style.setProperty('--dur', Math.max(end - start, SNAP_MINUTES));
  drag.ghost.firstChild.textContent = `${fmtTime(atMinutes(day, start))} – ${fmtTime(atMinutes(day, end))}`;
}

function drawGhost() {
  const { start, end } = dragRange();
  paintGhost(drag.column, drag.day, start, end, defaultCalendar()?.color || 'var(--accent)');
}

function cancelDrag() {
  drag?.ghost?.remove();
  drag = null;
}

/* Drag events */

const canEdit = ev => Boolean(calendarByKey(ev.calendarKey)?.writable);
const elementAt = (e, selector) => document.elementsFromPoint(e.clientX, e.clientY).find(el => el.matches(selector));

function trackDrag(e, { start, move, end }) {
  const { clientX: x, clientY: y } = e;
  let active = false;

  const onMove = ev => {
    if (!active) {
      if (Math.hypot(ev.clientX - x, ev.clientY - y) < DRAG_THRESHOLD) return;
      active = true;
      start();
    }
    if (drag) move(ev);
  };

  const onEnd = ev => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onEnd);
    document.removeEventListener('pointercancel', onEnd);
    if (!active) return;
    swallowNextClick();
    end(ev.type === 'pointerup' && Boolean(drag));
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onEnd);
  document.addEventListener('pointercancel', onEnd);
}

function finishDrag() {
  const pending = drag?.renderPending;
  cancelDrag();
  if (pending) render();
}

function startEventDrag(e, seg) {
  const { ev, day } = seg;
  if (e.button !== 0 || e.pointerType === 'touch' || !canEdit(ev)) return;

  const source = e.currentTarget;
  const column = source.closest('.tv-col');
  const resizing = Boolean(e.target.closest('.ev-resize'));
  const grab = rawPointerMinutes(e, column) - seg.start;
  const length = seg.end - seg.start;
  const target = { day, start: seg.start, end: seg.end };

  trackDrag(e, {
    start() {
      drag = { ghost: null, renderPending: false };
      source.classList.add('is-moving');
    },
    move(ev2) {
      if (resizing) {
        target.end = Math.max(seg.start + SNAP_MINUTES, pointerMinutes(ev2, column));
        paintGhost(column, day, target.start, target.end, colorOf(ev));
        return;
      }
      const over = elementAt(ev2, '.tv-col') || drag.column || column;
      drag.column = over;
      target.day = parseDateValue(over.dataset.date);
      target.start = Math.min(DAY_MINUTES - SNAP_MINUTES, snapMinutes(rawPointerMinutes(ev2, over) - grab));
      target.end = target.start + length;
      paintGhost(over, target.day, target.start, Math.min(DAY_MINUTES, target.end), colorOf(ev));
    },
    end(commit) {
      source.classList.remove('is-moving');
      finishDrag();
      if (!commit) return;
      if (resizing) {
        rescheduleEvent(ev, ev.start, atMinutes(day, target.end));
        return;
      }
      const start = atMinutes(addDays(startOfDay(ev.start), dayDiff(day, target.day)), minutesOf(ev.start) + target.start - seg.start);
      rescheduleEvent(ev, start, new Date(start.getTime() + (ev.end - ev.start)));
    },
  });
}

function startDayDrag(e, ev, selector) {
  if (e.button !== 0 || e.pointerType === 'touch' || !canEdit(ev)) return;

  const source = e.currentTarget;
  const origin = parseDateValue(elementAt(e, selector).dataset.date);
  let cell = null;

  trackDrag(e, {
    start() {
      drag = { ghost: null, renderPending: false };
      source.classList.add('is-moving');
    },
    move(ev2) {
      const over = elementAt(ev2, selector) || null;
      if (over === cell) return;
      cell?.classList.remove('is-drop');
      over?.classList.add('is-drop');
      cell = over;
    },
    end(commit) {
      cell?.classList.remove('is-drop');
      source.classList.remove('is-moving');
      finishDrag();
      if (!commit || !cell) return;
      const days = dayDiff(origin, parseDateValue(cell.dataset.date));
      rescheduleEvent(ev, addDays(ev.start, days), addDays(ev.end, days));
    },
  });
}

function askScope() {
  const dialog = $('scope-dialog');
  return new Promise(resolve => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue || null), { once: true });
    dialog.showModal();
  });
}

async function rescheduleEvent(ev, start, end) {
  if (start.getTime() === ev.start.getTime() && end.getTime() === ev.end.getTime()) return;

  const scope = ev.recurring ? await askScope() : 'this';
  if (!scope) return;

  try {
    const series = scope === 'this' ? null : await backend.getSeries(ev);
    const original = { ...ev };
    Object.assign(ev, { start, end });
    render();
    await backend.update(original, {
      title: ev.title,
      allDay: ev.allDay,
      start,
      end,
      calendarKey: ev.calendarKey,
      location: ev.location,
      notes: ev.notes,
      recurrence: series ? retargetRecurrence(series.recurrence, original.start, start, ev.allDay) : [],
    }, scope);
  } catch (err) {
    toast(err.message);
  }
  await refresh();
}

/* Month view */

function renderMonth() {
  const today = new Date();
  const first = monthGridStart(state.date);
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));

  const lists = days.map(() => h('div', { class: 'm-events' }));
  const cells = days.map((day, i) => {
    const classes = ['m-day'];
    if (day.getMonth() !== state.date.getMonth()) classes.push('is-out');
    if (sameDay(day, today)) classes.push('is-today');
    if (isWeekend(day)) classes.push('is-weekend');
    return h('div', {
      class: classes.join(' '),
      'data-date': fmtDateValue(day),
      ondblclick: e => {
        if (e.target.closest('button')) return;
        openEditor(null, { allDay: true, start: day, end: addDays(day, 1) });
      },
    },
      h('button', {
        class: 'm-num',
        type: 'button',
        'aria-label': fmtLong(day),
        onclick: () => goTo(day, 'day'),
      }, day.getDate()),
      lists[i],
    );
  });

  $('view').replaceChildren(h('div', { class: 'month' },
    h('div', { class: 'm-head' }, DAYS.map((name, i) => h('div', {},
      h('span', { class: 'day-long' }, name),
      h('span', { class: 'day-short' }, DAYS_SHORT[i]),
    ))),
    h('div', { class: 'm-grid' }, cells),
  ));

  // Capacity depends on the rendered cell height, so events are added last.
  const capacity = Math.max(1, Math.floor(lists[0].clientHeight / MONTH_LINE));
  const events = visibleEvents();
  days.forEach((day, i) => {
    const next = addDays(day, 1);
    const items = events
      .filter(ev => ev.start < next && ev.end > day)
      .sort((a, b) => inAllDayRow(b) - inAllDayRow(a) || a.start - b.start);
    const shown = items.length > capacity ? items.slice(0, capacity - 1) : items;

    lists[i].append(...shown.map(monthEvent));
    if (shown.length < items.length) {
      lists[i].append(h('button', {
        class: 'm-more',
        type: 'button',
        onclick: () => goTo(day, 'day'),
      }, `+${items.length - shown.length} mais`));
    }
  });
}

function monthEvent(ev) {
  const allDay = inAllDayRow(ev);
  return h('button', {
    class: allDay ? 'm-ev m-ev--all' : 'm-ev',
    type: 'button',
    '--c': colorOf(ev),
    title: titleOf(ev),
    onclick: e => openPopover(ev, e.currentTarget),
    onpointerdown: e => startDayDrag(e, ev, '.m-day'),
  },
    !allDay && h('i', {}),
    h('span', {}, titleOf(ev)),
    !allDay && h('time', {}, fmtTime(ev.start)),
  );
}

/* Event popover */

let popoverAnchor = null;

function whenText(ev) {
  if (ev.allDay) {
    const last = addDays(ev.end, -1);
    return sameDay(ev.start, last) ? `${fmtLong(ev.start)}, dia todo` : `${fmtLong(ev.start)} – ${fmtLong(last)}`;
  }
  if (sameDay(ev.start, ev.end)) return `${fmtLong(ev.start)}, ${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
  return `${fmtLong(ev.start)}, ${fmtTime(ev.start)} – ${fmtLong(ev.end)}, ${fmtTime(ev.end)}`;
}

// The copy is a single event, even when the original repeats.
function duplicateEvent(ev) {
  const { title, allDay, start, end, location, notes } = ev;
  openEditor(null, { title, allDay, start, end, location, notes, calendarKey: canEdit(ev) ? ev.calendarKey : null });
}

function popoverActions(ev, calendar) {
  const editable = calendar?.writable;
  return h('div', { class: 'pop-actions' },
    editable && h('button', { class: 'btn', type: 'button', onclick: () => { closePopover(); openEditor(ev); } }, 'Editar'),
    h('button', { class: 'btn', type: 'button', onclick: () => duplicateEvent(ev) }, 'Duplicar'),
    editable && h('button', { class: 'btn btn-danger', type: 'button', onclick: e => e.currentTarget.parentElement.replaceWith(confirmDelete(ev, calendar)) }, 'Apagar'),
    ev.link && h('a', { class: 'btn', href: ev.link, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir no Google'),
  );
}

function confirmDelete(ev, calendar) {
  const remove = async scope => {
    try {
      await backend.remove(ev, scope);
      closePopover();
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  };
  const danger = (label, scope) => h('button', { class: 'btn btn-danger', type: 'button', onclick: () => remove(scope) }, label);
  return h('div', { class: 'pop-actions' },
    h('p', { class: 'pop-confirm' }, ev.recurring ? 'Este evento repete-se. O que queres apagar?' : 'Apagar este evento?'),
    ev.recurring
      ? [danger('Só este', 'this'), danger('Este e os seguintes', 'following'), danger('Todos', 'all')]
      : danger('Apagar', 'this'),
    h('button', { class: 'btn', type: 'button', onclick: e => e.currentTarget.parentElement.replaceWith(popoverActions(ev, calendar)) }, 'Cancelar'),
  );
}

function openPopover(ev, anchor) {
  const popover = $('popover');
  const calendar = calendarByKey(ev.calendarKey);
  popoverAnchor = anchor;

  popover.replaceChildren(
    h('div', { class: 'pop-head', '--c': colorOf(ev) }, h('i', {}), h('h2', {}, titleOf(ev))),
    h('p', { class: 'pop-line' }, whenText(ev)),
    ev.location && h('p', { class: 'pop-line' }, ev.location),
    calendar && h('p', { class: 'pop-line' }, calendar.name),
    ev.recurring && h('p', { class: 'pop-line' }, 'Evento repetido'),
    ev.notes && h('p', { class: 'pop-notes' }, ev.notes),
    popoverActions(ev, calendar),
  );
  popover.hidden = false;

  const margin = 12;
  const rect = anchor.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = popover;
  let left = rect.right + margin;
  if (left + width > innerWidth - margin) left = rect.left - width - margin;
  if (left < margin) left = Math.max(margin, Math.min(rect.left, innerWidth - width - margin));
  const top = Math.max(margin, Math.min(rect.top, innerHeight - height - margin));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.focus();
}

function closePopover() {
  const popover = $('popover');
  if (popover.hidden) return;
  popover.hidden = true;
  if (popoverAnchor?.isConnected) popoverAnchor.focus({ preventScroll: true });
  popoverAnchor = null;
}

/* Event editor */

const editor = {
  event: null,
  durationMs: 3600000,
  durationDays: 0,
  kept: [],
  otherLines: [],
};

function defaultCalendar() {
  const writable = writableCalendars();
  const last = store.get('lastCalendar', null);
  return writable.find(c => c.key === last) || writable.find(c => c.primary) || writable[0];
}

function fillCalendarSelect(selectedKey) {
  const select = $('ed-calendar');
  const writable = writableCalendars();
  const option = c => h('option', { value: c.key }, c.name);
  if (IS_DEMO) {
    select.replaceChildren(...writable.map(option));
  } else {
    select.replaceChildren(...state.accounts
      .filter(a => a.calendars.some(c => c.writable))
      .map(a => h('optgroup', { label: a.email }, writable.filter(c => c.account === a.email).map(option))));
  }
  select.value = selectedKey;
}

function repeatLabels(start) {
  const weekday = DAYS[weekdayIndex(start)];
  const article = weekdayIndex(start) >= 5 ? 'ao' : 'à';
  return {
    none: 'Não repete',
    daily: 'Todos os dias',
    weekdays: 'Dias úteis (segunda a sexta)',
    weekly: `Todas as semanas ${article} ${weekday}`,
    monthly: `Todos os meses no dia ${start.getDate()}`,
    yearly: `Todos os anos a ${start.getDate()} de ${MONTHS[start.getMonth()].toLowerCase()}`,
    custom: 'Personalizado',
  };
}

function fillRepeatOptions() {
  const select = $('ed-repeat');
  const value = select.value;
  const labels = repeatLabels(readStart() || new Date());
  select.replaceChildren(
    ...Object.entries(labels).map(([key, label]) => h('option', { value: key }, label)),
    editor.kept.length ? h('option', { value: 'keep' }, 'Manter a repetição atual') : null,
  );
  select.value = value || 'none';
}

function presetOf(rule, start) {
  const isPlain = rule.interval === 1;
  const day = RRULE_DAYS[weekdayIndex(start)];
  const days = (rule.byDay || [day]).join(',');
  if (isPlain && rule.freq === 'DAILY') return 'daily';
  if (isPlain && rule.freq === 'WEEKLY' && days === 'MO,TU,WE,TH,FR') return 'weekdays';
  if (isPlain && rule.freq === 'WEEKLY' && days === day) return 'weekly';
  if (isPlain && rule.freq === 'MONTHLY') return 'monthly';
  if (isPlain && rule.freq === 'YEARLY') return 'yearly';
  return 'custom';
}

function setWeekdays(days) {
  for (const button of $('ed-weekdays').children) {
    button.setAttribute('aria-pressed', String(days.includes(button.dataset.day)));
  }
}

function loadRepeat(recurrence, start) {
  const [line] = recurrence.filter(isRRule);
  const rule = line ? parseRule(line) : null;
  editor.otherLines = recurrence.filter(l => !isRRule(l));
  editor.kept = line && !rule ? recurrence : [];

  $('ed-repeat').value = '';
  fillRepeatOptions();
  $('ed-repeat').value = !line ? 'none' : rule ? presetOf(rule, start) : 'keep';
  $('ed-interval').value = rule?.interval || 1;
  $('ed-unit').value = rule?.freq || 'WEEKLY';
  setWeekdays(rule?.byDay || [RRULE_DAYS[weekdayIndex(start)]]);
  $('ed-ends').value = rule?.count ? 'count' : rule?.until ? 'until' : 'never';
  $('ed-count').value = rule?.count || 10;
  $('ed-until').value = fmtDateValue(rule?.until || addMonths(start, 3));
}

function selectedScope() {
  return document.querySelector('input[name="ed-scope"]:checked').value;
}

function updateRepeatFields() {
  const repeat = $('ed-repeat').value;
  const onlyThis = Boolean(editor.event?.recurring) && selectedScope() === 'this';
  const repeats = !onlyThis && repeat !== 'none' && repeat !== 'keep';
  const custom = repeats && repeat === 'custom';

  $('ed-repeat-row').hidden = onlyThis;
  $('ed-custom').hidden = !custom;
  $('ed-weekdays').hidden = !custom || $('ed-unit').value !== 'WEEKLY';
  $('ed-ends-row').hidden = !repeats;
  $('ed-until').hidden = $('ed-ends').value !== 'until';
  $('ed-count').hidden = $('ed-ends').value !== 'count';
}

function readRule(start) {
  const preset = {
    daily: { freq: 'DAILY' },
    weekdays: { freq: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] },
    weekly: { freq: 'WEEKLY', byDay: [RRULE_DAYS[weekdayIndex(start)]] },
    monthly: { freq: 'MONTHLY' },
    yearly: { freq: 'YEARLY' },
  }[$('ed-repeat').value];

  const interval = Number($('ed-interval').value);
  const unit = $('ed-unit').value;
  const days = [...$('ed-weekdays').children].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.day);
  const rule = preset ? { interval: 1, ...preset } : { freq: unit, interval, byDay: unit === 'WEEKLY' ? days : null };

  const ends = $('ed-ends').value;
  if (ends === 'count') rule.count = Number($('ed-count').value);
  if (ends === 'until') {
    const until = $('ed-until').value ? parseDateValue($('ed-until').value) : null;
    rule.until = until && new Date(until.getFullYear(), until.getMonth(), until.getDate(), 23, 59, 59);
  }
  return rule;
}

function ruleError(rule, start) {
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 99) return 'O intervalo tem de ser entre 1 e 99.';
  if (rule.freq === 'WEEKLY' && !rule.byDay?.length) return 'Escolhe pelo menos um dia da semana.';
  if ('count' in rule && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 999)) return 'O número de vezes tem de ser entre 1 e 999.';
  if ('until' in rule && (!rule.until || rule.until < start)) return 'A data final da repetição tem de ser depois do início.';
  return null;
}

function readRecurrence(start, allDay) {
  const repeat = $('ed-repeat').value;
  if (editor.event?.recurring && selectedScope() === 'this') return [];
  if (repeat === 'none') return [];
  if (repeat === 'keep') return editor.kept;
  const rule = readRule(start);
  const error = ruleError(rule, start);
  if (error) {
    showEditorError(error);
    return null;
  }
  return [formatRule(rule, allDay), ...editor.otherLines];
}

async function openEditor(ev, draft) {
  if (!ev && !writableCalendars().length) {
    toast('Adiciona uma conta Google com um calendário editável para criar eventos.');
    return;
  }

  let series = null;
  if (ev?.recurring) {
    try {
      series = await backend.getSeries(ev);
    } catch (err) {
      toast(err.message);
      return;
    }
  }

  closePopover();
  closeDrawer();
  editor.event = ev || null;

  const source = ev || draft;
  const allDay = source.allDay;
  const lastDay = allDay ? addDays(source.end, -1) : source.end;

  $('editor-title').textContent = ev ? 'Editar evento' : 'Novo evento';
  $('ed-title').value = source.title || '';
  $('ed-allday').checked = allDay;
  $('ed-start-date').value = fmtDateValue(source.start);
  $('ed-end-date').value = fmtDateValue(lastDay);
  $('ed-start-time').value = allDay ? '09:00' : fmtTime(source.start);
  $('ed-end-time').value = allDay ? '10:00' : fmtTime(source.end);
  $('ed-location').value = source.location || '';
  $('ed-notes').value = source.notes || '';
  fillCalendarSelect(source.calendarKey || defaultCalendar().key);

  $('ed-scope').hidden = !ev?.recurring;
  document.querySelector('input[name="ed-scope"][value="this"]').checked = true;
  showEditorError('');
  toggleAllDay();
  rememberDuration();
  loadRepeat(series?.recurrence || [], source.start);
  updateRepeatFields();

  $('editor').showModal();
  $('ed-title').focus();
}

function showEditorError(message) {
  const el = $('ed-error');
  el.textContent = message;
  el.hidden = !message;
}

function toggleAllDay() {
  $('editor-form').classList.toggle('is-all-day', $('ed-allday').checked);
}

function readBound(dateId, timeId) {
  const date = $(dateId).value;
  if (!date) return null;
  const day = parseDateValue(date);
  if ($('ed-allday').checked) return day;
  const minutes = parseTime($(timeId).value);
  return minutes === null ? null : atMinutes(day, minutes);
}

const readStart = () => readBound('ed-start-date', 'ed-start-time');
const readEnd = () => readBound('ed-end-date', 'ed-end-time');

function rememberDuration() {
  const start = readStart();
  const end = readEnd();
  if (!start || !end || end < start) return;
  if ($('ed-allday').checked) editor.durationDays = dayDiff(start, end);
  else editor.durationMs = end - start;
}

function followStart() {
  const start = readStart();
  if (!start) return;
  const allDay = $('ed-allday').checked;
  const end = allDay ? addDays(start, editor.durationDays) : new Date(start.getTime() + editor.durationMs);
  $('ed-end-date').value = fmtDateValue(end);
  if (!allDay) $('ed-end-time').value = fmtTime(end);
}

function normaliseTimeField(input) {
  const minutes = parseTime(input.value);
  if (minutes !== null) input.value = fmtTime(atMinutes(new Date(2000, 0, 1), minutes));
}

function readEditor() {
  const allDay = $('ed-allday').checked;
  const start = readStart();
  const end = readEnd();
  if (!start || !end) {
    showEditorError(allDay ? 'Indica as datas de início e de fim.' : 'Indica datas e horas válidas, por exemplo 09:30.');
    return null;
  }
  if (allDay ? end < start : end <= start) {
    showEditorError('O fim tem de ser depois do início.');
    return null;
  }
  const recurrence = readRecurrence(start, allDay);
  if (!recurrence) return null;
  return {
    recurrence,
    title: $('ed-title').value.trim(),
    allDay,
    start,
    end: allDay ? addDays(end, 1) : end,
    calendarKey: $('ed-calendar').value,
    location: $('ed-location').value.trim(),
    notes: $('ed-notes').value.trim(),
  };
}

async function saveEditor(e) {
  e.preventDefault();
  const data = readEditor();
  if (!data) return;

  const button = $('ed-save');
  button.disabled = true;
  try {
    if (editor.event) await backend.update(editor.event, data, editor.event.recurring ? selectedScope() : 'this');
    else await backend.create(data);
    store.set('lastCalendar', data.calendarKey);
    $('editor').close();
    await refresh();
  } catch (err) {
    showEditorError(err.message);
  } finally {
    button.disabled = false;
  }
}

/* Sidebar */

const isPhone = () => matchMedia('(max-width: 760px)').matches;

function closeDrawer() {
  document.body.classList.remove('drawer-open');
}

function toggleSidebar() {
  if (isPhone()) {
    document.body.classList.toggle('drawer-open');
    return;
  }
  const hidden = document.body.classList.toggle('sidebar-hidden');
  store.set('sidebarHidden', hidden);
  if (state.view === 'month') renderView();
}

/* Events */

function bindEvents() {
  $('prev').addEventListener('click', () => step(-1));
  $('next').addEventListener('click', () => step(1));
  $('today').addEventListener('click', () => goTo(new Date()));
  $('new-event').addEventListener('click', newEvent);
  $('toggle-sidebar').addEventListener('click', toggleSidebar);
  $('scrim').addEventListener('click', closeDrawer);
  $('add-account').addEventListener('click', () => connectAccount(''));
  $('reauth').addEventListener('click', () => {
    // One popup per click: a second one would be blocked after the first closes.
    const [account] = expiredAccounts();
    if (account) connectAccount(account.email);
  });

  for (const button of $('views').children) {
    button.addEventListener('click', () => goTo(state.date, button.dataset.view));
  }

  $('mini-prev').addEventListener('click', () => { state.miniMonth = addMonths(state.miniMonth, -1); renderMini(); });
  $('mini-next').addEventListener('click', () => { state.miniMonth = addMonths(state.miniMonth, 1); renderMini(); });

  $('open-search').addEventListener('click', openSearch);
  $('scope-dialog').addEventListener('click', e => {
    const button = e.target.closest('button');
    if (button) $('scope-dialog').close(button.value);
  });
  $('new-calendar').addEventListener('click', () => openCalendarEditor(null));
  $('cal-form').addEventListener('submit', saveCalendar);
  $('cal-cancel').addEventListener('click', () => $('cal-editor').close());
  $('cal-delete').addEventListener('click', askCalendarDelete);
  $('cal-confirm-cancel').addEventListener('click', () => {
    $('cal-confirm').hidden = true;
    $('cal-save-actions').hidden = false;
  });
  $('cal-name').addEventListener('input', () => showCalendarError(''));
  $('cal-confirm-name').addEventListener('input', updateCalendarConfirm);
  $('cal-confirm-delete').addEventListener('click', deleteCalendar);
  $('cal-color').addEventListener('input', e => setCalendarColor(e.target.value));
  $('cal-swatches').addEventListener('click', e => {
    const swatch = e.target.closest('button');
    if (swatch) setCalendarColor(swatch.dataset.color);
  });

  $('editor-form').addEventListener('submit', saveEditor);
  $('ed-cancel').addEventListener('click', () => $('editor').close());
  $('ed-allday').addEventListener('change', () => { toggleAllDay(); rememberDuration(); });
  $('ed-start-date').addEventListener('change', () => {
    followStart();
    fillRepeatOptions();
    const start = readStart();
    if (start && $('ed-repeat').value !== 'custom') setWeekdays([RRULE_DAYS[weekdayIndex(start)]]);
  });
  $('ed-end-date').addEventListener('change', rememberDuration);
  for (const id of ['ed-repeat', 'ed-unit', 'ed-ends']) $(id).addEventListener('change', updateRepeatFields);
  $('ed-scope').addEventListener('change', updateRepeatFields);
  $('ed-weekdays').addEventListener('click', e => {
    const button = e.target.closest('button');
    if (button) button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
  });
  for (const [id, onChange] of [['ed-start-time', followStart], ['ed-end-time', rememberDuration]]) {
    $(id).addEventListener('change', e => { normaliseTimeField(e.target); onChange(); });
  }

  document.addEventListener('pointerdown', e => {
    const popover = $('popover');
    if (popover.hidden || popover.contains(e.target)) return;
    dismissedAt = e.timeStamp;
    closePopover();
  }, true);

  document.addEventListener('keydown', onKeydown);

  let lastFocusRefresh = 0;
  const refreshOnFocus = () => {
    if (document.hidden || Date.now() - lastFocusRefresh < FOCUS_THROTTLE) return;
    lastFocusRefresh = Date.now();
    refresh();
  };
  addEventListener('focus', refreshOnFocus);
  document.addEventListener('visibilitychange', refreshOnFocus);
  setInterval(refresh, SYNC_INTERVAL);

  let resizeFrame;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (state.view === 'month') renderMonth();
    });
  }).observe($('view'));

  let installPrompt = null;
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    $('install').hidden = false;
  });
  addEventListener('appinstalled', () => { $('install').hidden = true; });
  $('install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('install').hidden = true;
  });
}

function newEvent() {
  const now = new Date();
  const base = sameDay(state.date, now) ? now : atMinutes(state.date, 9 * 60);
  const start = atMinutes(base, Math.ceil(minutesOf(base) / 60) * 60);
  openEditor(null, { allDay: false, start, end: new Date(start.getTime() + 3600000) });
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    if (drag) {
      const { renderPending } = drag;
      cancelDrag();
      if (renderPending) render();
    }
    if (!$('popover').hidden) closePopover();
    else if ((panel.calendarKey || panel.searching) && !document.querySelector('dialog[open]')) closeCalendarPanel();
    closeDrawer();
    return;
  }

  const typing = e.target.closest?.('input:not([type="checkbox"]), textarea, select, [contenteditable]');
  if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;

  const actions = {
    arrowleft: () => step(-1),
    arrowright: () => step(1),
    t: () => goTo(new Date()),
    d: () => goTo(state.date, 'day'),
    s: () => goTo(state.date, 'week'),
    m: () => goTo(state.date, 'month'),
    a: () => goTo(state.date, 'agenda'),
    n: newEvent,
    '/': openSearch,
  };
  const action = actions[e.key.toLowerCase()];
  if (action) {
    e.preventDefault();
    action();
  }
}

/* Clock */

let lastTick = new Date();
function tick() {
  const now = new Date();
  if (sameDay(now, lastTick)) updateNow();
  else render();
  lastTick = now;
  renderSession();
  setTimeout(tick, 60000 - (Date.now() % 60000));
}

/* Start */

function start() {
  // Pages cannot send frame-ancestors, so a framed copy refuses to run.
  if (window.top !== window.self) {
    document.body.replaceChildren();
    return;
  }
  if (store.get('sidebarHidden', false)) document.body.classList.add('sidebar-hidden');
  $('time-options').append(...Array.from({ length: 48 }, (_, i) => h('option', { value: `${pad(Math.floor(i / 2))}:${pad((i % 2) * 30)}` })));
  $('ed-weekdays').append(...RRULE_DAYS.map((day, i) => h('button', { type: 'button', 'data-day': day, 'aria-pressed': 'false', 'aria-label': DAYS[i] }, DAYS_MINI[i])));
  $('cal-swatches').append(...CALENDAR_COLORS.map(color => h('button', { type: 'button', 'data-color': color, 'aria-label': `Cor ${color}`, '--c': color })));

  bindEvents();
  if (!IS_DEMO) {
    loadGoogleScript();
    state.calendars = state.accounts.flatMap(a => a.calendars);
  }
  render();
  refresh();
  tick();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

start();
