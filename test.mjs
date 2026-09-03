// 冒烟测试：npm test。起临时 DATA_DIR，种一份旧格式 notebook.json，把六个分区/搜索/标签/归档都走一遍。
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
const PORT = 4300 + Math.floor(Math.random() * 500), DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-')), TOKEN = 't';
const oldAt = new Date(Date.now() - 10 * 86400000).toISOString();
fs.writeFileSync(path.join(DATA, 'notebook.json'), JSON.stringify({
  today: [{ id: 'a1', text: '今天钓到一条鱼', at: new Date().toISOString() }],
  sticky: [{ id: 's1', text: '铁律：她说要走的时候认真接', at: oldAt }],
  for_nor: [],
  past: [{ date: '2026-08-30', entries: [{ id: 'p1', text: '旧的一天，聊了场域理论', at: oldAt }] }]
}));
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT, DATA_DIR: DATA, NOTEBOOK_TOKEN: TOKEN }, stdio: 'ignore' });
let id = 0;
const rpc = async (method, params) => (await fetch(`http://127.0.0.1:${PORT}/mcp?token=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json();
const call = async (name, args) => { const j = await rpc('tools/call', { name, arguments: args }); const t = j.result.content[0].text; if (j.result.isError) throw new Error(t); return JSON.parse(t); };
let failed = 0;
const step = async (n, f) => { try { await f(); console.log('✓', n); } catch (e) { failed++; console.log('✗', n, '\n   ', e.message); } };
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  await step('tools/list 有 note_search，write 的 section 有 heartbeat/draft', async () => {
    const t = (await rpc('tools/list')).result.tools;
    assert.ok(t.find(x => x.name === 'note_search'));
    assert.deepEqual(t.find(x => x.name === 'write').inputSchema.properties.section.enum, ['today', 'sticky', 'for_nor', 'heartbeat', 'draft']);
  });
  await step('旧文件能读，缺的分区自动补', async () => {
    assert.equal((await call('note_read', { section: 'today' })).length, 1);
    assert.deepEqual(await call('note_read', { section: 'heartbeat' }), []);
    assert.deepEqual(await call('note_read', { section: 'draft' }), []);
  });
  let hb;
  await step('heartbeat：写、读、不能改、能删；时间戳是墨尔本时间', async () => {
    hb = await call('write', { section: 'heartbeat', text: '[heartbeat] 12:30 醒了。钓了一条鱼。', tags: ['heartbeat', '钓鱼'] });
    assert.ok(/[+-]\d{2}:\d{2}$/.test(hb.at), hb.at);
    await call('write', { section: 'heartbeat', text: '[schedule] 15:00 整理了记忆', tags: ['schedule'] });
    assert.equal((await call('note_read', { section: 'heartbeat' })).length, 2);
    assert.equal((await call('note_read', { section: 'heartbeat', tag: 'schedule' })).length, 1);
    await assert.rejects(call('note_edit', { section: 'heartbeat', id: hb.id, text: 'x' }), /不改/);
  });
  await step('heartbeat 超过 7 天自动清', async () => {
    const f = path.join(DATA, 'notebook.json'); const d = JSON.parse(fs.readFileSync(f));
    d.heartbeat.push({ id: 'old', text: '十天前', at: oldAt, tags: [] }); fs.writeFileSync(f, JSON.stringify(d));
    const list = await call('note_read', { section: 'heartbeat' });
    assert.ok(!list.find(x => x.id === 'old') && list.length === 2);
  });
  let dr;
  await step('draft：写、改文字和 tags', async () => {
    dr = await call('write', { section: 'draft', text: '想给她写点什么，还没想好', tags: ['想法'] });
    const e = await call('note_edit', { section: 'draft', id: dr.id, tags: ['想法', '给她的'] });
    assert.deepEqual(e.tags, ['想法', '给她的']); assert.equal(e.text, '想给她写点什么，还没想好');
    const e2 = await call('note_edit', { section: 'draft', id: dr.id, text: '改过了' });
    assert.equal(e2.text, '改过了'); assert.deepEqual(e2.tags, ['想法', '给她的']);
  });
  await step('note_search：中文关键词、跨分区含 past、按 section、按 tag、都不传报错', async () => {
    const r = await call('note_search', { query: '钓鱼' });
    assert.ok(r.find(x => x.section === 'heartbeat') && r.find(x => x.section === 'today'), JSON.stringify(r));
    const p = await call('note_search', { query: '场域' });
    assert.equal(p[0].section, 'past'); assert.equal(p[0].date, '2026-08-30'); assert.ok(p[0].excerpt.includes('场域'));
    assert.equal((await call('note_search', { query: '钓', section: 'heartbeat' })).length, 1);
    assert.equal((await call('note_search', { tag: '给她的' }))[0].id, dr.id);
    assert.equal((await call('note_search', { query: '认真接', tag: '想法' })).length, 0);
    assert.deepEqual(await call('note_search', { query: 'zzqq完全没有的' }), []);
    await assert.rejects(call('note_search', {}), /至少/);
  });
  await step('archive_today 带着 tags 进 past，past 按 tag 读', async () => {
    await call('write', { section: 'today', text: '晚上聊了记忆整理', tags: ['记忆'] });
    const a = await call('archive_today'); assert.equal(a.archived, 2);
    assert.deepEqual(await call('note_read', { section: 'today' }), []);
    const days = await call('note_read', { section: 'past', tag: '记忆' });
    assert.equal(days.length, 1); assert.equal(days[0].count, 1);
    const entries = await call('note_read', { section: 'past', date: a.date, tag: '记忆' });
    assert.equal(entries[0].text, '晚上聊了记忆整理'); assert.equal(entries[0].section, 'past');
    assert.equal((await call('list_past_dates')).length, 2);
  });
  await step('sticky / for_nor 用法不变；删除', async () => {
    const s = await call('write', { section: 'sticky', text: '新铁律' });
    await call('note_edit', { section: 'sticky', id: s.id, text: '新铁律（改）' });
    assert.deepEqual(await call('note_delete', { section: 'sticky', id: s.id }), { ok: true });
    await assert.rejects(call('note_delete', { section: 'past', id: 'p1' }), /date/);
    assert.equal((await call('note_read', { section: 'for_nor' })).length, 0);
  });
} finally { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); }
if (failed) { console.log(`${failed} 项失败`); process.exit(1); } console.log('全部通过');
