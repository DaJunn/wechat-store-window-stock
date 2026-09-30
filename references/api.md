# 橱窗库存巡检 · 接口与 DOM 参考

来源：2026-09 实测 `store.weixin.qq.com/talent/channel/window`（带货助手身份，橱窗 124 个商品）。
改 `scripts/window-stock.mjs` 前先读这里。以下为历史实测字段与页面结构，平台更新后需重新核对。

## 目录

- [1. 鉴权：magic 头](#1-鉴权magic-头)
- [2. 橱窗商品列表接口](#2-橱窗商品列表接口)
- [3. 商品短链接口（getQrcode）](#3-商品短链接口getqrcode)
- [4. 字段与单位](#4-字段与单位)
- [5. DOM 兜底路径](#5-dom-兜底路径)
- [6. 写操作：隐藏 / 取消隐藏](#6-写操作隐藏--取消隐藏)
- [7. 环境与依赖](#7-环境与依赖)

## 1. 鉴权：magic 头

`/shop-faas/*` 接口除了 Cookie，还必须带三个头，缺了直接 403：

```
potter-scene: talent
biz_magic:  <64 位 hex>
talent_magic: <64 位 hex>
```

403 响应体：`{"respStatusCode":200004,"msg":"mcn magic invalid"}`

**magic 只能从页面自己发的请求里抄。** 做法：给 `XMLHttpRequest.prototype.open/send/setRequestHeader` 和 `window.fetch` 打钩子，把 URL + 请求头 + 请求体存到 `window.__wsTap`，然后从最新一条命中 `getTalentWindowProducts` 的记录里取 `hs.biz_magic` / `hs.talent_magic` / `hs["potter-scene"]`。

**如果钩子装好之后页面还没发过请求**（比如刚 navigate 完，列表请求发生在装钩子之前），就翻一页逼它重发：优先点「下一页」`<a>`，其次设 `.weui-desktop-pagination__input` 为 2 再点「跳转」。注意刷新整页会清掉钩子，所以不要用 reload 当兜底。

实测同一组 magic 在连续多次调用间可复用；脚本里遇到 403 会重抄一次再重试。

## 2. 橱窗商品列表接口

```
POST https://store.weixin.qq.com/shop-faas/mmeckolwindownode/window/getTalentWindowProducts?token=&lang=zh_CN
Content-Type: application/json
credentials: include（同源 Cookie）
```

请求体：

```json
{"pageSize":100,"offset":0,"productSource":null,"reqSource":1}
```

- `pageSize` 实测 100 可用；页面自己用 20。
- `offset` 按 0/20/40… 递增，`pageSize:100` 时按 100 递增。
- `productSource:null` = 不限来源。

响应（截断）：

```json
{"code":"0","data":{"code":0,"baseResp":{"errcode":"0"},
 "continueFlag":true,"lastBuffer":"CBQSAA==",
 "products":[{
   "productId":"14000807860908",
   "outProductId":"10001211192712",
   "title":"活动 ； UNIMAKE优露美回春饮 1盒*30支   纳豆风味饮",
   "shortTitle":"...","imgUrl":"https://wst.wxapp.tc.qq.com/...",
   "stock":0,"minPrice":977600,"maxPrice":977600,"sales":32,
   "platformName":"花沁堂店铺","status":1,"statusWording":"推广中",
   "commissionInfo":{"commissionRate":240000,"commissionEstimate":234624,"boostRatio":0},
   "itemDecoreate":{"isTop":false,"isHide":false,"belowTitleBlocks":[{"wording":"运费险"}]},
   "previewPage":{"appid":"wxalitecd3434f9a28b4db218f4730961d39d55",
                  "path":"pages/pool/shop/detail?spuId=10001211192712&link=weixinstoresubhs/6000000016856444"},
   "previewPageParam":{"productSource":1,"cpsSpuId":"10001211192712",
                       "cpsLink":"weixinstoresubhs/6000000016856444","ilinkUserId":"..."}
 }]}}
```

- 翻页看 `continueFlag`；不看 `lastBuffer`（脚本用 offset）。
- 去重键用 `productId`。

## 3. 商品短链接口（getQrcode）

橱窗页每行的「详情」点开是一个二维码，扫出来是商品短链。它由这个接口生成：

```
POST https://store.weixin.qq.com/shop-faas/mmeckolbasenode/base/getQrcode?token=&lang=zh_CN
```

请求体（`path` 的 shopId 用 `outProductId`，link 用 `cpsLink`）：

```json
{"bizType":1,
 "path":"/pool/pages/detail/index?shopId=10001211192712&link=weixinstoresubhs/6000000016856444&entrance=8",
 "lifespan":43200,"isNeedAppid":true,"onlyAdmin":false,"needLogin":true}
```

响应：

```json
{"code":0,"success":true,
 "localPath":"/common/pages/login/login?redirect_url=%2Fpool%2Fpages%2Fdetail%2Findex...",
 "qrcodeImg":"<base64 JPEG>"}
```

`qrcodeImg` 是二维码图（base64，无 `data:` 前缀）。落盘成 `.jpg` 后 `zbarimg --quiet --raw x.jpg` 解出：

```
https://mp.weixin.qq.com/a/~~IMkNL7ou8nE~GFvxQ8FFCysH-ThbRMTCwA~~
```

**注意**：

- 解出来的是**小程序短链**，只能在微信里打开，桌面浏览器直接访问会失败。
- `lifespan: 43200`（12 小时）。**每次调用都生成一个新的短码**——同一商品两次跑出来的链接不同，别把它当稳定 ID 入库。
- 二维码指向的是「选品广场 · 商品详情」小程序页 `/pool/pages/detail/index`，带 `entrance=8`。不保证是面向消费者的购买页，接收者可能需要相应登录身份。

## 4. 字段与单位

| 字段 | 含义 | 单位换算 |
|---|---|---|
| `stock` | 库存 | 整数，0 = 无库存 |
| `minPrice` / `maxPrice` | 售价区间 | ÷100 = 元 |
| `commissionRate` | 佣金率 | ÷10000 = 百分比（42000 → 4.2%） |
| `commissionEstimate` | 预估佣金 | ÷100 = 元 |
| `sales` | 已售件数 | 整数 |
| `statusWording` | 售卖状态文案 | 实测「推广中」 |
| `itemDecoreate.isHide` | 是否已在橱窗隐藏 | 布尔 |
| `itemDecoreate.isTop` | 是否置顶 | 布尔 |
| `productId` | 橱窗条目 ID | 页面 DOM `div#commodity-<productId>` |
| `outProductId` | 微信小店 spuId | 等于 `previewPageParam.cpsSpuId` |
| `cpsLink` | 机构链接标识 | 形如 `weixinstoresubhs/6000000016856444` |
| `platformName` | 店铺名 | — |

`isHide=false` + `stock=0` + `statusWording=推广中` = 仍展示但无库存的商品，优先核对补货或隐藏。库存缺失不能按 0 处理。

## 5. DOM 兜底路径

接口不通（magic 抄不到、页面改版）时，退回读 DOM。淘宝式表格在 `<micro-app>` 的 shadowRoot 里：

```js
const sr = document.querySelector("micro-app").shadowRoot;
// 商品行
for (const row of sr.querySelectorAll("tr")) { const wrap = row.querySelector(".commodity-info-wrap"); ... }
```

- 商品名 / 店铺 / 推荐语入口都在 `.commodity-info-wrap`（`.commodity-abstract`）。
- 行的 `id` 形如 `commodity-14000807860908` → `productId`。
- 推荐语入口 `.recommend-wording-entry-wrap[data-product-id]` → `outProductId`。
- 单元格顺序：`0` 勾选框、`1` 商品信息、`2` 讲解回放、`3` 价格、`4` 佣金率、`5` 投流佣金率、`6` **库存**、`7` 操作。
- 分页：`.weui-desktop-pagination__num_current`（当前页）、`.weui-desktop-pagination__num`（页码）、`.weui-desktop-pagination__input` + 「跳转」`<a>`；「上一页/下一页」也是 `<a>`。
- 翻页后页码立刻变、表格数据异步刷新：**必须等首行 `productId` 真的变了**再读，否则拿到上一页的行。
- 页内每页 20 条（页面自己分页），124 条 = 7 页。

DOM 路径拿不到 `cpsLink`，所以拿不到商品短链；只能给 `productId` / `outProductId`。

## 6. 写操作：隐藏 / 取消隐藏

**这一步会真的改生产橱窗。** 实测 2026-09：

- 商品行操作列的四个入口都是 `<div class="link-btn">`（`移除`/`详情` 是 `<a>`）：
  `隐藏 | 置顶 | 移除 | 详情`；**已隐藏时第一项变成 `取消隐藏`**。
- **点 `隐藏` 立即生效，平台没有二次确认弹窗。** 实测点一下之后行内文案就变 `取消隐藏`，接口 `itemDecoreate.isHide` 同步变 `true`。
- 页面里那个「隐藏后平台将减少商品在小店与卡包等平台场景的推荐。隐藏商品后，用户将不能在橱窗看见该商品。但不影响你添加至直播间/短视频/图文带货。」只是 hover 出来的 `.weui-desktop-popover`（容器 `display:none` 的提示层），**不是**确认框，里面也没有按钮。
- `取消隐藏` 同样一点即回滚，接口 `isHide` 变回 `false`。

因此：

- **千万不要为了「看看会发生什么」去点这四个按钮。** 探索 DOM 结构时只读 `innerText` / `outerHTML`，不要 `.click()`。
- 脚本的写路径刻意走 **UI 点击**而不是 replay 写接口：写接口没有实测请求体样本，猜 body 风险过高；点按钮的语义就是用户亲手点。
- 成功判定顺序：① 行内操作文案翻转（隐藏→出现「取消隐藏」；取消隐藏→第一项变「隐藏」）② 重新拉列表接口，以 `itemDecoreate.isHide` 复核。第 ② 步是权威判据，UI 只用来确认「点到了、有反应」。
- 置顶 / 移除**没有**实现在脚本里，也不该顺手加。

## 7. 环境与依赖

- daemon：`http://127.0.0.1:10086`，通过 `/command` POST `{action, args, session}`。脚本用 node 原生 `http` 直连，**不要用 curl**（本机 `HTTP_PROXY` 可能劫持 localhost）。
- 浏览器会话名默认 `wx-window-stock`；每个 session 对应一个独立标签组。
- 二维码解码依赖系统 `zbarimg`（`brew install zbar`）。没装时脚本仍能出库存清单，短链列留空。
- 页面内 `evaluate` 只放同步动作或单次 `fetch`，等待一律放 Node 端 `sleep`——后台 tab 的定时器被 Chrome 限流。
