# 橱窗库存巡检

找出微信小店带货助手橱窗的零库存和低库存商品，输出含商品链接、售价、佣金和销量的补货清单。默认只读；隐藏或取消隐藏需明确授权并先预演。

## 安装与使用

```bash
git clone https://github.com/DaJunn/wechat-store-window-stock.git ~/.agents/skills/wechat-store-window-stock
cd ~/.agents/skills/wechat-store-window-stock
node scripts/window-stock.mjs status
node scripts/window-stock.mjs scan --max-stock 0
```

也可对 AI 说：「检查橱窗零库存，给我补货清单。」默认导出 MD、CSV、JSON 到桌面，可用 `--out` 指定文件基础路径。

## 需要什么

Node.js 18+、已连接扩展的 kimi-webbridge，以及已登录带货助手的 Chrome。短链解码另需 `zbarimg`；缺少时可用 `--no-link` 只查库存。

## 输出与边界

库存是扫描时快照，需与后台商品总数核对；未知库存不当作零库存。短链有效期约 12 小时，指向微信内选品详情，不保证可供消费者购买。

`hide/unhide` 是可选写操作，默认预演，只有 `--apply` 才执行；传 ID 时须另行核对库存和展示状态。授权、复核及输出覆盖规则见 [SKILL.md](SKILL.md)，接口说明见 [references/api.md](references/api.md)。
