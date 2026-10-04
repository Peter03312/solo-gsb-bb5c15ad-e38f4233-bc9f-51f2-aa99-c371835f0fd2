'use strict';

/**
 * 片方交付批次对照（只读）：输入同项目两个交付批次 ID（基准批次 a、目标批次 b），
 * 以两批各自冻结的 WebVTT 快照为准，返回“原文 + 两批语言并集”的逐文件对照。
 *
 * 比较语义（见 compareCues）：
 *   - 按字幕起止时间构成的区段比较实际显示文本，绝不按行号/顺序配对；
 *   - 拆分、合并、整体移时（文本不变但时间整体平移）都按时间区段如实报出；
 *   - 字幕之间的空白与字幕的转换（空 ↔ 文本）不漏报：空白就是区间内无任何 cue；
 *   - 相邻差异区段若两侧各自的显示文本都未变则合并为一个区段。
 *
 * 完整性（见 loadSnapshot / loadBatchSnapshots）：
 *   - 批次不属于项目或不存在 → 调用方按 404 明确拒绝；
 *   - 快照行缺失、正文为空、WebVTT 格式损坏、与清单元数据不一致 → SnapshotError，
 *     指出批次与文件，整份报告失败，不返回任何部分结果。
 *
 * 查询只读：仅 SELECT 冻结快照，不受当前字幕、译文或术语修改影响。
 */

// ---------- WebVTT 解析（只读快照完整性校验用） ----------

const TS = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

/** 解析单个 HH:MM:SS.mmm 时间戳；非法返回 null */
function parseTimestamp(s) {
  const m = TS.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (min > 59 || sec > 59) return null;
  return h * 3600000 + min * 60000 + sec * 1000 + Number(m[4]);
}

/**
 * 解析冻结的 WebVTT 快照为 cues：[{start_ms, end_ms, text}]（按开始、结束升序）。
 *
 * 由本服务 toWebVtt 生成的快照形状是固定的（WEBVTT 头、数字 cue 标识行、
 * 时间行、正文行、空行）；解析器同时兼容标准 WebVTT 的 NOTE/STYLE/REGION 块与
 * 时间行尾部设置。任何无法解释的内容、非法时间、退化或重叠区间都按格式损坏拒绝。
 *
 * 返回 { ok, cues?, error? }；error 为中文说明（不含批次/文件名前缀，由调用方拼）。
 */
function parseWebVtt(content) {
  if (typeof content !== 'string' || content === '') {
    return { ok: false, error: '快照内容为空，不是有效的 WebVTT（缺少 WEBVTT 文件签名）' };
  }
  // 先归一化换行（CRLF/CR → LF），再仅容忍文件开头的 UTF-8 BOM
  const text0 = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const text = text0.charCodeAt(0) === 0xfeff ? text0.slice(1) : text0;
  if (!text.startsWith('WEBVTT')) {
    return { ok: false, error: '不是有效的 WebVTT：首行必须以 WEBVTT 文件签名开头' };
  }
  // 签名行必须到行尾结束（WEBVTT 后可跟空格与描述文本）
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  if (firstLine.length > 6 && firstLine.charCodeAt(6) !== 0x20 && firstLine.charCodeAt(6) !== 0x09) {
    return { ok: false, error: 'WEBVTT 文件签名行格式非法' };
  }

  // 按空行切块（与生成端一致，统一按 \n 切分）
  const rawBlocks = text.split(/\n[ \t]*\n/);
  const cues = [];
  // 第 0 块是文件头（WEBVTT …），逐块解析其余部分
  for (let bi = 1; bi < rawBlocks.length; bi++) {
    const block = rawBlocks[bi].replace(/^\n+/, '').replace(/\s+$/, '');
    if (block === '') continue;
    const lines = block.split('\n');

    // 整块描述符：NOTE（注释）/ STYLE / REGION —— 跳过
    if (lines[0] === 'NOTE' || /^NOTE([ \t]|$)/.test(lines[0]) ||
        lines[0] === 'STYLE' || lines[0] === 'REGION') {
      continue;
    }

    // 找时间行：本服务生成的快照其前一行是数字 cue 标识；标准 WebVTT 也允许
    // 时间行直接作为块首。时间行之前最多一行（cue 标识）。
    let ti = lines.findIndex((l) => l.includes(' --> '));
    if (ti === -1) {
      return { ok: false, error: `存在不含时间行的字幕块：${JSON.stringify(lines[0].slice(0, 40))}` };
    }
    if (ti > 1) {
      return { ok: false, error: '字幕块的时间行之前出现多行无法识别的内容（cue 标识至多一行）' };
    }
    const timeLine = lines[ti];
    const arrowIdx = timeLine.indexOf(' --> ');
    const startRaw = timeLine.slice(0, arrowIdx);
    // 箭头后为结束时间，再往后是空格分隔的 cue 设置（本服务不生成，出现则忽略）
    const rest = timeLine.slice(arrowIdx + 5);
    const sp = rest.search(/[ \t]/);
    const endRaw = sp === -1 ? rest : rest.slice(0, sp);

    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (start === null || end === null) {
      return { ok: false, error: `字幕时间戳非法或格式不是 HH:MM:SS.mmm：${JSON.stringify(timeLine.slice(0, 60))}` };
    }
    if (start >= end) {
      return { ok: false, error: `存在起止时间退化（开始 ≥ 结束）的字幕：${startRaw} --> ${endRaw}` };
    }

    const payloadLines = lines.slice(ti + 1);
    if (payloadLines.length === 0 || payloadLines.some((l) => l === '')) {
      return { ok: false, error: `字幕 ${startRaw} --> ${endRaw} 缺少正文行（空正文快照不应由正常交付生成）` };
    }
    cues.push({ start_ms: start, end_ms: end, text: payloadLines.join('\n') });
  }

  cues.sort((x, y) => x.start_ms - y.start_ms || x.end_ms - y.end_ms);
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start_ms < cues[i - 1].end_ms) {
      return { ok: false, error: '快照时间轴损坏：存在相互重叠的字幕区段（交付快照各文件共用同一时间轴，不应重叠）' };
    }
  }
  return { ok: true, cues };
}

