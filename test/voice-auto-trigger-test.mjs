import assert from 'node:assert/strict';
import fs from 'node:fs';
import { autoVoiceTriggerMatches, findAutoVoiceMeme, sendAutoVoiceMeme } from '../plugins/codex-bridge/index.js';
import { getConfig } from '../src/config.js';
// 主人 QQ：插件按「主人识别」插件的设置认主人，测试里临时塞一个占位号进去
const OWNER = '10000';
getConfig().skills = { ...(getConfig().skills || {}), 'owner-identity': { ...(getConfig().skills?.['owner-identity'] || {}), ids: OWNER } };

const voiceDir = 'data/knowledge-base/voices';
const lib = JSON.parse(fs.readFileSync(`${voiceDir}/index.json`, 'utf8'));
const group = `group:voice-auto-test-${Date.now()}`;
const otherGroup = `${group}-other`;
const calls = [];
const fakeOrch = {
  sender: {
    async sendMedia(...args) { calls.push(args); }
  }
};
const mkEntry = (id, text, extra = {}) => ({ id, senderId: 'test-member', text, ...extra });

for (const [name, terms] of [
  ['雪豹闭嘴', ['雪豹闭嘴', '芝士雪豹', '雪豹闭嘴雪豹', '雪豹']],
  ['老吴', ['老吴老吴', '老吴老吴老吴', '老吴猫', '内个内个']],
  ['砸瓦鲁多', ['砸瓦鲁多', 'Za Warudo', 'DIO砸瓦鲁多']],
  ['妮蔻妮蔻妮', ['妮蔻妮蔻妮', '妮可妮可妮', '矢泽妮可妮可妮', 'Niconiconi']],
  ['天上天下唯我独尊', ['天上天下唯我独尊', '五条悟天上天下唯我独尊']]
]) {
  assert.deepEqual(lib[name].autoTriggerTerms, terms, `${name} 自动触发词配置`);
  assert.ok(fs.existsSync(`${voiceDir}/${lib[name].file}`), `${name} 音频文件存在`);
  for (const term of terms) {
    assert.equal(findAutoVoiceMeme(group, mkEntry(100 + terms.indexOf(term), term))?.name, name, `${name} 触发词「${term}」`);
  }
}

assert.equal(findAutoVoiceMeme(group, mkEntry(1, '五条悟说：天上天下，唯我独尊！'))?.name, '天上天下唯我独尊');
assert.equal(autoVoiceTriggerMatches(group, mkEntry(2, '只提到五条悟')), false, '五条悟旧规则不因裸提名字触发');
assert.equal(autoVoiceTriggerMatches(group, mkEntry(12, '老吴')), false, '单提老吴不误触发');
assert.equal(findAutoVoiceMeme(group, mkEntry(3, 'Za Warudo!'))?.name, '砸瓦鲁多', '拉丁字母忽略大小写');
assert.equal(findAutoVoiceMeme('private:123', mkEntry(4, '芝士雪豹')), null, '私聊不触发');
assert.equal(findAutoVoiceMeme(group, mkEntry(5, '芝士雪豹', { self: true })), null, '机器人自己的消息不触发');

const multi = findAutoVoiceMeme(group, mkEntry(6, '芝士雪豹，然后 Niconiconi'));
assert.equal(multi?.name, '妮蔻妮蔻妮', '一条消息命中多个语音时选最长触发词对应的一条');

// 模拟一条新的群聊入站事件；sendMedia 是内存里的假发送器，不连接 QQ。
const simulated = sendAutoVoiceMeme(fakeOrch, group, mkEntry(7, '刚刚有人喊了内个内个'));
assert.equal(calls.length, 1, '模拟事件应触发一次语音发送');
assert.equal(await simulated, true);
assert.equal(calls[0][0], group);
assert.equal(calls[0][1][0].type, 'record');
assert.equal(calls[0][2].label, '[语音梗:老吴]');

assert.equal(await sendAutoVoiceMeme(fakeOrch, group, mkEntry(8, '老吴老吴')), false, '同语音同群 20 分钟冷却');
assert.equal(await sendAutoVoiceMeme(fakeOrch, group, mkEntry(9, 'DIO 砸瓦鲁多')), false, '同群 3 分钟内只自动发一条（防刷屏），换个语音也不发');
assert.equal(await sendAutoVoiceMeme(fakeOrch, otherGroup, mkEntry(10, '内个内个')), true, '不同群有独立冷却');
// 主人打出来的不受冷却和群内间隔限制
assert.equal(await sendAutoVoiceMeme(fakeOrch, group, mkEntry(11, '芝士雪豹 + Niconiconi', { senderId: OWNER })), true, '主人触发不受限制');
assert.equal(calls[2][2].label, '[语音梗:妮蔻妮蔻妮]', '一条消息含多个触发词时只发送一个匹配项');
assert.equal(calls.length, 3);

console.log('voice-auto-trigger: PASS (simulated with fake sender; no QQ messages sent)');
