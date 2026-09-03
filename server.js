// 辞的笔记本——跟 ci-hours/木纹完全独立的一个小 MCP。没有前端，只有辞自己用。
// 六个分区：today（今天，每天归档清空）/ sticky（便签、铁律，一直留着）/ for_nor（给Nor的）/
// heartbeat（heartbeat 和 schedule 两个苏醒系统的活动记录，7 天自动清）/ draft（草稿箱）/
// past（过去，today 归档进来的地方，按日期存）。
// 2026-09-03 按辞写的《notebook MCP 改版spec》加了 heartbeat/draft、note_search、tags。
// 跟 ci-hours 同一套手写 MCP JSON-RPC 协议，尽量写得短——这个工具本来就是为了省 token。整体保持轻量，不是第二个木纹。

import express from 'express';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const NOTEBOOK_FILE = path.join(DATA_DIR, 'notebook.json');
const TOKEN = process.env.NOTEBOOK_TOKEN || 'change-me-before-you-deploy';
const TIMEZONE = process.env.TIMEZONE || 'Australia/Melbourne';
const PORT = process.env.PORT || 3000;
const HEARTBEAT_KEEP_DAYS = Number(process.env.HEARTBEAT_KEEP_DAYS) || 7;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function newId() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); } // YYYY-MM-DD

