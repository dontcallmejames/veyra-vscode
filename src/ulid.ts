// Tiny ULID-like ID generator — sortable by creation time, no external dep.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(): string {
  const time = Date.now();
  let timeStr = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    timeStr = ALPHABET[t & 31] + timeStr;
    t = Math.floor(t / 32);
  }
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    randStr += ALPHABET[Math.floor(Math.random() * 32)];
  }
  return timeStr + randStr;
}
