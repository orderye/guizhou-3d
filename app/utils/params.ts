// URL 参数(方案 §56)
export interface Params {
  terrain: boolean; water: boolean; forest: boolean; city: boolean; road: boolean;
  boundary: boolean; debug: boolean; exaggeration: number | null; view: string;
  intro: boolean; night: boolean; shadow: boolean;
  cam: [number, number, number] | null; tgt: [number, number, number] | null;
}

export function parseParams(): Params {
  const q = new URLSearchParams(location.search);
  const num = (k: string) => { const v = parseFloat(q.get(k) || ''); return isFinite(v) ? v : null; };
  const flag = (k: string, dflt = true) => {
    const v = q.get(k);
    if (v === null) return dflt;
    return v !== '0' && v !== 'false';
  };
  const vec = (k: string): [number, number, number] | null => {
    const v = q.get(k);
    if (!v) return null;
    const p = v.split(',').map(Number);
    return (p.length === 3 && p.every(n => isFinite(n))) ? [p[0], p[1], p[2]] : null;
  };
  return {
    terrain: flag('terrain'),
    water: flag('water'),
    forest: flag('forest'),
    city: flag('city'),
    road: flag('road'),
    boundary: flag('boundary'),
    debug: flag('debug', false) || q.has('debug'),
    exaggeration: num('exaggeration'),
    view: q.get('view') || 'overview',
    intro: q.has('intro'),
    night: q.get('night') === '1',
    shadow: q.get('shadow') === '1',
    cam: vec('cam'),
    tgt: vec('tgt')
  };
}
