'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');
const { parseWebVtt, diffCueTracks } = require('../src/batch-diff');

let db;
let server;
let base;

before(async () => {
  db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

// ---------- 纯函数：WebVTT 解析 ----------

test('parseWebVtt：正常快照解析为升序 cues，空 cue 按损坏拒绝', () => {
  const content = [
    'WEBVTT', '',
    '1', '00:00:00.000 --> 00:00:01.000', '你好世界', '',
    '2', '00:00:01.500 --> 00:00:02.500', '欢迎光临', '',
  ].join('\n');
  const r = parseWebVtt(content);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.cues, [
    { start_ms: 0, end_ms: 1000, text: '你好世界' },
    { start_ms: 1500, end_ms: 2500, text: '欢迎光临' },
  ]);

  assert.equal(parseWebVtt('').ok, false);
  assert.equal(parseWebVtt('NOT VTT\n').ok, false);
  // 非法时间戳
  assert.equal(parseWebVtt('WEBVTT\n\n1\n0:00.000 --> 0:01.000\nx\n').ok, false);
  // 起止退化
  assert.equal(parseWebVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:01.000\nx\n').ok, false);
  // 缺正文行
  assert.equal(parseWebVtt('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n\n').ok, false);
  // 无法解释的块
  assert.equal(parseWebVtt('WEBVTT\n\nstray block\n').ok, false);
  // 重叠区段
  const overlap = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\na\n\n2\n00:00:01.000 --> 00:00:03.000\nb\n';
  assert.equal(parseWebVtt(overlap).ok, false);
});

test('parseWebVtt：兼容 BOM、CRLF、NOTE 块与多行正文', () => {
  const content = '﻿WEBVTT\r\n\r\nNOTE\r\n这是注释\r\n\r\n1\r\n00:00:00.000 --> 00:00:01.000\r\n第一行\r\n第二行\r\n';
  const r = parseWebVtt(content);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, '第一行\n第二行');
});

// ---------- 纯函数：区段比较 ----------

const c = (s, e, text) => ({ start_ms: s, end_ms: e, text });

test('diffCueTracks：完全相同 → 空', () => {
  const cues = [c(0, 1000, 'a'), c(1500, 2500, 'b')];
  assert.deepEqual(diffCueTracks(cues, cues), []);
});

test('diffCueTracks：文本修改只报修改区段，相等区段隔断', () => {
  const a = [c(0, 1000, 'a'), c(1500, 2500, 'b'), c(3000, 4000, 'd')];
  const b = [c(0, 1000, 'a'), c(1500, 2500, 'B'), c(3000, 4000, 'd')];
  assert.deepEqual(diffCueTracks(a, b), [
    { start_ms: 1500, end_ms: 2500, a_text: 'b', b_text: 'B' },
  ]);
});

test('diffCueTracks：一拆为二（边界两侧无对应行，不按行号配对）', () => {
  const a = [c(0, 2000, 'AB')];
  const b = [c(0, 1000, 'A'), c(1000, 2000, 'B')];
  assert.deepEqual(diffCueTracks(a, b), [
    { start_ms: 0, end_ms: 1000, a_text: 'AB', b_text: 'A' },
    { start_ms: 1000, end_ms: 2000, a_text: 'AB', b_text: 'B' },
  ]);
});

test('diffCueTracks：二合一', () => {
  const a = [c(0, 1000, 'A'), c(1000, 2000, 'B')];
  const b = [c(0, 2000, 'AB')];
  assert.deepEqual(diffCueTracks(a, b), [
    { start_ms: 0, end_ms: 1000, a_text: 'A', b_text: 'AB' },
    { start_ms: 1000, end_ms: 2000, a_text: 'B', b_text: 'AB' },
  ]);
});

test('diffCueTracks：整体移时（文本形状不变）报头/尾空白转换，不误报逐行修改', () => {
  const a = [c(0, 1000, 'a'), c(1000, 2000, 'b')];
  const b = [c(500, 1500, 'a'), c(1500, 2500, 'b')];
  // 边界集合 0/500/1000/1500/2000/2500：
  // [0,500) a→空白（头部空出）；[500,1000) a 与 a 重叠显示同一文本 → 相等不报；
  // [1000,1500) b→a（平移交叉）；[1500,2000) b 与 b 同文本 → 相等不报；
  // [2000,2500) 空白→b（尾部新增）。不按行号配对，整体移时只报真实的头/尾/交叉区段。
  assert.deepEqual(diffCueTracks(a, b), [
    { start_ms: 0, end_ms: 500, a_text: 'a', b_text: null },
    { start_ms: 1000, end_ms: 1500, a_text: 'b', b_text: 'a' },
    { start_ms: 2000, end_ms: 2500, a_text: null, b_text: 'b' },
  ]);
});

test('diffCueTracks：相邻差异区段两侧文本都未变时合并（跨相等边界不合并）', () => {
  // 两侧 cue 集合相同但文本只在两端不同；中间区段两侧同为 X（相等），必须隔断
  const a = [c(0, 1000, 'a1'), c(1000, 2000, 'X'), c(2000, 3000, 'a3')];
  const b = [c(0, 1000, 'b1'), c(1000, 2000, 'X'), c(2000, 3000, 'b3')];
  assert.deepEqual(diffCueTracks(a, b), [
    { start_ms: 0, end_ms: 1000, a_text: 'a1', b_text: 'b1' },
    { start_ms: 2000, end_ms: 3000, a_text: 'a3', b_text: 'b3' },
  ]);
});

test('diffCueTracks：空白 ↔ 字幕转换不漏报（新增字幕区段）', () => {
  const a = [c(0, 1000, 'a')];
  const b = [c(0, 1000, 'a'), c(1000, 2000, 'new')];
  assert.deepEqual(diffCueTracks(a, b), [
    { start_ms: 1000, end_ms: 2000, a_text: null, b_text: 'new' },
  ]);
});

test('diffCueTracks：时长变化（起止都改）按真实区段报', () => {
  const a = [c(0, 1000, 'a'), c(2000, 3000, 'b')];
  const b = [c(0, 1500, 'a'), c(2000, 3000, 'b')];
  assert.deepEqual(diffCueTracks(a, b), [
    { start_ms: 1000, end_ms: 1500, a_text: null, b_text: 'a' },
  ]);
});

test('diffCueTracks：合并相邻差异基本区段（两侧文本跨边界保持不变）', () => {
  // 基准：两条 cue 0-1000 a / 1000-2000 b；
  // 目标：对应位置插入一条与两侧文本都不同的 cue，把 b 挤到后面。
  // 关键：被新边界切开的两个基本区段若在某一侧文本相同，仍要求“两侧都不变”才合并。
  const a = [c(0, 3000, 'X')];
  const b = [c(0, 1000, 'X'), c(1000, 2000, 'Y'), c(2000, 3000, 'X')];
  // [0,1000) X=X 相等；[1000,2000) X→Y 差异；[2000,3000) X=X 相等 → 仅一段
  assert.deepEqual(diffCueTracks(a, b), [
    { start_ms: 1000, end_ms: 2000, a_text: 'X', b_text: 'Y' },
  ]);

  // 真正的合并：目标把 [0,3000) 整段换成同一文本 Y（中间边界来自基准的 cue 分割）
  const a2 = [c(0, 1000, 'P'), c(1000, 2000, 'Q'), c(2000, 3000, 'R')];
  const b2 = [c(0, 3000, 'Y')];
  // 三个基本区段两侧分别是 P/Y、Q/Y、R/Y：基准侧文本不同 → 不合并
  assert.equal(diffCueTracks(a2, b2).length, 3);

  // 基准三条文本同为 Z（正常交付不会出现相邻同文本 cue，但合并逻辑要正确）：
  // Z/Y、Z/Y、Z/Y 两侧均未变 → 合并为一个区段
  const a3 = [c(0, 1000, 'Z'), c(1000, 2000, 'Z'), c(2000, 3000, 'Z')];
  assert.deepEqual(diffCueTracks(a3, b2), [
    { start_ms: 0, end_ms: 3000, a_text: 'Z', b_text: 'Y' },
  ]);
});

// ---------- API 端到端 ----------

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

/**
 * 用真实交付流程造一个项目与批次：2 行字幕、en/fr 两种语言。
 * 返回 {pid, cues, deliver(langs)}。
 */
async function setupDeliveredProject(name) {
  const created = await api('/api/projects', 'POST', {
    name: name || '批次对照测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  const cues = layout.body.subtitles;

  const put = (lang, i, text) =>
    api(`/api/projects/${pid}/translations/${lang}/subtitles/${cues[i].id}`,
      'PUT', { text, cue_version: 1 });
  await put('en', 0, 'Hello world');
  await put('en', 1, 'Welcome');
  await put('fr', 0, 'Bonjour le monde');
  await put('fr', 1, 'Bienvenue');
  await put('ja-JP', 0, 'こんにちは');
  await put('ja-JP', 1, 'ようこそ');

  const deliver = async (langs, note) => {
    const r = await api(`/api/projects/${pid}/deliveries`, 'POST', {
      note: note || '',
      sub_version: layout.body.sub_version,
      rules_version: 1,
      languages: langs,
      translations: Object.fromEntries(
        langs.map((lang) => [lang, cues.map((cu) => ({ subtitle_id: cu.id, version: 1 }))])
      ),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  return { pid, cues, sub_version: layout.body.sub_version, deliver };
}

test('API：同批比较 → 空差异（原文与各语言均 unchanged）', async () => {
  const { pid, deliver } = await setupDeliveredProject();
  const b1 = await deliver(['en', 'fr'], '第一批');
  const r = await api(`/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=${b1.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.base_batch_id, b1.id);
  assert.equal(r.body.target_batch_id, b1.id);
  assert.deepEqual(r.body.languages.union, ['en', 'fr']);
  assert.equal(r.body.diff_file_count, 0);
  for (const f of r.body.files) {
    assert.equal(f.status, 'unchanged', `${f.kind}:${f.lang} 应无差异`);
    assert.equal(f.diff_count, 0);
    assert.deepEqual(f.segments, []);
  }
  // 文件版本引用与下载地址
  const src = r.body.files.find((f) => f.kind === 'source');
  assert.equal(src.base.download_url, `/api/projects/${pid}/exports/1`);
  assert.equal(src.target.download_url, `/api/projects/${pid}/exports/1`);
  const en = r.body.files.find((f) => f.lang === 'en');
  assert.equal(en.base.download_url, `/api/projects/${pid}/translations/en/exports/1`);
});

test('API：两批内容相同（仅版本号不同）→ 空差异，两侧版本分别给出', async () => {
  const { pid, deliver } = await setupDeliveredProject();
  const b1 = await deliver(['en', 'fr']);
  const b2 = await deliver(['en', 'fr']);
  const r = await api(`/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=${b2.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.diff_file_count, 0);
  const src = r.body.files.find((f) => f.kind === 'source');
  assert.equal(src.base.version, 1);
  assert.equal(src.target.version, 2);
  assert.equal(src.status, 'unchanged');
});

test('API：原文修改 + 英语译文修改后再交付 → 按区段列出差异与毫秒/两侧文本/版本', async () => {
  const { pid, cues, deliver } = await setupDeliveredProject();
  const b1 = await deliver(['en', 'fr'], '第一批');

  // 修改第 1 条原文与英语译文（法语不动）
  const patch = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH',
    { version: 1, text: '你好世界呀' });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  // 英语确认待复核后再改译文文本（v3）；法语仅确认恢复 current（文本不动）
  const confirm = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}/confirm`,
    'POST', { version: 1 });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  const upEn = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello the world', cue_version: 2, version: 2 });
  assert.ok(upEn.status === 200 || upEn.status === 201, JSON.stringify(upEn.body));
  // 法语也需恢复 current 才能再次交付：重新确认
  const cf = await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}/confirm`,
    'POST', { version: 1 });
  assert.equal(cf.status, 200, JSON.stringify(cf.body));
  const fresh = await api(`/api/projects/${pid}`);
  const subv = fresh.body.sub_version;
  const r2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: subv, rules_version: 1, languages: ['en', 'fr'],
    translations: {
      en: [
        { subtitle_id: cues[0].id, version: 3 },
        { subtitle_id: cues[1].id, version: 1 },
      ],
      fr: [
        { subtitle_id: cues[0].id, version: 2 },
        { subtitle_id: cues[1].id, version: 1 },
      ],
    },
  });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  const b2 = r2.body;

  const d = await api(`/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=${b2.id}`);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const src = d.body.files.find((f) => f.kind === 'source');
  assert.equal(src.status, 'changed');
  assert.equal(src.diff_count, 1);
  assert.deepEqual(src.segments[0], {
    start_ms: 0, end_ms: 1000, base_text: '你好世界', target_text: '你好世界呀',
  });
  assert.equal(src.base.version, 1);
  assert.equal(src.target.version, 2);
  // 法语未改：unchanged；英语译文文本已改：changed
  const fr = d.body.files.find((f) => f.lang === 'fr');
  assert.equal(fr.status, 'unchanged');
  const en = d.body.files.find((f) => f.lang === 'en');
  assert.equal(en.status, 'changed');
  assert.deepEqual(en.segments, [{
    start_ms: 0, end_ms: 1000,
    base_text: 'Hello world', target_text: 'Hello the world',
  }]);
  assert.equal(d.body.diff_file_count, 2);
});

test('API：语言并集——新增标 added、移除标 removed、共有 unchanged', async () => {
  const { pid, deliver } = await setupDeliveredProject();
  const b1 = await deliver(['en', 'fr'], '英法');
  const b2 = await deliver(['fr', 'ja-JP'], '法日');
  const r = await api(`/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=${b2.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.languages.base, ['en', 'fr']);
  assert.deepEqual(r.body.languages.target, ['fr', 'ja-JP']);
  assert.deepEqual(r.body.languages.added, ['ja-JP']);
  assert.deepEqual(r.body.languages.removed, ['en']);
  // union 顺序：基准序（共有+移除）→ 新增
  assert.deepEqual(r.body.languages.union, ['en', 'fr', 'ja-JP']);

  const byLang = Object.fromEntries(r.body.files
    .filter((f) => f.kind === 'translation')
    .map((f) => [f.lang, f]));
  assert.equal(byLang.en.status, 'removed');
  assert.equal(byLang.en.base.version, 1);
  assert.equal(byLang.en.target, null);
  assert.equal(byLang['ja-JP'].status, 'added');
  assert.equal(byLang['ja-JP'].base, null);
  assert.ok(byLang['ja-JP'].target.download_url.includes('translations/ja-JP/exports/'));
  assert.equal(byLang.fr.status, 'unchanged');
});

test('API：不受当前字幕/译文修改影响（改后旧两批对照结果不变）', async () => {
  const { pid, cues, deliver } = await setupDeliveredProject();
  const b1 = await deliver(['en']);
  const before = await api(`/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=${b1.id}`);
  // 大肆修改当前状态
  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH',
    { version: 1, text: '完全不同的当前内容' });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`, 'PUT',
    { text: 'currently changed', cue_version: 1, version: 1 });
  const after = await api(`/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=${b1.id}`);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, before.body);
});

test('API：参数非法/缺失 → 400', async () => {
  const { pid, deliver } = await setupDeliveredProject();
  const b1 = await deliver(['en']);
  const cases = [
    `/api/projects/${pid}/deliveries/diff?base=${b1.id}`,
    `/api/projects/${pid}/deliveries/diff?target=${b1.id}`,
    `/api/projects/${pid}/deliveries/diff?base=x&target=${b1.id}`,
    `/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=-3`,
  ];
  for (const u of cases) {
    const r = await api(u);
    assert.equal(r.status, 400, u);
    assert.ok(r.body.errors.length > 0);
  }
});

test('API：批次不存在 / 不属于项目 → 404 明确拒绝', async () => {
  const { pid, deliver } = await setupDeliveredProject('项目一');
  const other = await setupDeliveredProject('项目二');
  const b1 = await deliver(['en']);
  const bOther = await other.deliver(['en']);

  const notFound = await api(
    `/api/projects/${pid}/deliveries/diff?base=999999&target=${b1.id}`);
  assert.equal(notFound.status, 404);
  assert.ok(notFound.body.error.includes('基准批次 999999 不存在'));

  const targetNotFound = await api(
    `/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=888888`);
  assert.equal(targetNotFound.status, 404);
  assert.ok(targetNotFound.body.error.includes('目标批次 888888 不存在'));

  // 跨项目：用项目二上下文请求项目一的批次
  const cross = await api(
    `/api/projects/${other.pid}/deliveries/diff?base=${bOther.id}&target=${b1.id}`);
  assert.equal(cross.status, 404);
  assert.ok(cross.body.error.includes('不属于项目'));
  assert.equal(cross.body.actual_project_id, pid);
});

test('API：GET diff 不写任何数据（只读）', async () => {
  const { pid, deliver } = await setupDeliveredProject();
  const b1 = await deliver(['en']);
  const before = await api(`/api/projects/${pid}/deliveries`);
  await api(`/api/projects/${pid}/deliveries/diff?base=${b1.id}&target=${b1.id}`);
  const afterList = await api(`/api/projects/${pid}/deliveries`);
  assert.deepEqual(afterList.body, before.body);
});

// ---------- 快照损坏 / 缺失（直插 DB 构造） ----------

const vtt = (cues) => {
  const lines = ['WEBVTT', ''];
  cues.forEach((cu, i) => {
    const p = (ms) => {
      const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
      const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
      const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      const x = String(ms % 1000).padStart(3, '0');
      return `${h}:${m}:${s}.${x}`;
    };
    lines.push(String(i + 1), `${p(cu[0])} --> ${p(cu[1])}`, cu[2], '');
  });
  return lines.join('\n');
};

/**
 * 直插一个交付批次：files = [{kind:'source'}|{kind:'translation',lang}, content, cue_count?]
 * 返回批次 ID。版本号按各序列自动递增。
 */
function insertBatch(projectId, files, extra = {}) {
  const tx = db.transaction(() => {
    const bid = db.prepare(
      `INSERT INTO delivery_batches (project_id, note, sub_version, rules_version, cue_count, lang_count)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(projectId, extra.note || '', extra.sub_version ?? 1, 1,
      extra.cue_count ?? 2, files.filter((f) => f.kind === 'translation').length).lastInsertRowid;
    files.forEach((f, ord) => {
      if (f.kind === 'source') {
        const version = db.prepare(
          'SELECT COALESCE(MAX(version),0)+1 AS v FROM exports WHERE project_id = ?'
        ).get(projectId).v;
        const declared = f.cue_count ?? 2;
        const eid = f.content === '' || f.content === null
          ? db.prepare('INSERT INTO exports (project_id, version, content, cue_count) VALUES (?,?,?,?)')
            .run(projectId, version, f.content ?? '', declared).lastInsertRowid
          : db.prepare('INSERT INTO exports (project_id, version, content, cue_count) VALUES (?,?,?,?)')
            .run(projectId, version, f.content, declared).lastInsertRowid;
        db.prepare(
          `INSERT INTO delivery_files (batch_id, project_id, kind, lang, export_kind, export_id, version, cue_count, ord)
           VALUES (?,?,'source',NULL,'exports',?,?,?,?)`
        ).run(bid, projectId, eid, version, declared, ord);
      } else {
        const version = db.prepare(
          'SELECT COALESCE(MAX(version),0)+1 AS v FROM translation_exports WHERE project_id = ? AND lang = ?'
        ).get(projectId, f.lang).v;
        const eid = db.prepare(
          'INSERT INTO translation_exports (project_id, lang, version, content, cue_count) VALUES (?,?,?,?,?)'
        ).run(projectId, f.lang, version, f.content, f.cue_count ?? 2).lastInsertRowid;
        db.prepare(
          `INSERT INTO delivery_files (batch_id, project_id, kind, lang, export_kind, export_id, version, cue_count, ord)
           VALUES (?,?,'translation',?,'translation_exports',?,?,?,?)`
        ).run(bid, projectId, f.lang, eid, version, f.cue_count ?? 2, ord);
      }
    });
    return bid;
  });
  return tx();
}

test('API：快照正文损坏 → 500 指出批次与文件，整份报告失败', async () => {
  const pidRow = db.prepare('INSERT INTO projects (name) VALUES (?)').run('损坏批次项目').lastInsertRowid;
  db.prepare('INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?,?,?,?)')
    .run(pidRow, 30, 800, 20);
  const good = vtt([[0, 1000, 'a'], [1500, 2500, 'b']]);
  const corrupt = 'WEBVTT\n\n1\n00:00:00.000 --> ???\n坏\n';
  const b1 = insertBatch(pidRow, [
    { kind: 'source', content: good },
    { kind: 'translation', lang: 'en', content: good },
  ]);
  // 第二批：英语译文快照损坏（验证译文文件也能被指出）
  const b2 = insertBatch(pidRow, [
    { kind: 'source', content: good },
    { kind: 'translation', lang: 'en', content: corrupt },
  ]);
  const r = await api(`/api/projects/${pidRow}/deliveries/diff?base=${b1}&target=${b2}`);
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.code, 'snapshot_corrupt');
  assert.equal(r.body.batch_id, b2);
  assert.deepEqual(r.body.file, { kind: 'translation', lang: 'en', ord: 1 });
  assert.ok(r.body.error.includes('整份报告失败'));
  // 不返回 files 部分结果
  assert.equal(r.body.files, undefined);
});

test('API：快照缺失（export 行不存在）→ 500 snapshot_missing，基准/目标都检查', async () => {
  const pidRow = db.prepare('INSERT INTO projects (name) VALUES (?)').run('缺失批次项目').lastInsertRowid;
  db.prepare('INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?,?,?,?)')
    .run(pidRow, 30, 800, 20);
  const good = vtt([[0, 1000, 'a'], [1500, 2500, 'b']]);
  const b1 = insertBatch(pidRow, [
    { kind: 'source', content: good },
    { kind: 'translation', lang: 'en', content: good },
  ]);
  // 第二批：delivery_files 引用不存在的 translation_exports 行
  const b2 = db.transaction(() => {
    const bid = db.prepare(
      'INSERT INTO delivery_batches (project_id, note, sub_version, rules_version, cue_count, lang_count) VALUES (?,?,1,1,2,1)'
    ).run(pidRow, '').lastInsertRowid;
    const v2 = db.prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM exports WHERE project_id=?').get(pidRow).v;
    const eid = db.prepare('INSERT INTO exports (project_id, version, content, cue_count) VALUES (?,?,?,?)')
      .run(pidRow, v2, good, 2).lastInsertRowid;
    db.prepare(
      `INSERT INTO delivery_files (batch_id, project_id, kind, lang, export_kind, export_id, version, cue_count, ord)
       VALUES (?,?,'source',NULL,'exports',?,?,?,0)`
    ).run(bid, pidRow, eid, v2, 2);
    db.prepare(
      `INSERT INTO delivery_files (batch_id, project_id, kind, lang, export_kind, export_id, version, cue_count, ord)
       VALUES (?,?,'translation','en','translation_exports',?,?,?,1)`
    ).run(bid, pidRow, 999999, 1, 2);
    return bid;
  })();
  const r = await api(`/api/projects/${pidRow}/deliveries/diff?base=${b1}&target=${b2}`);
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.code, 'snapshot_missing');
  assert.equal(r.body.batch_id, b2);
  assert.equal(r.body.file.lang, 'en');
  assert.ok(/translation_exports/.test(r.body.detail));
});

test('API：快照 cue_count 与正文不一致 → 500 指出文件', async () => {
  const pidRow = db.prepare('INSERT INTO projects (name) VALUES (?)').run('计数不一致项目').lastInsertRowid;
  db.prepare('INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?,?,?,?)')
    .run(pidRow, 30, 800, 20);
  const good = vtt([[0, 1000, 'a'], [1500, 2500, 'b']]);
  const b1 = insertBatch(pidRow, [
    { kind: 'source', content: good },
    { kind: 'translation', lang: 'en', content: good },
  ]);
  // 清单 cue_count 谎称 3（正文与快照行均为 2）
  const b2 = insertBatch(pidRow, [
    { kind: 'source', content: good, cue_count: 3 },
    { kind: 'translation', lang: 'en', content: good },
  ]);
  const r = await api(`/api/projects/${pidRow}/deliveries/diff?base=${b1}&target=${b2}`);
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.code, 'snapshot_corrupt');
  assert.deepEqual(r.body.file, { kind: 'source', lang: null, ord: 0 });
});

test('API：原文快照正文为空 → 500 snapshot_missing', async () => {
  const pidRow = db.prepare('INSERT INTO projects (name) VALUES (?)').run('空快照项目').lastInsertRowid;
  db.prepare('INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?,?,?,?)')
    .run(pidRow, 30, 800, 20);
  const good = vtt([[0, 1000, 'a'], [1500, 2500, 'b']]);
  const b1 = insertBatch(pidRow, [{ kind: 'source', content: good }]);
  const b2 = insertBatch(pidRow, [{ kind: 'source', content: '' }]);
  const r = await api(`/api/projects/${pidRow}/deliveries/diff?base=${b1}&target=${b2}`);
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.equal(r.body.code, 'snapshot_missing');
  assert.equal(r.body.batch_id, b2);
});

test('API：拆分/合并/空白转换场景（直插快照）按时间区段如实报出', async () => {
  const pidRow = db.prepare('INSERT INTO projects (name) VALUES (?)').run('区段场景项目').lastInsertRowid;
  db.prepare('INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?,?,?,?)')
    .run(pidRow, 30, 800, 20);
  const aSrc = vtt([[0, 2000, 'AB']]);
  const bSrc = vtt([[0, 1000, 'A'], [1000, 2000, 'B'], [2000, 3000, 'C']]);
  const b1 = insertBatch(pidRow, [{ kind: 'source', content: aSrc, cue_count: 1 }], { cue_count: 1 });
  const b2 = insertBatch(pidRow, [{ kind: 'source', content: bSrc, cue_count: 3 }], { cue_count: 3 });
  const r = await api(`/api/projects/${pidRow}/deliveries/diff?base=${b1}&target=${b2}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const src = r.body.files.find((f) => f.kind === 'source');
  assert.equal(src.status, 'changed');
  assert.deepEqual(src.segments, [
    { start_ms: 0, end_ms: 1000, base_text: 'AB', target_text: 'A' },
    { start_ms: 1000, end_ms: 2000, base_text: 'AB', target_text: 'B' },
    { start_ms: 2000, end_ms: 3000, base_text: null, target_text: 'C' },
  ]);
});
