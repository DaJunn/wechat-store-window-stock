---
name: wechat-store-window-stock
description: 巡检微信小店带货助手橱窗的零库存或低库存商品，输出商品链接与补货清单。默认只读；用户明确指定范围时，可预演并执行隐藏或取消隐藏。
---

# 橱窗库存巡检

读取橱窗商品库存，找出需要补货或处理展示状态的商品。适用于「哪些商品没货」「橱窗低库存」「补货清单」；平台清退预警使用 `wechat-window-qingtui-scan`（如已安装）。

## 输入与依赖

- 明确目标带货助手账号与库存阈值；默认查库存 0，低库存阈值按用户需求设置。
- Chrome 已登录 `store.weixin.qq.com` 的带货助手账号；不代登录。
- `~/.kimi-webbridge/bin/kimi-webbridge status` 返回 `running:true`、`extension_connected:true`。
- Node.js 18+，无需第三方包。商品短链解码另需 `zbarimg`（可用 `brew install zbar` 安装）；缺少时仍可查库存，但短链为空。

## 只读流程

以下命令在本 skill 目录运行：

```bash
node scripts/window-stock.mjs status
node scripts/window-stock.mjs scan --max-stock 0
# 查库存不超过 20 的商品；20 仅为示例阈值
node scripts/window-stock.mjs scan --max-stock 20
# 不获取短链，指定输出文件基础路径（不带扩展名）
node scripts/window-stock.mjs scan --max-stock 0 --no-link --out /tmp/window-stock-check
```

1. 先确认账号、页面及无意外筛选，运行 `status`，将返回总数与页面「商品管理(N)」核对。
2. 用 `list` 仅打印命中项，或用 `scan` 导出 MD、CSV、JSON；`status/list/scan` 不改变商品展示、价格或库存。
3. 检查 JSON 明细：库存缺失或非数字列为「未知」，不能报为 0；脚本当前按 `stock <= 阈值` 筛选，空值可能混入命中。价格、佣金缺失也不能以格式化后的 0 当真实值。
4. 商品 ID 去重后核对覆盖数；总数不一致、读取失败或达到分页上限时只报已扫描范围，不宣称全量。当前脚本最多请求 50 页、每页 100 条，部分业务错误仍可能表现为空列表。
5. 优先指出「零库存、推广中、未隐藏」和有历史销量的缺货商品，给补货或展示处理建议。

`scan` 默认输出到 `~/Desktop/橱窗库存巡检_YYYYMMDD.{md,csv,json}`；重复运行按已有 MD 文件加序号。使用 `--out` 前确保目录存在、三个同名文件均不存在，否则会覆盖且不会等待确认。

## 隐藏／取消隐藏（按需）

这是生产橱窗写操作，不属于库存巡检的默认动作。已有明确授权且范围清楚时按授权执行；否则先交付预演清单，等待用户确认。

```bash
# 预演：默认零库存，最多取 50 个
node scripts/window-stock.mjs hide --max-stock 0 --limit 50
# 已核对并获授权的商品 ID；示例 ID 需换成真实目标
node scripts/window-stock.mjs hide --ids 14000807860908 --limit 50 --apply
node scripts/window-stock.mjs unhide --ids 14000807860908 --limit 50 --apply
```

- 每次先 dry-run，再加 `--apply`。**传 `--ids` 会按 ID 取商品，不再按库存或当前隐藏状态过滤**，必须逐项核对 ID、库存、隐藏状态和授权范围。
- 每批最多 50 个是本技能的执行约束；脚本的 `--limit` 默认 50，但未硬性封顶，不得据此自动扩大批次。超出范围另行列清单。
- `unhide` 必须传 `--ids` 或 `--all`；默认使用明确 ID。只有用户明确授权恢复全部隐藏商品时才可用 `--all`，且仍须核对分批范围。
- 页面「隐藏／取消隐藏」点击即生效，没有二次弹窗。探索页面时只读取结构，不试点隐藏、置顶或移除。
- 执行后重新读取接口，以 `itemDecoreate.isHide` 核对每个 ID，分别报告成功、失败、未执行；状态不明先复核，不能盲目重试。
- 操作记录默认在桌面 `橱窗隐藏记录_YYYYMMDD_HHMMSS.json` 或 `橱窗取消隐藏记录_YYYYMMDD_HHMMSS.json`。回滚按记录 ID 单独预演 `unhide`，不推断其他商品状态。

隐藏影响橱窗展示及平台相应推荐场景；按页面提示，不影响已经添加至直播间、短视频或图文的挂车。具体以当前平台提示为准。

## 输出

报告账号／页面、扫描时间、阈值、覆盖数／后台总数、命中数，以及库存未知项。清单包括商品、店铺、价格、佣金率、预估佣金、库存、销量、售卖与隐藏状态、商品 ID、SPU、机构链接和商品短链。

说明本次是只读巡检、写操作预演，还是已执行并复核；提供实际存在的文件链接。预估商品佣金不等于公司侧毛利润。

短链由详情二维码解码，申请有效期约 12 小时，需在微信内打开，不承诺是消费者购买页；实际为选品广场详情，可能要求相应登录身份。`cpsLink` 是机构标识，不能当作公开商品 URL。

## 故障与技术参考

- daemon 未连接或登录过期：先恢复连接／让用户登录；不绕过验证。
- 找不到 `micro-app`：确认是橱窗页面且加载完成，重试一次；仍失败保留断点。
- `mcn magic invalid`：脚本会尝试重新读取页面请求头；仍失败检查会话与页面，不重复刷接口。
- 找不到分页控件：单页橱窗也可能无法触发签名捕获，不能据此判库存为零；改用可见页面核对并声明范围。
- 短链为空：查 `zbarimg` 或二维码错误；库存结果与链接获取状态分别报告。

修改脚本或调查接口时再读 [references/api.md](references/api.md)。仅使用当前登录会话的真实请求，不导出 Cookie 或 magic；不置顶、移除、改价、改库存或改佣金。
