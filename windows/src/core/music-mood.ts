/** Use a player's BPM when available; genre is only a visual pace estimate. */
export function danceBpm(bpm: unknown, genre: string): number {
  const known = Number(bpm);
  if (Number.isFinite(known) && known >= 40 && known <= 240) return known;
  const g = genre.toLowerCase();
  if (/ambient|chill|classical|lofi|ballad/.test(g)) return 76;
  if (/hip.?hop|jazz|blues|acoustic|folk/.test(g)) return 92;
  if (/drum.?and.?bass|jungle|hardcore/.test(g)) return 160;
  if (/techno|edm|house|trance|dance/.test(g)) return 130;
  if (/rock|metal|punk|pop/.test(g)) return 120;
  return 112;
}
