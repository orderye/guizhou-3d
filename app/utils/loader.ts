// 运行时数据加载:dev/普通构建走 fetch(带版本号);
// 单文件构建走 window.__GZ_EMBED__(键前缀 gz:// 表示 gzip+base64,浏览器 DecompressionStream 解压)
declare const __RUNTIME_VERSION__: string;

// 版本号由 vite define 注入:构建态是 public/runtime 的数据指纹,数据不变则 URL 不变,可被长期缓存
function bust(path: string): string {
  return path + (path.includes('?') ? '&' : '?') + 'v=' + __RUNTIME_VERSION__;
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

/**
 * 加载图片(卫星底图等)。
 * 统一以 imageOrientation:'flipY' 解码,配合纹理 flipY=false 使用——
 * WebGL 的 UNPACK_FLIP_Y_WEBGL 对 ImageBitmap 行为不一致,故在解码阶段翻转。
 */
export async function loadImage(path: string, mime = 'image/jpeg'): Promise<ImageBitmap> {
  let blob: Blob;
  const e = embedGet(path);
  if (e) {
    const bytes = await embedBytes(e.val, e.key);
    blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  } else {
    const res = await fetch(bust(path));
    if (!res.ok) throw new Error(`load fail: ${path} ${res.status}`);
    blob = await res.blob();
  }
  return createImageBitmap(blob, { imageOrientation: 'flipY' });
}
