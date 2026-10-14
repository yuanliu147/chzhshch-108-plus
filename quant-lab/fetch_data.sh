#!/usr/bin/env bash
# 拉取 600519.SH 近10年前复权日K，落盘 data/600519.SH.daily.json
# 注意：CLI 限制起止跨度最多 10 年（含端点），故起点取 2016-10-15（首个交易日仍为 2016-10-17）
set -euo pipefail
cd "$(dirname "$0")"
START_MS=$(node -e "console.log(new Date('2016-10-15T00:00:00+08:00').getTime())")
END_MS=$(node -e "console.log(Date.now())")
hithink-finance market history \
  --thscode 600519.SH \
  --start-ms "$START_MS" \
  --end-ms "$END_MS" \
  --adjust forward \
  --output data/600519.SH.daily.json \
  --format json
node -e "
const env = require('./data/600519.SH.daily.json');
if (!env.ok) { console.error('hithink-finance 返回失败:', env.error); process.exit(1); }
console.log('bars:', env.data.item.length, '首条:', new Date(env.data.item[0].date_ms).toISOString().slice(0,10), '末条:', new Date(env.data.item.at(-1).date_ms).toISOString().slice(0,10));
"
