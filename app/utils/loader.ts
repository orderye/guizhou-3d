// 运行时数据加载:dev/普通构建走 fetch(带 cache-bust);
// 单文件构建走 window.__GZ_EMBED__(键前缀 gz:// 表示 gzip+base64,浏览器 DecompressionStream 解压)
const CACHE_BUST = (window as any).__GZ_EMBED__ ? 'e' : String(Date.now());

function bust(path: string): string {
  return path + (path.includes('?') ? '&' : '?') + 'cb=' + CACHE_BUST;
}

function embedGet(path: string): { key: string; val: string } | null {
  const embed = (window as any).__GZ_EMBED__;
  if (!embed) return null;
  for (const pre of ['', 'br://', 'gz://']) {
    const k = pre + path;
    if (embed[k] !== undefined) return { key: k, val: embed[k] };
  }
  return null;
}

async function embedBytes(val: string, key: string): Promise<Uint8Array> {
  const bytes = Uint8Array.from(atob(val), c => c.charCodeAt(0));
  const enc = (key.startsWith('br://') ? 'br' : 'gzip') as CompressionFormat;
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream(enc));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function loadJSON<T = any>(path: string): Promise<T> {
  const e = embedGet(path);
  if (e) {
    const bytes = await embedBytes(e.val, e.key);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
  const res = await fetch(bust(path));
  if (!res.ok) throw new Error(`load fail: ${path} ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadBin(path: string): Promise<ArrayBuffer> {
  const e = embedGet(path);
  if (e) {
    const bytes = await embedBytes(e.val, e.key);
    return bytes.buffer as ArrayBuffer;
  }
  const res = await fetch(bust(path));
  if (!res.ok) throw new Error(`load fail: ${path} ${res.status}`);
  return res.arrayBuffer();
}
