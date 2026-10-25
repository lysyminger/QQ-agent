import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const cache = new Map();
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
$script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
function Await($op, $type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait()
  return $task.Result
}
$stream = $null
$bitmap = $null
try {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'OCR language unavailable' }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:QQ_FORWARD_OCR_FILE)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object { $_.Text })
  @{ ok=$true; lines=$lines; width=$bitmap.PixelWidth; height=$bitmap.PixelHeight } | ConvertTo-Json -Depth 3 -Compress
} catch {
  @{ ok=$false; error='local-ocr-unavailable' } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
}
`;

export function meaningfulOcr(result) {
  if (!result?.ok) return false;
  const lines = (result.lines || []).map(String).filter((s) => s.trim());
  const text = lines.join('').replace(/(?:https?:\/\/|www\.)\S+/gi, '').replace(/[\s\p{P}\p{S}\d]/gu, '');
  // This detects substantial readable text, not proof that an image is a chat screenshot.
  return lines.length >= 3 && [...text].length >= 24;
}

export function applyOcr(records, image, ocr, remaining) {
  const owners = records.filter((r) => image.sources.some((s) => s.recordId === String(r.messageId)));
  if (meaningfulOcr(ocr) && remaining > 0) {
    const text = ocr.lines.join('\n').slice(0, Math.min(2500, remaining));
    for (const [index, r] of owners.entries()) {
      r.hasDiscussion = true;
      r.text += index === 0 ? `\n[图片${image.number}的本地OCR文字：可能识别有误，行序不保证是对话顺序，仅据实际文字概括]\n${text}` : `\n[图片${image.number}为重复图片，文字见同编号的首次OCR转写]`;
    }
    return { used: text.length, onlyText: true };
  }
  if (!ocr.ok || (meaningfulOcr(ocr) && remaining <= 0)) {
    for (const r of owners) { r.incompleteText = true; r.needsImageCheck = true; }
    return { used: 0, onlyText: false, note: `图片${image.number}：本地OCR不可用或文字额度已满，改由少量视觉图片判断是否有实际聊天内容。` };
  }
  return { used: 0, onlyText: false };
}

export async function localOcr(dataUrl) {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(dataUrl).digest('hex');
  if (cache.has(hash)) return cache.get(hash);
  if (process.platform !== 'win32') return { ok: false, error: 'local-ocr-unavailable' };
  let dir;
  let result;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forward-ocr-'));
    const file = path.join(dir, 'image.bin');
    await fs.writeFile(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
      env: { ...process.env, QQ_FORWARD_OCR_FILE: file }
    });
    result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
    if (result.ok) {
      const lines = result.lines || [];
      result.truncated = lines.length > 300 || lines.some((s) => String(s).length > 1000);
      result.lines = lines.map((s) => String(s).slice(0, 1000)).slice(0, 300);
    }
  } catch (error) { result = { ok: false, error: 'local-ocr-unavailable', code: error?.code || 'parse-error' }; }
  finally { if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  if (result.ok) {
    while (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(hash, result);
  }
  return result;
}

export function clearOcrCache() { cache.clear(); }
