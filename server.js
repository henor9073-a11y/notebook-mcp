// 辞的笔记本——跟 ci-hours 完全独立的一个小 MCP。没有前端，只有辞自己用。
// 四个分区：today（今天，每天清空重来）/ sticky（便签，一直留着）/ for_nor（给Nor的）/
// past（过去，today 归档进来的地方，按日期存）。
// 跟 ci-hours 同一套手写 MCP JSON-RPC 协议，尽量写得短——这个工具本来就是为了省 token。

import express from 'express';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';
const NOTEBOOK_FILE = path.join(DATA_DIR, 'notebook.json');
const TOKEN = process.env.NOTEBOOK_TOKEN || 'change-me-before-you-deploy';
const TIMEZONE = process.env.TIMEZONE || 'Australia/Melbourne';
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function newId() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function now() { return new Date().toISOString(); }
function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); } // YYYY-MM-DD

const EMPTY = { today: [], sticky: [], for_nor: [], past: [] };
function ensureFile() {
  if (!fs.existsSync(NOTEBOOK_FILE)) writeJSON(NOTEBOOK_FILE, EMPTY);
}
ensureFile();

const DIRECT_SECTIONS = ['today', 'sticky', 'for_nor'];

function write(section, text) {
  if (!DIRECT_SECTIONS.includes(section)) throw new Error(`section 必须是 ${DIRECT_SECTIONS.join('/')}`);
  if (!text) throw new Error('text 必填');
  const data = readJSON(NOTEBOOK_FILE, EMPTY);
  const entry = { id: newId(), text, at: now() };
  data[section].push(entry);
  writeJSON(NOTEBOOK_FILE, data);
  return entry;
}

function read(section, date) {
  const data = readJSON(NOTEBOOK_FILE, EMPTY);
  if (section === 'past') {
    if (date) {
      const day = data.past.find(d => d.date === date);
      return day ? day.entries : [];
    }
    return data.past.map(d => ({ date: d.date, count: d.entries.length }));
  }
  if (!DIRECT_SECTIONS.includes(section)) throw new Error(`section 必须是 ${DIRECT_SECTIONS.join('/')}/past`);
  return data[section];
}

function removeEntry(section, id, date) {
  const data = readJSON(NOTEBOOK_FILE, EMPTY);
  if (section === 'past') {
    if (!date) throw new Error('删 past 里的条目要传 date');
    const day = data.past.find(d => d.date === date);
    if (!day) return null;
    const idx = day.entries.findIndex(e => e.id === id);
    if (idx === -1) return null;
    const [removed] = day.entries.splice(idx, 1);
    writeJSON(NOTEBOOK_FILE, data);
    return removed;
  }
  if (!DIRECT_SECTIONS.includes(section)) throw new Error(`section 必须是 ${DIRECT_SECTIONS.join('/')}/past`);
  const idx = data[section].findIndex(e => e.id === id);
  if (idx === -1) return null;
  const [removed] = data[section].splice(idx, 1);
  writeJSON(NOTEBOOK_FILE, data);
  return removed;
}

function editEntry(section, id, text, date) {
  const data = readJSON(NOTEBOOK_FILE, EMPTY);
  if (section === 'past') {
    if (!date) throw new Error('改 past 里的条目要传 date');
    const day = data.past.find(d => d.date === date);
    if (!day) return null;
    const entry = day.entries.find(e => e.id === id);
    if (!entry) return null;
    entry.text = text;
    entry.editedAt = now();
    writeJSON(NOTEBOOK_FILE, data);
    return entry;
  }
  if (!DIRECT_SECTIONS.includes(section)) throw new Error(`section 必须是 ${DIRECT_SECTIONS.join('/')}/past`);
  const entry = data[section].find(e => e.id === id);
  if (!entry) return null;
  entry.text = text;
  entry.editedAt = now();
  writeJSON(NOTEBOOK_FILE, data);
  return entry;
}

function archiveToday() {
  const data = readJSON(NOTEBOOK_FILE, EMPTY);
  const date = todayStr();
  if (data.today.length === 0) return { archived: 0, date };
  let day = data.past.find(d => d.date === date);
  if (!day) { day = { date, entries: [] }; data.past.push(day); }
  day.entries.push(...data.today);
  const count = data.today.length;
  data.today = [];
  writeJSON(NOTEBOOK_FILE, data);
  return { archived: count, date };
}

function listPastDates() {
  const data = readJSON(NOTEBOOK_FILE, EMPTY);
  return data.past.map(d => d.date).sort().reverse();
}

// ---- MCP ----

const TOOLS = [
  {
    name: 'write',
    description: '写一条笔记，自动带时间戳。section: today(今天)/sticky(便签)/for_nor(给Nor的)。',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string', enum: ['today', 'sticky', 'for_nor'] }, text: { type: 'string' } },
      required: ['section', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_read',
    description: '读一个分区。section: today/sticky/for_nor/past。past 不传 date 只回日期列表，传 date(YYYY-MM-DD) 回那天的条目。',
    inputSchema: {
      type: 'object',
      properties: { section: { type: 'string', enum: ['today', 'sticky', 'for_nor', 'past'] }, date: { type: 'string' } },
      required: ['section'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_delete',
    description: '删一条笔记。section=past 时必须带 date。',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['today', 'sticky', 'for_nor', 'past'] },
        id: { type: 'string' },
        date: { type: 'string' },
      },
      required: ['section', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_edit',
    description: '改一条笔记的内容。section=past 时必须带 date。',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['today', 'sticky', 'for_nor', 'past'] },
        id: { type: 'string' },
        text: { type: 'string' },
        date: { type: 'string' },
      },
      required: ['section', 'id', 'text'],
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
    case 'write': return textResult(write(args.section, args.text));
    case 'note_read': return textResult(read(args.section, args.date));
    case 'note_delete': {
      const r = removeEntry(args.section, args.id, args.date);
      if (!r) throw new Error('没找到这条');
      return textResult({ ok: true });
    }
    case 'note_edit': {
      if (!args.text) throw new Error('text 必填');
      const r = editEntry(args.section, args.id, args.text, args.date);
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
            serverInfo: { name: 'notebook', version: '1.0.0' },
            instructions: '辞自己的笔记本，跟 ci-hours 分开。today/sticky/for_nor/past 四个分区，没有前端。',
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
