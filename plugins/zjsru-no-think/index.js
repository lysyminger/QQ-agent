// 学校 tokens 网关（vLLM）上的 DeepSeek 默认开思考，且内置方言表把它判成 generic、不发任何思考参数。
// 实测 chat_template_kwargs.thinking=false 能关掉（"pong" 从 70s/2241 token 降到 1s/3 token）；
// thinking:{type:'disabled'} 这种 DeepSeek 官方写法在该网关上无效。
// 2026-11-02 起不再用学校的 Qwen（主人要求去掉）：免费路由只剩 DeepSeek V4 Flash。
const HOST = /(^|\.)tokens\.zjsru\.edu\.cn$/i;
// 只允许学校的免费路由（zjsru- 前缀）。网关上其它模型（fable / qwen 系列等）走付费或已弃用，
// 不管配置、备选模型还是插件自己指定了什么，发出前一律改写成免费模型。
const FREE_MODEL = /^zjsru-/i;
const FREE_FALLBACK = 'zjsru-DeepSeek-V4-flash-0731';

function hostOf(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname; } catch { return ''; }
}

export const providers = {
  'llm.request-params': ({ body, api, model } = {}) => {
    if (!HOST.test(hostOf(api?.baseUrl))) return { body };
    let id = String(body?.model || model || '');
    if (!FREE_MODEL.test(id) || /qwen/i.test(id)) {
      console.warn(`[zjsru-no-think] 拦下付费模型 ${id || '(空)'}，改走免费路由 ${FREE_FALLBACK}`);
      body = { ...body, model: FREE_FALLBACK };
      id = FREE_FALLBACK;
    }
    if (/deepseek/i.test(id)) {
      return {
        body: {
          ...body,
          chat_template_kwargs: { ...(body?.chat_template_kwargs || {}), thinking: false }
        }
      };
    }
    return { body };
  }
};
