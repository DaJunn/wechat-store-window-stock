# wechat-store-window-stock

**橱窗库存巡检** —— 扫全部橱窗商品的库存，挑出 0 库存/低库存，出补货清单

让 AI agent（DSH / Codex / Claude Code 等）使用。

## 解决什么问题

之前橱窗里哪些品没货了，得一个个点开看，经常是观众反馈买不到才发现。

现在一次扫完全部橱窗商品，挑出 0 库存和低库存，输出含商品短链、机构链接、售价、佣金率、销量的补货清单（MD + CSV + JSON）。

## 前置依赖

1. **kimi-webbridge daemon** 在跑：
   ```bash
   ~/.kimi-webbridge/bin/kimi-webbridge status   # 要 running:true + extension_connected:true
   ```
   没装：`curl -fsSL https://cdn.kimi.com/webbridge/install.sh | bash`
2. **Chrome 已登录** `store.weixin.qq.com`（微信小店带货助手）。本系列只复用你自己已打开的标签页，**不代登录**。

## 安装

```bash
git clone https://github.com/DaJunn/wechat-store-window-stock.git \
  ~/.agents/skills/wechat-store-window-stock
```

## 触发方式

对 agent 说：「橱窗 0 库存」「哪些商品没库存了」「补货清单」「橱窗低库存」「检查橱窗能不能卖」。


## 说明

- **全程只读**，不做隐藏 / 移除 / 改价 / 改库存

## 相关

- 完整技能合集见飞书文档《AI减负视频号运营技能合集》
- 更多 skill：https://github.com/DaJunn
