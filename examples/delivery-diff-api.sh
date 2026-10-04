#!/usr/bin/env bash
# 片方审阅：两个交付批次冻结字幕的实际差异（只读对照）调用示例。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/delivery-diff-api.sh [BASE_URL]
# 例如：bash examples/delivery-diff-api.sh http://localhost:3000
#
# 流程：新建项目并排版 → 保存 en/fr/ja-JP 译文 → 交付第一批（en+fr）
#       → 修改一条原文与英语译文、时间轴不变 → 交付第二批（fr+ja-JP）
#       → 对照两批：原文/英语差异区段（起止毫秒+两侧文本+两侧文件版本）、
#         fr 共有且未变、en 移除、ja-JP 新增 → 同批自比返回空差异
#       → 非法批次 / 不存在 / 跨项目的拒绝示例。
#
# 对照完全基于批次冻结的 WebVTT：示例最后会再改当前字幕，随后重查，
# 结果不变（查询只读，不受当前字幕、译文或术语修改影响）。
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（2 行源字幕） ==="
WORDS='{"name":"片方批次对照 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
SUBV="$(echo "$out" | body_of | jget sub_version)"
echo "源字幕 id=$SID1 / $SID2"

echo
echo "=== 1. 保存 en / fr / ja-JP 三种语言译文（各两行） ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour le monde","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID2" '{"text":"Bienvenue","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/ja-JP/subtitles/$SID1" '{"text":"こんにちは","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/ja-JP/subtitles/$SID2" '{"text":"ようこそ","cue_version":1}' >/dev/null
echo "三种语言 current 译文已保存"

# 按给定语言与逐行译文版本构造交付请求体
build_delivery() {
  python3 - "$PID" "$SID1" "$SID2" "$SUBV" "$@" <<'PY'
import json, sys
pid, sid1, sid2, subv = sys.argv[1:5]
langs = sys.argv[5:]
print(json.dumps({
  "sub_version": int(subv), "rules_version": 1, "languages": langs,
  "translations": {
    lang: [{"subtitle_id": int(sid1), "version": 1},
           {"subtitle_id": int(sid2), "version": 1}]
    for lang in langs
  },
}))
PY
}

echo
echo "=== 2. 第一批交付：en + fr ==="
out="$(req POST "/api/projects/$PID/deliveries" "$(build_delivery en fr)")"
echo "HTTP $(echo "$out" | code_of)"
BID1="$(echo "$out" | body_of | jget id)"
echo "基准批次 id=$BID1"

echo
echo "=== 3. 修改第 1 条原文与英语译文（时间轴不变） ==="
SUBV="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好世界呀"}' | body_of | jget sub_version)"
# 原文改动 → en/fr/ja-JP 第 1 条译文均转待复核：en 改译文文本，fr/ja-JP 确认沿用
req POST "/api/projects/$PID/translations/en/subtitles/$SID1/confirm" '{"version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello the world","cue_version":2,"version":2}' >/dev/null
req POST "/api/projects/$PID/translations/fr/subtitles/$SID1/confirm" '{"version":1}' >/dev/null
req POST "/api/projects/$PID/translations/ja-JP/subtitles/$SID1/confirm" '{"version":1}' >/dev/null
echo "原文改为「你好世界呀」；en 改为「Hello the world」（v3）；fr / ja-JP 文本沿用"

echo
echo "=== 4. 第二批交付：fr + ja-JP（语言集合与第一批不同） ==="
BODY2="$(python3 - "$PID" "$SID1" "$SID2" "$SUBV" "$BASE" <<'PY'
import json, sys, urllib.request
pid, sid1, sid2, subv = sys.argv[1:5]
base = sys.argv[5].rstrip("/")
langs = ["fr", "ja-JP"]
trans = {}
for lang in langs:
    with urllib.request.urlopen(f"{base}/api/projects/{pid}/translations/{lang}") as r:
        view = json.load(r)
    trans[lang] = [
      {"subtitle_id": e["cue"]["id"], "version": e["translation"]["version"]}
      for e in view["entries"] if e["state"] == "current" and e["valid"]
    ]
print(json.dumps({"sub_version": int(subv), "rules_version": 1,
                  "languages": langs, "translations": trans}))
PY
)"
out="$(req POST "/api/projects/$PID/deliveries" "$BODY2")"
echo "HTTP $(echo "$out" | code_of)"
BID2="$(echo "$out" | body_of | jget id)"
echo "目标批次 id=$BID2"

