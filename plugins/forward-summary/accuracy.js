import { imageParts } from './media.js';
import { localOcr, meaningfulOcr } from './ocr.js';

export async function readAccurately({ records, images, onebot, visionEnabled, filtering, maxImages, ocrEnabled = true, maxOcrImages = 40, maxOcrChars = 20000 }, dependencies = {}) {
  const load = dependencies.load || imageParts;
  const recognize = dependencies.recognize || localOcr;
  const now = dependencies.now || Date.now;
  const started = now();
  const downloaded = new Map();
  const recognized = new Map();
  const notes = [];
  const budgetExpired = () => now() - started >= 90000;
  const owners = (image, record) => image.sources.some((s) => s.recordId === String(record.messageId));
  async function getImage(image) {
    if (downloaded.has(image.number)) return downloaded.get(image.number);
    if (budgetExpired()) return { parts: [], bindings: [], notes: [`图片${image.number}：本轮读取时间上限已到，未读取`] };
    const loaded = await load([image], { onebot, enabled: true });
    downloaded.set(image.number, loaded);
    // Bound retained base64 during a long OCR-only batch (roughly 12 MB decoded).
    let cacheChars = [...downloaded.values()].reduce((n, r) => n + (r.bindings[0]?.url.length || 0), 0);
    while (cacheChars > 16 * 1024 * 1024 && downloaded.size > 1) {
      const first = downloaded.keys().next().value;
      cacheChars -= downloaded.get(first).bindings[0]?.url.length || 0;
      downloaded.delete(first);
    }
    return loaded;
  }
  async function getOcr(image) {
    if (recognized.has(image.number)) return recognized.get(image.number);
    if (!ocrEnabled || recognized.size >= maxOcrImages || budgetExpired()) return { ok: false, error: 'ocr-limit' };
    const loaded = await getImage(image);
    const binding = loaded.bindings[0];
    const ocr = binding ? await recognize(binding.url) : { ok: false, error: 'image-unavailable' };
    recognized.set(image.number, ocr);
    return ocr;
  }

  // OCR is a low-cost gate only. Finding text must NOT exclude the original image from vision.
  for (const record of records) {
    if (!filtering || record.hasDiscussion !== false || record.incompleteText) continue;
    const candidates = images.filter((i) => owners(i, record) && i.sources.some((s) => s.recordId === String(record.messageId) && !s.fromCard));
    for (const image of candidates) {
      const ocr = await getOcr(image);
      if (meaningfulOcr(ocr)) { record.hasDiscussion = true; break; }
      if (!ocr.ok || (ocr.lines || []).some((line) => String(line).trim())) {
        // Short/ambiguous text or OCR failure needs visual judgment, not an empty-content verdict.
        record.incompleteText = true;
        record.needsImageCheck = true;
        break;
      }
    }
  }
  const kept = records.filter((r) => !filtering || r.hasDiscussion !== false || r.incompleteText);
  const keptIds = new Set(kept.map((r) => String(r.messageId)));
  const selected = images.flatMap((image) => {
    const source = image.sources.find((s) => keptIds.has(s.recordId));
    return source ? [{ ...image, label: source.label }] : [];
  });
  const parts = []; const bindings = []; const coverage = [];
  let visualBytes = 0; let remainingText = maxOcrChars;
  for (const image of selected) {
    if (visionEnabled && bindings.length < maxImages) {
      const loaded = await getImage(image);
      const binding = loaded.bindings[0];
      const bytes = binding ? Math.ceil(binding.url.slice(binding.url.indexOf(',') + 1).length * 0.75) : 0;
      if (binding && visualBytes + bytes <= 12 * 1024 * 1024) {
        // Delivered originals remain in traversal order; failed images do not waste a slot.
        visualBytes += bytes;
        parts.push(...loaded.parts);
        bindings.push({ ...binding, label: image.label });
        coverage.push({ number: image.number, mode: 'vision', source: image.label });
        continue;
      }
      notes.push(...loaded.notes);
    }
    const ocr = remainingText > 0 ? await getOcr(image) : { ok: false, error: 'ocr-text-limit' };
    if (ocr.ok) {
      const fullText = (ocr.lines || []).join('\n').trim();
      const text = fullText.slice(0, remainingText);
      const truncated = !!ocr.truncated || text.length < fullText.length;
      remainingText -= text.length;
      const related = kept.filter((r) => owners(image, r));
      for (const [index, record] of related.entries()) {
        record.text += index === 0
          ? `\n[图片${image.number}，${image.label}，仅OCR文字；未看到画面，识字及气泡顺序可能有误${truncated ? '；文字已截断' : ''}]\n${text || '未识别出可读文字，不代表图片没有内容'}`
          : `\n[图片${image.number}重复出现，OCR文字见同编号首处]`;
        if (truncated || !text) record.partial = true;
      }
      coverage.push({ number: image.number, mode: text ? 'ocr' : 'unread', truncated, source: image.label });
      if (truncated || !text) notes.push(`图片${image.number}：${truncated ? 'OCR文字已截断，存在遗漏' : 'OCR未识别出文字，画面内容未读取'}`);
    } else {
      for (const record of kept.filter((r) => owners(image, r))) record.partial = true;
      coverage.push({ number: image.number, mode: 'unread', source: image.label });
      notes.push(`图片${image.number}：未能读取，可能是下载/OCR失败或达到本轮处理上限；不能推测内容`);
    }
  }
  return { kept, skippedCount: records.length - kept.length, media: { parts, bindings, notes }, coverage };
}
