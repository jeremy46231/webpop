import type { Shape } from './shapes';

export function describe(s: Shape): string {
  return `${s.kind}: area=${s.area().toFixed(2)}, perimeter=${s.perimeter().toFixed(2)}`;
}
