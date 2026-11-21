// Sokoban solver: room-by-room push-optimal A*.
//
// Idea: a generated level is a hallway with independent rooms off it (a box
// pushed out of a room's door into the hallway can never come back, so every
// box stays in its room). Each room is therefore solved on its own, push by
// push, with the player walking between rooms; the pushes add up to the
// level's optimum. Inside a room the search is A* over pushes: a state is
// the boxes' squares plus the player's reachable region (named by its lowest
// square), a push costs 1, and the estimate is the cheapest assignment of
// boxes to goals by floor distance. Two deadlocks are pruned, both safe (they
// never cut a solvable state): a box on a dead square (no push, other boxes
// aside, can ever bring it to a goal) and a frozen 2x2 block of walls and
// boxes with a box off its goal. When the level does not split into rooms,
// or a room's search runs out of its work budget, the same A* runs over the
// whole level instead; when that gives up too, the answer is empty (still a
// valid answer file). No clock, no randomness, no environment: the search
// stops on work counts only, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets (expansions), never the clock: the same on every run. */
const ROOM_EXPANSIONS = 400_000;
const WHOLE_EXPANSIONS = 400_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares from which a box alone can be pushed onto some goal: pull back from the goals over open floor. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length || wall[y] || wall[y - d] || live[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/** Walking distances from every goal over open floor (boxes ignored), one BFS per goal. */
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= wall.length || wall[q] || dist[q] >= 0) continue;
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
    out.push(dist);
  }
  return out;
}

/** The squares the player reaches from `from` with `occupied` in the way; returns the region's lowest square. */
function reachLow(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length || wall[q] || occupied[q] || seen[q] === stamp) continue;
      seen[q] = stamp;
      stack[n++] = q;
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string | null {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface PushSolution {
  moves: string;
  player: number; // the square the player stands on after the moves
}

/**
 * Push-optimal A* for one (sub)level: {moves, player} or null when the work
 * budget runs out or the level has no solution. `maxExpansions` bounds the
 * work, never the clock.
 */
function solvePushAStar(level: Level, maxExpansions: number): PushSolution | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dists = goalDistances(level);
  const n = goals.length;
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // Cheapest assignment of boxes to goals by floor distance; -1 when a box
  // can reach no goal at all. Admissible: one push moves one box one square.
  const estimate = (boxes: number[]): number => {
    if (n <= 4) {
      // Brute-force the permutations (at most 24).
      const perm = goals.map((_, i) => i);
      let best = Infinity;
      const rec = (k: number, acc: number): void => {
        if (acc >= best) return;
        if (k === n) {
          if (acc < best) best = acc;
          return;
        }
        for (let i = k; i < n; i++) {
          [perm[k], perm[i]] = [perm[i]!, perm[k]!];
          const d = dists[perm[k]!]![boxes[k]!]!;
          if (d >= 0) rec(k + 1, acc + d);
          [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        }
      };
      rec(0, 0);
      return best === Infinity ? -1 : best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (const d of dists) {
        const v = d[b]!;
        if (v >= 0 && v < m) m = v;
      }
      if (m === Infinity) return -1;
      sum += m;
    }
    return sum;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  const h0 = estimate(level.boxes);
  if (h0 < 0) return null;

  // A state's key: the region's lowest square and the boxes' squares, as
  // digits in base `size` (exact while size ** (boxes + 1) stays under 2^53);
  // a string key when there are too many boxes for that (the whole-level
  // fallback), where a number would collide.
  const stringKey = level.boxes.length > 4;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (stringKey) return `${low}|${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // States in discovery order: boxes, player square, parent, the push that made them.
  const stBoxes: number[][] = [level.boxes];
  const stPlayer: number[] = [level.player];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stTo: number[] = [-1];
  const best = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, reachLow(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // Binary heap on (f, -g, sequence): f first, deeper g first on a tie, then
  // earliest discovered — every tie-break deterministic.
  const heap: [number, number, number, number][] = [[h0, 0, 0, 0]];
  let seq = 1;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let found = solved(level.boxes) ? 0 : -1;
  let expanded = 0;
  while (heap.length > 0 && found < 0) {
    const [, g, , s] = heapPop();
    const boxes = stBoxes[s]!;
    // Skip a stale heap entry (a better route to this state was found).
    for (const b of boxes) occupied[b] = 1;
    const low = reachLow(level, occupied, stPlayer[s]!, seen, ++stamp, stack);
    if (best.get(keyOf(boxes, low)) !== g) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    if (expanded >= maxExpansions) {
      for (const b of boxes) occupied[b] = 0;
      return null;
    }
    expanded++;
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        let key: number | string | null = null;
        let next: number[] | null = null;
        let h = -1;
        if (!frozenBlock(level, occupied, goal, t)) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = estimate(next);
          if (h >= 0) key = keyOf(next, reachLow(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (next === null || h < 0 || key === null) continue;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g + 1) continue;
        best.set(key, g + 1);
        const child = stBoxes.length;
        stBoxes.push(next);
        stPlayer.push(b);
        stParent.push(s);
        stFrom.push(b);
        stTo.push(t);
        if (solved(next)) {
          found = child;
          break;
        }
        heapPush([g + 1 + h, g + 1, seq++, child]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = stFrom[s]!;
    const to = stTo[s]!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk;
    moves += dir[3];
    player = from;
    boxes = stBoxes[s]!;
  }
  return { moves, player };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (q < 0 || q >= wall.length || wall[q] || cut[q] || part[q] >= 0) continue;
        part[q] = rooms.length;
        squares.push(q);
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The level solved room by room, or over the whole level when it is no set of rooms. */
function solve(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      // The other rooms' boxes stand as walls (on their goals once done).
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushAStar(sub, ROOM_EXPANSIONS);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = solved.player;
      room.done = true;
    }
    if (ok) return moves;
  }
  const whole = solvePushAStar(level, WHOLE_EXPANSIONS);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
