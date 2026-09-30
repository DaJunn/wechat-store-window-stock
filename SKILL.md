---
name: wechat-store-window-stock
description: 微信小店带货助手「橱窗」库存巡检（视频号带货者橱窗场景）。扫 store.weixin.qq.com/talent/channel/window 全部橱窗商品的库存，挑出 0 库存 / 低库存商品，输出含商品短链、机构链接、售价、佣金率、销量的清单（MD + CSV + JSON）。当用户说「橱窗0库存」「找0库存的链接」「哪些商品没库存了」「橱窗库存巡检」「检查橱窗能不能卖」「快断货的品有哪些」「补货清单」「橱窗低库存」时使用。依赖已登录 Chrome + kimi-webbridge，全程只读，不做隐藏/移除/改价/改库存。
---

# 微信小店橱窗库存巡检 Skill

把「微信小店带货助手 → 橱窗 → 商品管理」里的商品全量过一遍库存，挑出 **0 库存 / 低库存**的品，并给每个品配一条**微信里能直接打开的商品短链**；确认后再一键把 0 库存商品**隐藏**（可随时取消隐藏）。

**为什么重要**：0 库存商品如果还挂在橱窗且状态是「推广中」，带货者点进去买不了，等于白送流量、还伤害转化和粉丝信任。

## 先决条件

1. **kimi-webbridge daemon 在跑**且扩展已连接：
   ```bash
   ~/.kimi-webbridge/bin/kimi-webbridge status   # 需要 running:true / extension_connected:true
   ```
2. **Chrome 已登录** `store.weixin.qq.com`（带货助手身份）。Skill 不代登录。
3. **Node.js 18+**（脚本只用原生 `http`/`fs`，无第三方依赖）。
4. 想拿到商品短链需要 `zbarimg`（`brew install zbar`）。没装也能跑，只是短链列为空。

## 命令

脚本：`scripts/window-stock.mjs`（路径按本 skill 目录拼）。

| 模式 | 作用 | 会写数据吗 |
|---|---|---|
| `status` | 打印页面 URL / 商品总数 / 命中数，不落盘 | 否 |
| `list` | 终端打印命中清单（含短链） | 否 |
| `scan` | 落盘 `<out>.md` / `.csv` / `.json` | 否 |
| `hide` | 把库存 ≤ 阈值的商品隐藏（默认 dry-run） | **是，且必须 `--apply`** |
| `unhide` | 取消隐藏（默认 dry-run，必须限定范围） | **是，且必须 `--apply`** |

```bash
S=~/.agents/skills/wechat-store-window-stock/scripts/window-stock.mjs
node $S status                       # 先确认页面通、总数对
node $S list --max-stock 0            # 0 库存，终端看
node $S scan --max-stock 0            # 0 库存，落盘到 ~/Desktop/橱窗库存巡检_YYYYMMDD.{md,csv,json}
node $S scan --max-stock 20           # 低库存（≤20）一起捞，做补货预警
node $S scan --max-stock 0 --no-link  # 不要短链，只求快
node $S scan --max-stock 0 --out /tmp/my-scan

node $S hide                          # 预演：列出会被隐藏的 0 库存商品（不写）
node $S hide --apply                  # 真的隐藏（会落操作记录）
node $S hide --max-stock 20 --limit 5 --apply
node $S unhide --ids 14000807860908 --apply   # 放回来（必须 --ids 或 --all）
node $S unhide --all --apply                  # 放回所有已隐藏的（慎用）
```

`--max-stock` 默认 `0`。**默认先跑 `status`**，确认 `total` 与后台「商品管理(N)」的 N 一致，再去落盘。

`scan` 默认写到 `~/Desktop/橱窗库存巡检_YYYYMMDD.{md,csv,json}`；同一天重复跑会自动加 `_2`/`_3` 后缀，不覆盖上一次。显式传 `--out` 时若文件已存在会被覆盖，脚本会先提示。

## 写操作安全规则（hide / unhide）

隐藏是**可逆**的（`unhide` 放回来），但它是**真的改动生产橱窗**，按下面来：

1. **先 dry-run，再 `--apply`**。`hide` 不加 `--apply` 只打印会被隐藏的清单，什么都不改。
2. **默认阈值为 0，只动 0 库存**。用 `--max-stock` 放宽到低库存前，先跟用户确认。
3. **先给用户看清单再动手**。除非用户已经明确说「把这几个隐藏掉」，否则 dry-run 出清单后停下来等他点头。
4. **一次最多 50 个**（`--limit`）。超了会截断并提示。
5. **只隐藏「未隐藏」的**，已经在隐藏状态的不重复动。
6. **执行完必须用接口复核**，不看 UI 那一瞬间：脚本会重新拉列表，以 `itemDecoreate.isHide` 为准报「N/M 成功」，失败的逐条列出。
7. **落操作记录**：每次 `--apply` 都会写 `~/Desktop/橱窗隐藏记录_YYYYMMDD_HHMMSS.json`，含请求清单、执行结果、点击日志。要回滚就照这个文件的 ID 跑 `unhide --ids`。
8. **`unhide` 必须限定范围**：`--ids <商品ID,...>` 或 `--all`，不给就直接拒绝执行 —— 防止手滑把所有已隐藏商品放出来。
9. 隐藏**不影响**直播间/短视频/图文挂车，只是从橱窗（和小店、卡包等推荐位）拿掉。

## 标准工作流