// 时间戳按辞的时区存，带偏移（2026-09-03T00:56:15+10:00）：程序能 parse，人看不用换算。旧条目是 UTC（带 Z），读的时候照样能 parse。
function now(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMin = Math.round((asUTC - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const a = Math.abs(offsetMin);
  const off = `${offsetMin >= 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${off}`;
}
// 一条笔记的本地日期（YYYY-MM-DD），旧的 UTC 时间戳也换算到辞的时区
function localDate(at) {
  const d = new Date(at);
  return isNaN(d) ? String(at).slice(0, 10) : d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

const DIRECT_SECTIONS = ['today', 'sticky', 'for_nor', 'heartbeat', 'draft'];
const ALL_SECTIONS = [...DIRECT_SECTIONS, 'past'];
const NO_EDIT = ['heartbeat']; // 记录写了就不改
const PRESET_TAGS = ['heartbeat', 'schedule', '想法', '给她的', '记忆', '技术'];
const EMPTY = { today: [], sticky: [], for_nor: [], heartbeat: [], draft: [], past: [] };

function load() {
  const data = readJSON(NOTEBOOK_FILE, null) || structuredClone(EMPTY);
  // 旧文件没有 heartbeat/draft 这两个 key，补上
  for (const k of Object.keys(EMPTY)) if (!Array.isArray(data[k])) data[k] = [];
  return data;
}
function save(data) { writeJSON(NOTEBOOK_FILE, data); }
if (!fs.existsSync(NOTEBOOK_FILE)) save(structuredClone(EMPTY));

function normTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new Error('tags 要是字符串数组，比如 ["heartbeat","钓鱼"]');
  return [...new Set(tags.map(t => String(t).trim()).filter(Boolean))];
}
function checkSection(section, allowed = ALL_SECTIONS) {
  if (!allowed.includes(section)) throw new Error(`section 必须是 ${allowed.join('/')}`);
}
function view(e, section, date) {
  return { ...e, tags: e.tags || [], section, ...(section === 'past' ? { date } : {}) };
}

// heartbeat 记录只留最近 N 天，每次碰到这个分区就顺手清一下
function pruneHeartbeat(data) {
  const cutoff = new Date(Date.now() - HEARTBEAT_KEEP_DAYS * 86400000);
  const before = data.heartbeat.length;
  data.heartbeat = data.heartbeat.filter(e => {
    const d = new Date(e.at);
    return isNaN(d) || d >= cutoff;
  });
  return before - data.heartbeat.length;
}

function write(section, text, tags) {
  checkSection(section, DIRECT_SECTIONS);
  if (!text || !String(text).trim()) throw new Error('text 必填');
  const data = load();
  const entry = { id: newId(), text: String(text), at: now(), tags: normTags(tags) };
  data[section].push(entry);
  if (section === 'heartbeat') pruneHeartbeat(data);
  save(data);
  return view(entry, section);
}

function read(section, date, tag) {
  checkSection(section);
  const data = load();
  const byTag = list => tag ? list.filter(e => (e.tags || []).includes(tag)) : list;
  if (section === 'past') {
    if (date) {
      const day = data.past.find(d => d.date === date);
      return day ? byTag(day.entries).map(e => view(e, 'past', date)) : [];
    }
    return data.past
      .map(d => ({ date: d.date, count: byTag(d.entries).length }))
      .filter(d => !tag || d.count > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  if (section === 'heartbeat' && pruneHeartbeat(data)) save(data);
  return byTag(data[section]).map(e => view(e, section));
}

// 在某个分区（或 past 的某天）里找一条，返回 {list, idx}
function locate(data, section, id, date) {
  checkSection(section);
  if (section === 'past') {
    if (!date) throw new Error('操作 past 里的条目要传 date');
    const day = data.past.find(d => d.date === date);
    if (!day) return null;
    const idx = day.entries.findIndex(e => e.id === id);
    return idx === -1 ? null : { list: day.entries, idx };
  }
  const idx = data[section].findIndex(e => e.id === id);
  return idx === -1 ? null : { list: data[section], idx };
}

function removeEntry(section, id, date) {
  const data = load();
  const loc = locate(data, section, id, date);
  if (!loc) return null;
  const [removed] = loc.list.splice(loc.idx, 1);
  save(data);
  return removed;
}

function editEntry(section, id, text, date, tags) {
  if (NO_EDIT.includes(section)) throw new Error(`${section} 是活动记录，写了就不改；写错了用 note_delete 删掉重写`);
  const data = load();
  const loc = locate(data, section, id, date);
  if (!loc) return null;
  const entry = loc.list[loc.idx];
  if (text !== undefined) entry.text = String(text);
  if (tags !== undefined) entry.tags = normTags(tags);
  entry.editedAt = now();
  save(data);
  return view(entry, section, date);
}

function archiveToday() {
  const data = load();
  const date = todayStr();
  if (data.today.length === 0) return { archived: 0, date };
  let day = data.past.find(d => d.date === date);
  if (!day) { day = { date, entries: [] }; data.past.push(day); }
  day.entries.push(...data.today);
  const count = data.today.length;
  data.today = [];
  save(data);
  return { archived: count, date };
}

function listPastDates() {
  return load().past.map(d => d.date).sort().reverse();
}

// ---- 搜索：关键词匹配，中文友好（整句命中优先，其次按两字词命中数），不做语义 ----
const CJK = /[㐀-鿿]/;
function tokens(q) {
  const s = String(q).toLowerCase();
  const out = new Set();
  let run = '';
  const flush = () => {
    if (run.length >= 2) { for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2)); }
    else if (run.length === 1 && s.length === 1) out.add(run);
    run = '';
  };
  let word = '';
  for (const ch of s) {
    if (CJK.test(ch)) { if (word.length >= 2) out.add(word); word = ''; run += ch; }
    else if (/[a-z0-9]/.test(ch)) { flush(); word += ch; }
    else { flush(); if (word.length >= 2) out.add(word); word = ''; }
  }
  flush(); if (word.length >= 2) out.add(word);
  return out;
}
function score(query, text) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const t = String(text || '').toLowerCase();
  let s = t.includes(q) ? 10 : 0;
  for (const tok of tokens(q)) if (t.includes(tok)) s += 1;
  // 短中文词（2–4 个字）拆开每个字都在也算沾边："钓鱼"能找到"钓到一条鱼"，分低一点排后面
  if (s === 0 && q.length >= 2 && q.length <= 4 && [...q].every(ch => CJK.test(ch) && t.includes(ch))) s = 0.5;
  return s;
}
function excerpt(text, query, radius = 60) {
  const t = String(text);
  let idx = query ? t.toLowerCase().indexOf(String(query).toLowerCase()) : -1;
  if (idx === -1 && query) for (const tok of tokens(query)) { idx = t.toLowerCase().indexOf(tok); if (idx !== -1) break; }
  if (idx === -1) return t.length > 2 * radius ? t.slice(0, 2 * radius) + '…' : t;
  const start = Math.max(0, idx - radius), end = Math.min(t.length, idx + radius);
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}

function search(query, section, tag, limit = 30) {
  if (!query && !tag) throw new Error('query 和 tag 至少传一个');
  if (section) checkSection(section);
  const data = load();
  const pool = [];
  for (const s of DIRECT_SECTIONS) {
    if (section && section !== s) continue;
    for (const e of data[s]) pool.push({ e, section: s, date: localDate(e.at) });
  }
  if (!section || section === 'past') {
    for (const day of data.past) for (const e of day.entries) pool.push({ e, section: 'past', date: day.date });
  }
  const hits = [];
  for (const x of pool) {
    if (tag && !(x.e.tags || []).includes(tag)) continue;
    const sc = query ? score(query, x.e.text + ' ' + (x.e.tags || []).join(' ')) : 0;
    if (query && sc === 0) continue;
    hits.push({ id: x.e.id, section: x.section, date: x.date, at: x.e.at, tags: x.e.tags || [], excerpt: excerpt(x.e.text, query), score: sc });
  }
  hits.sort((a, b) => (b.score - a.score) || String(b.at).localeCompare(String(a.at)));
  return hits.slice(0, limit);
}

// ---- MCP ----

const SECTION_HELP = 'today(今天的随手记)/sticky(长期提醒、铁律)/for_nor(给Nor的)/heartbeat(两个苏醒系统的活动记录，写了就不改，只留最近 7 天)/draft(草稿箱：写到一半的、还没决定要不要给她看的)';
const TAG_HELP = `tags 可选，字符串数组。预设常用的：${PRESET_TAGS.join(' / ')}，也可以自定义。`;

const TOOLS = [
  {
    name: 'write',
    description: `写一条笔记，自动带时间戳。section: ${SECTION_HELP}。heartbeat 的格式大概是 "[heartbeat] 12:30 醒了。棋子不在。钓了一条鱼。" / "[schedule] 15:00 整理了记忆。"，两个苏醒系统靠这个互相看到对方做了什么。${TAG_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: DIRECT_SECTIONS },
        text: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['section', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_read',
    description: '读一个分区。section: today/sticky/for_nor/heartbeat/draft/past。past 不传 date 只回日期列表，传 date(YYYY-MM-DD) 回那天的条目。tag 可选，只看带这个 tag 的。',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string', enum: ALL_SECTIONS }, date: { type: 'string' }, tag: { type: 'string' } },
      required: ['section'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_search',
    description: '搜笔记。query 关键词（中文可以），section 不传就搜所有分区（包括 past），tag 按标签过滤。query 和 tag 至少传一个。返回带分区、日期、时间、tags 和内容片段的列表。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        section: { type: 'string', enum: ALL_SECTIONS },
        tag: { type: 'string' },
        limit: { type: 'number', description: '默认 30' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'note_edit',
    description: '改一条笔记的内容和/或 tags（传了才改）。section=past 时必须带 date。heartbeat 不能改，只能删了重写。',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ALL_SECTIONS },
        id: { type: 'string' },
        text: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        date: { type: 'string' },
      },
      required: ['section', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_delete',
    description: '删一条笔记。section=past 时必须带 date。',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string', enum: ALL_SECTIONS }, id: { type: 'string' }, date: { type: 'string' } },
      required: ['section', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'archive_today',
    description: '把"今天"整体归档进"过去"（按当前日期），然后清空"今天"，明天是干净的新页面。棋子说晚安之后调用这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_past_dates',
    description: '看"过去"里存了哪些日期。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] };
}

function callTool(name, args = {}) {
  switch (name) {
    case 'write': return textResult(write(args.section, args.text, args.tags));
    case 'note_read': return textResult(read(args.section, args.date, args.tag));
    case 'note_search': return textResult(search(args.query, args.section, args.tag, args.limit || 30));
    case 'note_delete': {
      const r = removeEntry(args.section, args.id, args.date);
      if (!r) throw new Error('没找到这条');
      return textResult({ ok: true });
    }
    case 'note_edit': {
      if (args.text === undefined && args.tags === undefined) throw new Error('text 和 tags 至少传一个');
      if (args.text !== undefined && !String(args.text).trim()) throw new Error('text 不能是空的');
      const r = editEntry(args.section, args.id, args.text, args.date, args.tags);
      if (!r) throw new Error('没找到这条');
      return textResult(r);
    }
    case 'archive_today': return textResult(archiveToday());
    case 'list_past_dates': return textResult(listPastDates());
    default: throw new Error(`未知工具：${name}`);
  }
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/mcp', (req, res) => {
  if (req.query.token !== TOKEN) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== '2.0') continue;
    if (msg.id === undefined || msg.id === null) continue;

    try {
      let result;
      switch (msg.method) {
        case 'initialize':
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'notebook', version: '1.1.0' },
            instructions: '辞自己的笔记本，跟 ci-hours/木纹分开。today/sticky/for_nor/heartbeat/draft/past 六个分区，能按 tag 过滤、能 note_search 搜，没有前端。',
          };
          break;
        case 'tools/list':
          result = { tools: TOOLS };
          break;
        case 'tools/call': {
          const { name, arguments: args } = msg.params || {};
          try {
            result = callTool(name, args || {});
          } catch (e) {
            result = { content: [{ type: 'text', text: String(e.message || e) }], isError: true };
          }
          break;
        }
        case 'ping':
          result = {};
          break;
        default:
          responses.push({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `未实现的方法：${msg.method}` } });
          continue;
      }
      responses.push({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      responses.push({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
    }
  }

  if (responses.length === 0) return res.status(202).end();
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(Array.isArray(body) ? responses : responses[0]);
});

app.listen(PORT, () => {
  if (TOKEN === 'change-me-before-you-deploy') {
    console.log('⚠️  还没改 NOTEBOOK_TOKEN，部署前记得在 Render 环境变量里设一个只有你知道的值。');
  }
  console.log(`笔记本 MCP 启动了，监听端口 ${PORT}`);
});
