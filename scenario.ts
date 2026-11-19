// scenario.ts — derive the viewer's identity from the kit's one fixed scenario seed.
// Vendored pure generators from program/env/src/wire.ts (SCENARIO_SEED is fixed for
// every instance: practice and scored). The viewer is users[0]; no login is ever passed
// to the entry, so this derivation is the only way to know who "me" is.
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  private state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(array: readonly T[]): T {
    return array[this.nextInt(array.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris',
  'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa',
  'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;

const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm',
  'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters',
  'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz',
  'zimmer',
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

export function scenarioRng(salt: string): Rng {
  return new Rng(mix64(SCENARIO_SEED ^ fnv1a64(salt)));
}

export function generateUsers(count: number): ScenarioUser[] {
  const rng = scenarioRng('users');
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let suffix = 2;
    while (used.has(login)) {
      login = `${first}${last}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    const title = (s: string): string => s.slice(0, 1).toUpperCase() + s.slice(1);
    users.push({
      id: 1000 + i,
      login,
      name: `${title(first)} ${title(last)}`,
      email: `${login}@example.invalid`,
    });
  }
  return users;
}

/** The viewer is users[0]; the teammate is users[1]; the stranger is users[2]. */
export const SCENARIO_USERS: ScenarioUser[] = generateUsers(12);
export const VIEWER: ScenarioUser = SCENARIO_USERS[0] as ScenarioUser;
export const DEFAULT_BRANCH = 'main';
