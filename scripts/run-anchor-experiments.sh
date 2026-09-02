#!/bin/bash
# Sequential anchor experiment runner (thresholds 800/2000 untouched, 3 runs each).
# Skips runs whose workspace + completed transcript already exist, so a flaky
# parent-shell kill never wastes a finished run.
cd /Users/1234/dev/Proma || exit 1
mkdir -p logs
BEAT() { echo "[hb $(date '+%F %T')]" >> "logs/$1"; }
run() {
  local task=$1 thr=$2 r=$3 tag=$4
  local seed p
  case "$task" in
    a) seed=/tmp/anchor-fixtures/task-a; p='完成任务 README.md 中描述的 refactor: 提取共享模块 src/calc.js(实现 calcSegmentTotal/normalizeDate/addDays), 让 src/invoice.js 改用它, 删除重复逻辑(src/segments.js/src/dates.js 不再导出被引用逻辑), 并确保 tests/ 下所有测试通过。完成后用 node 运行 tests 目录下所有测试文件验证, 并说明修改了哪些文件。' ;;
    b) seed=/tmp/anchor-fixtures/task-b; p='完成任务 README.md 中描述的 parser 升级: 按 spec/format-v2.md 把 src/parser/parser.js 升级为 v2 解析器(支持 TS=epoch_ms、LVL=INFO/WARN/ERROR/DEBUG、SVC、MSG 解码转义、KV=k1=v1;k2=v2 且数值转数字、错误行报行号、忽略空行和 # 注释行), 更新 src/parser/fields.js, 并确保 tests/check.js 通过。完成后用 node 运行 tests/check.js 验证并说明修改了哪些文件。' ;;
  esac
  local ws="dist/anchor-runs/deepseek-v4-pro/$thr/run-$r-workspace"
  local tr="dist/anchor-runs/deepseek-v4-pro/$thr/run-$r.jsonl"
  if [ -d "$ws" ] && [ -s "$tr" ] && tail -n 2 "$tr" | grep -q '"type":"result"'; then
    echo "[skip] task=$task thr=$thr run=$r (already done)" >> "logs/$tag.log"
    return
  fi
  echo "===[$tag] START task=$task thr=$thr run=$r $(date '+%F %T')===" >> "logs/$tag.log"
  timeout 900 node dist/headless-check.cjs --model deepseek-v4-pro --threshold "$thr" --run "$r" --seed "$seed" --keep 1 --prompt "$p" >> "logs/$tag.log" 2>&1
  local ec=$?
  echo "===[$tag] END task=$task thr=$thr run=$r exit=$ec $(date '+%F %T')===" >> "logs/$tag.log"
  BEAT "$tag"
  return $ec
}
# Wrapper so that even if run() exits non-zero the batch continues.
for spec in "a 2000 0 batch2000" "a 2000 1 batch2000" "a 2000 2 batch2000"             "b 800 0 batch-b800" "b 800 1 batch-b800" "b 800 2 batch-b800"             "b 2000 0 batch-b2000" "b 2000 1 batch-b2000" "b 2000 2 batch-b2000"; do
  set -- $spec
  run "$1" "$2" "$3" "$4" || true
  BEAT "$4"
done
echo "ALL DONE $(date '+%F %T')" >> logs/batch2000.log
echo "ALL DONE $(date '+%F %T')" >> logs/batch-b800.log
echo "ALL DONE $(date '+%F %T')" >> logs/batch-b2000.log