// ---------- 区段比较（核心算法） ----------

/** 在某毫秒点上正在显示的 cue 文本（区间左闭右开）；无显示返回 null（空白） */
function activeText(cues, t) {
  // cues 已按开始升序且互不重叠；线性扫描（快照量级足够），可改二分。
  for (const c of cues) {
    if (c.start_ms <= t && t < c.end_ms) return c.text;
    if (c.start_ms > t) break;
  }
  return null;
}

/**
 * 比较两侧 cue 序列的实际显示文本，返回合并后的差异区段列表。
 *
 * 做法：取两侧全部 cue 边界（去重升序）把时间轴切成基本区段；对每个区段取内点，
 * 内点上的显示文本就是该区段两侧各自实际显示的内容（null = 空白，即区间内无
 * cue）。两侧文本不同（含 空↔文本、空↔不同文本）即为差异基本区段。随后合并：
 * 相邻差异区段若 a 侧文本相同且 b 侧文本相同，则并为一个区段（[首起, 末止]）。
 *
 * 因此：
 *   - 拆分/合并不按行号配对，直接体现为时间覆盖与文本的差异区段；
 *   - 两侧完全相同的整体移时（文本与相对形状不变、只是平移）会报为
 *     “尾部新增空白 / 头部变空白”等真实区段差异，绝不误报为逐行修改；
 *   - 相等区段天然隔断合并，仅在彼此相邻且两侧文本都未变时合并。
 *
 * 返回 [{ start_ms, end_ms, a_text, b_text }]，时间升序；无差异返回 []。
 */