1. `status` → 确认页面打开、商品总数和后台显示一致。
2. `scan --max-stock 0` → 出 0 库存清单。
3. 需要预警再跑 `scan --max-stock 20` → 把「快断货」的品一起给出来。
4. 按下面口径汇报，并把文件路径给用户。
5. 用户确认要清理时 → `hide`（先 dry-run）→ 给他看清单 → `hide --apply` → 用复核结果和操作记录回话。

## 汇报口径

给用户的结论要包含：

- **命中数 / 橱窗总数**，以及扫描时间（库存是快照，会变）。
- 每个命中品的：商品名、店铺、售价、佣金率、预估佣金、库存、销量、售卖状态、是否已隐藏。
- 每个品的**商品短链**（微信内打开）+ 机构链接 `cpsLink` + 商品ID/spuId。
- 业务判断：0 库存且「推广中/未隐藏」= 立刻处理（催补货 or 先隐藏）；销量高又 0 库存 = 优先处理。
- 明确说明：本次**只读**，没有隐藏/移除任何商品。

不要只丢一句「有 5 个 0 库存」。要给出「谁、卖什么、多少钱、佣金多少、卖过多少、现在能不能卖」。

## 失败排查

| 症状 | 原因 | 处理 |
|---|---|---|
| `连不上 kimi-webbridge daemon` | daemon 没启动/扩展掉线 | `~/.kimi-webbridge/bin/kimi-webbridge status`，按 kimi-webbridge skill 处理 |
| `页面还没加载出 micro-app` | 页面没加载完 / tab 不对 | 等 5 秒重跑；确认 tab 是 `/talent/channel/window` |
| `list 接口返回 403` / `mcn magic invalid` | `biz_magic`/`talent_magic` 过期（或钩子没抄到） | 脚本会自动重抄；仍失败就手动在页面上翻一页再重跑 |
| `页面没找到分页控件` | 橱窗商品不足 1 页 / 页面结构变了 | 先在页面上手动翻一页，再重跑 |
| `命中 0 个` 但后台明明有 0 库存 | 页面筛选/搜索框在生效，或 magic 抓的是旧列表 | 清掉页面上的搜索词和筛选，重跑 |
| 短链列为空 | 没装 `zbarimg`，或二维码接口失败 | `brew install zbar`；只想验证库存就加 `--no-link` |
| `daemon 调用超时` | tab 在后台被限流 / 页面弹窗卡住 | 保证只开一个橱窗 tab，关掉页面上的弹窗后重跑 |
| 同一天跑第二次，桌面文件名变成 `_2` | 这是有意的防覆盖 | 要固定文件名就传 `--out` |
| `hide` 报「N/M 成功」，有漏的 | 该行不在当前页 / 列表异步刷新 | 看操作记录里的 `clickLog`，对失败的 ID 单独跑 `hide --ids <id> --apply` |
| `goto_page_failed` | 翻页后表格没刷新出来 | 重跑；一直失败就手动在页面上翻一次 |

## 技术备忘（改脚本前必读）

更细的接口/DOM 说明见 `references/api.md`，改脚本前必读。核心 5 条：

1. **shop-faas 接口要抄页面自己的 magic 头**：`potter-scene: talent` + `biz_magic` + `talent_magic`，缺了直接 403 `mcn magic invalid`。脚本用给 XHR/fetch 打钩子的方式抄，抄不到就翻一页逼页面重发请求。
2. **页面在 `<micro-app>` 的 shadowRoot 里**，`document.querySelector` 取不到商品行，必须 `document.querySelector("micro-app").shadowRoot`。
3. **页面内 evaluate 只做同步动作或单次 fetch**，所有等待放 Node 端。后台 tab 的定时器被 Chrome 限流。
4. **商品短链不是拼的**：调 `getQrcode` 拿二维码图，`zbarimg` 解出 `https://mp.weixin.qq.com/a/~~...~~`。每次生成的都是新码（`lifespan: 43200`，约 12 小时有效），过期重跑即可，不要当稳定 ID 存库。
5. **单位**：价格 `minPrice/100`（分→元）；佣金率 `commissionRate/10000`（万分比→百分比）；库存 `stock` 是数字。
6. **「隐藏 / 取消隐藏 / 置顶 / 移除」是 `.link-btn` 的 div，点下去立即生效，平台没有二次确认弹窗。** 所以在页面上做任何探索时，绝对不要点这四个按钮中的任何一个 —— 一点就是生产变更。商品行的操作列固定顺序：`隐藏|置顶|移除|详情`（已隐藏时第一项变 `取消隐藏`）。
7. **写操作走 UI 点击，不走接口**。原因见上一条的对手面：接口请求体没有实测样本，猜一个写接口的 body 风险太高；点按钮等于用户亲手点，语义明确。成功后靠**行内操作文案翻转**判定（隐藏成功 → 出现「取消隐藏」；取消隐藏成功 → 第一项变回「隐藏」），最后再用接口 `isHide` 复核一次。

## 不做什么

- 不代登录、不动账号安全设置。
- `status` / `list` / `scan` **只读**：不隐藏、不置顶、不移除商品，不改价格/库存/佣金/推荐语。
- `hide` / `unhide` 是唯一的写操作，且默认 dry-run、必须 `--apply`；不碰置顶和移除。
- 不 OCR 截图猜数据，不读 Cookie。
- 不把「机构链接 cpsLink」当公开链接发给 C 端用户 —— 那是机构侧标识，发给用户用商品短链。
