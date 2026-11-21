# sokoban-solver-01-run-20261121-entry

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/abilyusa/sokoban-solver-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/abilyusa/sokoban-solver-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: one program answers all 5 instances of a set in one run, in as few pushes as possible.

## How it works

A generated level is a hallway with independent rooms off it — a box pushed out of a room's door into the hallway can never be pushed back, so every box stays in its room. The solver therefore splits each level into its rooms (cut the hallway row's dead squares out of the floor; each remaining part holding boxes is a room), solves every room on its own, and stitches the answers together with the player's walks between rooms. The pushes add up to the level's optimum.

Inside a room the search is A* over pushes: a state is the boxes' squares plus the player's reachable region (named by its lowest square), a push costs 1, and the estimate is the cheapest assignment of boxes to goals by floor distance. Two deadlocks are pruned, both safe — they never cut a solvable state: a box on a dead square (no push, other boxes aside, can ever bring it to a goal) and a frozen 2x2 block of walls and boxes with a box off its goal. When a level does not split into rooms, or a room's search runs out of its work budget, the same A* runs over the whole level instead; when that gives up too, the answer is empty (still a valid answer file).

No clock, no randomness, no environment: the search stops on work counts only, so two runs write the same bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network. `main.ts` reads `/input/<id>/level.txt` and writes `/output/<id>/solution.txt` for every instance.

## Verification

On the kit's practice set, scored with the kit's own scorer: **1,000,000** — every instance solved in exactly its push-optimal count (i001: 13, i002: 16, i003: 29, i004: 47, i005: 60 pushes), in ~0.6 s for the whole set. The house baseline (plain-astar 1.0.0) scores 200,000 on the same set.

Robustness: 20 further sets (100 instances) drawn from fresh seeds with the kit's own generator were all solved at exactly their optimal push counts, each set in 0.3–0.6 s — far inside the 60 s wall budget. Two runs on the practice set write byte-identical outputs.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