function diffCueTracks(cuesA, cuesB) {
  const bounds = new Set();
  for (const c of cuesA) { bounds.add(c.start_ms); bounds.add(c.end_ms); }
  for (const c of cuesB) { bounds.add(c.start_ms); bounds.add(c.end_ms); }
  const points = [...bounds].sort((x, y) => x - y);

  const raws = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const s = points[i];
    const e = points[i + 1];
    if (s === e) continue;
    const ta = activeText(cuesA, s + 0.5);
    const tb = activeText(cuesB, s + 0.5);
    if (ta !== tb) raws.push({ start_ms: s, end_ms: e, a_text: ta, b_text: tb });
  }

  // 合并相邻差异区段：两侧各自文本都未变（基本区段在同一边界集合下必然相邻）
  const merged = [];
  for (const seg of raws) {
    const last = merged[merged.length - 1];
    if (last && last.end_ms === seg.start_ms &&
        last.a_text === seg.a_text && last.b_text === seg.b_text) {
      last.end_ms = seg.end_ms;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

// ---------- 快照装载与批次编排 ----------

class SnapshotError extends Error {
  /**
   * @param code snapshot_missing（快照行/正文缺失）| snapshot_corrupt（格式损坏/不一致）
   * @param batchId 批次 ID
   * @param file 文件描述 {kind, lang, ord}
   * @param detail 中文细节
   */
  constructor(code, batchId, file, detail) {
    const what = file.kind === 'source' ? '原文文件' : `语言 ${file.lang} 译文文件`;
    super(`批次 ${batchId} ${what}（ord=${file.ord}）${code === 'snapshot_missing' ? '快照缺失' : '快照格式损坏'}：${detail}`);
    this.code = code;
    this.batch_id = batchId;
    this.file = { kind: file.kind, lang: file.lang, ord: file.ord };
    this.detail = detail;
  }
}

/** 文件在批次清单中的展示身份 */
function fileLabel(f) {
  return f.kind === 'source' ? 'source' : `translation:${f.lang}`;
}

/** 既有下载地址（与交付清单 mapFileRow 完全一致，保持下载约定兼容） */
function downloadUrl(projectId, f) {
  return f.kind === 'source'
    ? `/api/projects/${projectId}/exports/${f.version}`
    : `/api/projects/${projectId}/translations/${encodeURIComponent(f.lang)}/exports/${f.version}`;
}

/**
 * 读取并校验一个交付文件的冻结快照。db 为 better-sqlite3 实例。
 * 成功返回 { cues, cue_count, content_length }；任何完整性问题抛 SnapshotError。
 */
function loadSnapshot(db, batchId, f) {
  let row;
  if (f.export_kind === 'exports') {
    row = db.prepare('SELECT id, version, content, cue_count FROM exports WHERE id = ?').get(f.export_id);
  } else if (f.export_kind === 'translation_exports') {
    row = db.prepare(
      'SELECT id, version, content, cue_count FROM translation_exports WHERE id = ?'
    ).get(f.export_id);
  } else {
    throw new SnapshotError('snapshot_corrupt', batchId, f,
      `清单引用了未知快照序列 ${JSON.stringify(f.export_kind)}`);
  }
  if (!row) {
    throw new SnapshotError('snapshot_missing', batchId, f,
      `${f.export_kind} 序列中 id=${f.export_id}（版本 v${f.version}）的快照行不存在`);
  }
  if (row.version !== f.version) {
    throw new SnapshotError('snapshot_corrupt', batchId, f,
      `清单记录版本 v${f.version}，但快照行版本为 v${row.version}`);
  }
  if (typeof row.content !== 'string' || row.content === '') {
    throw new SnapshotError('snapshot_missing', batchId, f,
      `${f.export_kind} 版本 v${f.version} 的快照正文为空`);
  }
  const parsed = parseWebVtt(row.content);
  if (!parsed.ok) {
    throw new SnapshotError('snapshot_corrupt', batchId, f, parsed.error);
  }
  if (parsed.cues.length !== row.cue_count) {
    throw new SnapshotError('snapshot_corrupt', batchId, f,
      `快照元数据 cue_count=${row.cue_count}，但正文实际解析出 ${parsed.cues.length} 条字幕`);
  }
  if (row.cue_count !== f.cue_count) {
    throw new SnapshotError('snapshot_corrupt', batchId, f,
      `批次清单 cue_count=${f.cue_count}，快照记录为 ${row.cue_count}`);
  }
  return { cues: parsed.cues, cue_count: parsed.cues.length, content_length: row.content.length };
}

/** 读取批次清单行（顺序 ord 升序）；批次不存在返回 null */
function listBatchFileRows(db, projectId, batchId) {
  return db.prepare(
    'SELECT * FROM delivery_files WHERE project_id = ? AND batch_id = ? ORDER BY ord'
  ).all(projectId, batchId);
}

/**
 * 编排两个批次的完整对照报告。所有快照全部读取并校验通过后才组装结果——
 * 任一文件缺失或损坏立即抛 SnapshotError，不返回部分结果。
 *
 * @param db better-sqlite3 实例（只读使用）
 * @param projectId 项目 ID（两个批次必须同属该项目，归属校验由路由先做）
 * @param rowsA 基准批次的 delivery_batches 行
 * @param rowsB 目标批次的 delivery_batches 行
 */
function buildBatchDiff(db, projectId, rowsA, rowsB) {
  const fileRowsA = listBatchFileRows(db, projectId, rowsA.id);
  const fileRowsB = listBatchFileRows(db, projectId, rowsB.id);

  // 批次清单本身的结构完整性（正常交付必有 1 个原文 + 每语言 1 个译文）
  const assertManifest = (rows, batchId) => {
    const sources = rows.filter((f) => f.kind === 'source');
    if (sources.length !== 1) {
      const f0 = sources[0] || rows[0] || { kind: 'translation', lang: null, ord: 0 };
      throw new SnapshotError('snapshot_corrupt', batchId, f0,
        `批次清单应有且仅有 1 个原文文件，实际为 ${sources.length} 个`);
    }
    const seen = new Set();
    for (const f of rows) {
      if (f.kind === 'translation') {
        if (!f.lang) {
          throw new SnapshotError('snapshot_corrupt', batchId, f, '译文文件缺少语言代号');
        }
        if (seen.has(f.lang)) {
          throw new SnapshotError('snapshot_corrupt', batchId, f, `语言 ${f.lang} 在清单中重复`);
        }
        seen.add(f.lang);
      }
    }
  };
  assertManifest(fileRowsA, rowsA.id);
  assertManifest(fileRowsB, rowsB.id);

  // 先装载并校验全部快照（任一失败 → SnapshotError，整份报告失败）
  const loadAll = (rows, batchId) => {
    const map = new Map();
    for (const f of rows) {
      const snap = loadSnapshot(db, batchId, f);
      map.set(fileLabel(f), { row: f, ...snap });
    }
    return map;
  };
  const snapsA = loadAll(fileRowsA, rowsA.id);
  const snapsB = loadAll(fileRowsB, rowsB.id);

  // 语言并集排序：两批共有（按基准批次 ord）→ 基准独有（移除）→ 目标独有（新增）
  const langsA = fileRowsA.filter((f) => f.kind === 'translation').map((f) => f.lang);
  const langsB = fileRowsB.filter((f) => f.kind === 'translation').map((f) => f.lang);
  const setB = new Set(langsB);
  const orderedLangs = [
    ...langsA,                       // 共有 + 移除（基准顺序）
    ...langsB.filter((l) => !langsA.includes(l)), // 新增（目标顺序）
  ];

  const fileRef = (batchRow, f, snap) => ({
    batch_id: batchRow.id,
    kind: f.kind,
    lang: f.lang,
    export_kind: f.export_kind,
    version: f.version,
    cue_count: snap ? snap.cue_count : f.cue_count,
    download_url: downloadUrl(projectId, f),
  });

  const compareOne = (label, kind, lang) => {
    const inA = snapsA.has(label);
    const inB = snapsB.has(label);
    const sa = inA ? snapsA.get(label) : null;
    const sb = inB ? snapsB.get(label) : null;

    if (inA && !inB) {
      return {
        kind, lang, status: 'removed',
        base: fileRef(rowsA, sa.row, sa), target: null, diff_count: 0, segments: [],
      };
    }
    if (!inA && inB) {
      return {
        kind, lang, status: 'added',
        base: null, target: fileRef(rowsB, sb.row, sb), diff_count: 0, segments: [],
      };
    }
    const segments = diffCueTracks(sa.cues, sb.cues).map((seg) => ({
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      base_text: seg.a_text,
      target_text: seg.b_text,
    }));
    return {
      kind, lang,
      status: segments.length === 0 ? 'unchanged' : 'changed',
      base: fileRef(rowsA, sa.row, sa),
      target: fileRef(rowsB, sb.row, sb),
      diff_count: segments.length,
      segments,
    };
  };

  const files = [compareOne('source', 'source', null)];
  for (const lang of orderedLangs) {
    files.push(compareOne(`translation:${lang}`, 'translation', lang));
  }

  return {
    project_id: projectId,
    base_batch_id: rowsA.id,
    target_batch_id: rowsB.id,
    base: {
      id: rowsA.id, note: rowsA.note,
      sub_version: rowsA.sub_version, rules_version: rowsA.rules_version,
      cue_count: rowsA.cue_count, lang_count: rowsA.lang_count, created_at: rowsA.created_at,
    },
    target: {
      id: rowsB.id, note: rowsB.note,
      sub_version: rowsB.sub_version, rules_version: rowsB.rules_version,
      cue_count: rowsB.cue_count, lang_count: rowsB.lang_count, created_at: rowsB.created_at,
    },
    languages: {
      union: orderedLangs,
      base: langsA,
      target: langsB,
      added: langsB.filter((l) => !langsA.includes(l)),
      removed: langsA.filter((l) => !setB.has(l)),
    },
    files,
    diff_file_count: files.filter((f) => f.status === 'changed').length,
  };
}

module.exports = {
  SnapshotError,
  parseTimestamp,
  parseWebVtt,
  diffCueTracks,
  buildBatchDiff,
};
