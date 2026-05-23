import leven from 'leven';

export function suggest(input, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = leven(input, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return best;
}
