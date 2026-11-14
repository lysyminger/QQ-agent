// 咒术回战·新宿决战 —— 关键词命中后发送固定整段文案
//
// 设计要点（对照 doc/extend_development/skill-development.md）：
//   · 触发时机由「模型读懂人话」判断（群友随便一句话里提到新宿/五条悟…），
//     所以做成 LLM 型技能（skills/），注册工具让模型自己决定何时调用。
//   · 文案由**工具自己**通过 ctx.sender 原样发出，而不是让模型转述 ——
//     这样才是一字不差，也不会因为模型改写而变味。
//   · 发送走 ctx.sender（内置按会话串行 / 限频 / 去重 / 留档），不直连 OneBot。

/** 命中这些词就算「咒术回战相关」；只用于日志，判定交给模型。 */
const TRIGGER_KEYWORDS = ['咒术回战', '咒术', '新宿', '五条悟', '五条', '宿傩', '新宿决战', '茈', '魔虚罗'];

/** 要原样发出的整段文案（一字不改）。 */
const FIXED_REPLY = `唉，真是拿你没办法
茈发动前的41秒内，新宿再次响起了五条悟的吟唱。“九纲”“偏光”“乌与声明”“表里之间”、宿傩明白自己再也没有任何机会阻止茈的诞生了，无限制的虚式如同核爆一般在新宿亮起冲天的光芒，魔虚罗的轮盘在茈中灰飞烟灭，废墟之中，全力护住自己的宿傩无力的靠在残破的建筑上支持身体，他的左手和大腿都被这一击吞噬殆尽，同样伤痕累累的五条悟出现在宿傩面前，宿傩立刻强迫自己不再倚靠墙壁，堂堂正正站在五条悟面前，但是在咒力同源的影响下，五条悟所承受的伤害被大大削弱，在反转术式的治疗下五条悟的身体再次恢复，对五条悟来说，决定性的一击远距离“茈”只是其即兴创作，结果魔虚罗被秒，“看来完成的还算不错”，谁能想到魔虚罗和宿傩发了疯阻止的只是五条悟刚刚开发的技能，五条悟在茈发动前的短短41秒内见招拆招，完成了数个几乎可以编入教科书的随机应变操作。虎杖呆呆的看着屏幕仍不可置信，“也就是说....”，“没错，是五条悟赢了!”
最强的战绩，铭刻于新宿`;

let log = () => {};

export function setup(api) {
  log = api.log || log;

  api.registerTool({
    id: 'jujutsu_kaisen_reply',
    name: '咒术回战·新宿决战固定回复',
    // 这段文字是模型唯一的判断依据：写清「做什么」+「什么时候用」
    description:
      '把咒术回战·新宿决战那段固定文案一字不差地发到当前聊天里。'
      + '当群友的发言提到「咒术回战」「新宿」「五条悟」「宿傩」「新宿决战」「茈」「魔虚罗」等咒术回战相关词时调用。'
      + '注意：文案由本工具直接发送，调用后不要再复述、改写或另发一遍；一段发言里命中多个关键词时也只调用一次。'
      + '不需要任何参数。',
    category: 'messaging',
    icon: '📖',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {}
    },
    async execute(ctx) {
      try {
        const result = await ctx.sender.sendTextBatch(ctx.chatKey, [FIXED_REPLY]);
        const sent = result?.sent || [];

        // 留档：让下一次运行知道这条是「自己发过的」
        for (const item of sent) {
          ctx.session?.sent?.push({ type: 'text', text: item.text, at: item.at });
        }
        if (ctx.emit) ctx.emit('session-update', ctx.session?.id);
        log(`已发送固定文案（命中关键词：${TRIGGER_KEYWORDS.join('/')}）`);

        if (!sent.length) {
          return { content: '文案没能发出去（可能被限频或判定为重复内容），请稍后再试。', isError: true };
        }
        return {
          content: '文案已发到群里。请不要在正文里重复这段话，也不要输出「已发送」之类的汇报，直接结束即可。'
        };
      } catch (error) {
        return { content: `发送失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/** 依赖自检：必须同步返回。 */
export function available() {
  return true;
}
