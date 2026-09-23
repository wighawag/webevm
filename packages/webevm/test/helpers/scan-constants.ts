/**
 * scan-constants.ts — the two numbers the concurrency battery's anti-vacuity
 * guards are built from, in ONE place.
 *
 * They live in their own module because the two sides that need them run in
 * different processes and must not drag each other's imports along: the battery
 * (./concurrency.ts) runs IN THE BROWSER and pulls in `src/index.js` and viem,
 * while the shared assertions (../concurrency-expected.ts) run in the Node-side
 * spec. A `MIN_OVERLAPPING` declared in the first and copied into the second is a
 * silent drift: tightening the copy the battery reads would leave the assertion
 * checking the old value, and nothing would report it (this package does not set
 * `noUnusedLocals`, so the abandoned copy would not even be flagged as dead).
 */

/**
 * How many offsets of a sweep must genuinely overlap before a scan is worth
 * believing.
 *
 * Deliberately far below what is measured — 32 of 32 for the default engine, 10
 * of 32 for revm in chromium, where the transaction settles in fewer ticks — so
 * that it is a check rather than a flake. What it rules out is the sweep
 * collapsing to one or two overlapping offsets while still reporting a pass.
 */
export const MIN_OVERLAPPING = 4;

/**
 * The far probe, in MICROTASK TURNS rather than milliseconds: large enough that
 * the first request has certainly settled, and insensitive to how loaded the
 * machine is, which is the property a wall-clock deadline would not have. It is
 * cheap because each link in the chain is an already-resolved promise.
 *
 * It fails SAFE in the one direction that matters: `pendingAtBoundary` starts
 * `true`, so a probe that never observed anything reports `crossesTheBoundary:
 * false` and fails the spec rather than passing it.
 */
export const BOUNDARY_TICKS = 4096;
