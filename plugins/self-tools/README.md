# 自己写的工具（self-tools）

机器人（喵喵）的大脑发现自己缺某个能力时，会提一个工具需求；codex-bridge 的「工具工坊」让 Codex 按下面的约定写一个工具文件，自测通过后放进 `tools/`，热重载自动加载，大脑下一轮就能用。

## 一个文件 = 一个工具

`tools/<id>.js`，ES Module：

```js
// tools/weather_now.js —— 一句话说明这个工具做什么、为什么需要它
import { safeFetch } from '../../../src/safe-fetch.js';

export default {
  id: 'weather_now',                 // 小写字母/数字/下划线，3-38 位，和文件名一致
  name: '查天气',                     // 中文显示名
  description: '查某个城市现在的天气。有人问"xx今天天气怎么样""冷不冷"时用。city 填城市名。',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名，如「杭州」' } },
    required: ['city']
  },
  async execute(ctx, args) {
    // 返回 { content: 字符串 } 或 { content: [{type:'text',text}, {type:'image_url',image_url:{url:'data:...'}}] }
    // 出错返回 { content: '原因', isError: true }，不要抛异常
    const r = await safeFetch(`https://wttr.in/${encodeURIComponent(args.city)}?format=3`, { timeoutMs: 15000 });
    // safeFetch 返回 { url, statusCode, truncated, body }；二进制用 safeFetchBinary(url, maxBytes, { timeoutMs }) → { buffer, contentType }
    if (r.statusCode !== 200) return { content: `天气服务返回 ${r.statusCode}`, isError: true };
    return { content: String(r.body || '').slice(0, 500) };
  }
};

// 可选但强烈建议：自测。工坊会在独立子进程里跑它，抛错 = 不上线。
export async function test() {
  const r = await (await import('./weather_now.js')).default.execute({}, { city: '杭州' });
  if (!r || r.isError) throw new Error(`自测失败：${r?.content}`);
}
```

## ctx 里有什么

- `ctx.chatKey`：`group:群号` 或 `private:QQ号`（工具只作用于当前会话）
- `ctx.store`：聊天存档，`ctx.store.recent(chatKey, { limit })`、`ctx.store.findByMid(chatKey, mid)`
- `ctx.session`：本次会话（`ctx.session.trigger` 是触发这次的消息数组，`senderId` 是发消息的人）
- `ctx.memory`：群友印象记忆
- 发 QQ 消息不要在工具里自己发，把结果返回给大脑，由它用 send_message 说

## 规矩

- 联网用 `src/safe-fetch.js` 的 `safeFetch` / `safeFetchBinary`（带超时和地址校验），不要用裸 fetch。
- 不要读写 `data/config.json`、不要输出任何密钥 / token / 密码。
- 不要删除或改动 `tools/` 以外的文件；需要存数据就写到 `data/self-tools/<id>/`。
- 执行要快（30 秒内），返回内容要短（大脑要读）。
- 不要和现有工具重复：先看 `src/tools.js` 和各插件已经注册了哪些工具。
- 文件开头写一行注释：这个工具做什么、谁 / 为什么提的需求。