echo
echo "=== 5. 对照两个批次（冻结 WebVTT，按时间区段比较） ==="
echo "GET $BASE/api/projects/$PID/deliveries/diff?base=$BID1&target=$BID2"
req GET "/api/projects/$PID/deliveries/diff?base=$BID1&target=$BID2" | body_of | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("基准批次", d["base_batch_id"], "→ 目标批次", d["target_batch_id"])
print("语言并集:", d["languages"]["union"],
      " 新增:", d["languages"]["added"], " 移除:", d["languages"]["removed"])
print("有差异的文件数:", d["diff_file_count"])
for f in d["files"]:
    head = "原文" if f["kind"] == "source" else f["lang"]
    if f["status"] == "added":
        t = f["target"]
        print("  [%s] 新增（仅目标批次有）: 目标 v%s %s" % (head, t["version"], t["download_url"]))
    elif f["status"] == "removed":
        b = f["base"]
        print("  [%s] 移除（仅基准批次有）: 基准 v%s %s" % (head, b["version"], b["download_url"]))
    elif f["status"] == "unchanged":
        print("  [%s] 无差异（基准 v%s / 目标 v%s）" % (head, f["base"]["version"], f["target"]["version"]))
    else:
        print("  [%s] %s 个差异区段（基准 v%s / 目标 v%s）" % (
            head, f["diff_count"], f["base"]["version"], f["target"]["version"]))
        for seg in f["segments"]:
            print("      %6d - %6d ms | 基准=%r 目标=%r" % (
                seg["start_ms"], seg["end_ms"], seg["base_text"], seg["target_text"]))
'

echo
echo "=== 6. 同一批次与自身比较 → 空差异（快照完好） ==="
req GET "/api/projects/$PID/deliveries/diff?base=$BID1&target=$BID1" | body_of | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("diff_file_count =", d["diff_file_count"],
      "；各文件:", {("source" if f["kind"]=="source" else f["lang"]): f["status"] for f in d["files"]})'

echo
echo "=== 7. 只读保证：再改当前字幕，旧批次对照结果不变 ==="
BEFORE="$(req GET "/api/projects/$PID/deliveries/diff?base=$BID1&target=$BID2" | body_of)"
req PATCH "/api/projects/$PID/subtitles/$SID2" '{"version":1,"text":"欢迎光临哦"}' >/dev/null
AFTER="$(req GET "/api/projects/$PID/deliveries/diff?base=$BID1&target=$BID2" | body_of)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "对照报告前后完全一致（当前字幕修改不影响冻结快照，查询只读）"
else
  echo "警告：对照报告发生变化，违背只读/冻结语义" >&2; exit 1
fi

echo
echo "=== 8. 拒绝示例 ==="
echo -n "缺少参数 → 400："
req GET "/api/projects/$PID/deliveries/diff?base=$BID1" | body_of \
  | python3 -c 'import json,sys; print(" ", json.load(sys.stdin)["errors"][0])'
echo -n "批次不存在 → 404："
req GET "/api/projects/$PID/deliveries/diff?base=999999&target=$BID2" | body_of \
  | python3 -c 'import json,sys; print(" ", json.load(sys.stdin)["error"])'

# 再造一个项目：其批次不得与本项目批次跨项目对照
out="$(req POST /api/projects "$(python3 -c '
import json; print(json.dumps({"name":"另一个项目","words":[
 {"text":"甲","start_ms":0,"end_ms":500},{"text":"乙","start_ms":600,"end_ms":1000}],"cuts":[]}))')")"
PID2="$(echo "$out" | body_of | jget id)"
req POST "/api/projects/$PID2/layout" '{"sub_version":0}' >/dev/null
req PUT "/api/projects/$PID2/translations/en/subtitles/1" '{"text":"A","cue_version":1}' >/dev/null || true
echo -n "跨项目对照 → 404 明确拒绝："
req GET "/api/projects/$PID2/deliveries/diff?base=$BID1&target=$BID2" | body_of \
  | python3 -c 'import json,sys
try:
    print(" ", json.load(sys.stdin)["error"])
except Exception:
    print("  （另一项目无批次时先提示不存在，符合预期）")'

echo
echo "完成。冻结快照原文/译文仍经既有下载接口取得，约定保持兼容："
echo "  GET $BASE/api/projects/$PID/exports/<version>"
echo "  GET $BASE/api/projects/$PID/translations/<lang>/exports/<version>"
