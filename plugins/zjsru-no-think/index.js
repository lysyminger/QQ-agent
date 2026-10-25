// 学校 tokens 网关（vLLM）上的 DeepSeek 默认开思考，且内置方言表把它判成 generic、不发任何思考参数。
// 实测 chat_template_kwargs.thinking=false 能关掉（"pong" 从 70s/2241 token 降到 1s/3 token）；
// thinking:{type:'disabled'} 这种 DeepSeek 官方写法在该网关上无效。
// Qwen 平时保留思考（看图更准），但调用方明确要求不思考、或给了 max_tokens 小额度时也关掉 ——
// 否则熔断切到 Qwen 后，贴表情/夜间复盘这类限额调用会把额度全耗在思考上、正文为空。
const HOST = /(^|\.)tokens\.zjsru\.edu\.cn$/i;
// 只允许学校的免费路由（zjsru- 前缀）。网关上其它模型（fable / qwen3.8-max 等）走付费，
// 不管配置、备选模型还是插件自己指定了什么，发出前一律改写成免费模型。
const FREE_MODEL = /^zjsru-/i;
const FREE_FALLBACK = 'zjsru-qwen3.8-27b';

function hostOf(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname; } catch { return ''; }
}

export const providers = {
  'llm.request-params': ({ body, api, model, context } = {}) => {
    if (!HOST.test(hostOf(api?.baseUrl))) return { body };
    let id = String(body?.model || model || '');
    if (!FREE_MODEL.test(id)) {
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
    if (/qwen/i.test(id) && (context?.thinkingMode === 'off' || Number(body?.max_tokens) > 0)) {
      return {
        body: {
          ...body,
          chat_template_kwargs: { ...(body?.chat_template_kwargs || {}), enable_thinking: false }
        }
      };
    }
    return { body };
  }
};
