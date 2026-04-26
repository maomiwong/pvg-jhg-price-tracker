# 上海 → 西双版纳 机票价格监测

每天 09:00 / 15:00 / 21:00 (Asia/Shanghai) 由远程 Claude agent 抓取一次价格，追加到 `data/prices.jsonl` 并重新生成 `index.html` 走势图。

## 监测范围

- **出发地**：上海浦东 PVG + 上海虹桥 SHA
- **目的地**：西双版纳嘎洒 JHG
- **日期范围**：未来 30 天，单程经济舱最低价

## 文件结构

```
data/prices.jsonl   每行一条价格快照（JSON）
data/runs.jsonl     每次运行的元信息（成功/失败/数据源）
index.html          走势图（GitHub Pages）
```

## 数据 schema

`data/prices.jsonl` 每行：

```json
{
  "snapshot_at": "2026-04-27T09:00:00+08:00",
  "depart_date": "2026-05-15",
  "origin": "PVG",
  "destination": "JHG",
  "min_price_cny": 980,
  "carrier": "MU5915",
  "source": "ctrip"
}
```

## 在线查看

挂在 https://pvg-jhg.wwei.ai （首次部署后生效）。
