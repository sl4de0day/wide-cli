import assert from "node:assert";
import {
  CommitmentGate,
  Commitment,
  PluralityConsensus,
  ClaimTable,
  PartitionAssignment,
  WeightedScorer,
  Criterion,
  SynchronizationBarrier
} from "../dist/decision/index.js";

console.log("Testing Wide DecisionCore primitives...");

const gate = new CommitmentGate(4, 0.5);
assert.strictEqual(gate.state, 0);
assert.strictEqual(gate.tryTransition(1, 0.1), false);
assert.strictEqual(gate.tryTransition(1, 0.6), true);
assert.strictEqual(gate.state, 1);
console.log("[PASS] CommitmentGate enforces dwell time");

const plan = new Commitment(5.0, 2.0);
plan.adopt(0.8, 10.0);
assert.strictEqual(plan.shouldReplace(0.95, 0.1, 11.0), false);
assert.strictEqual(plan.shouldReplace(0.95, 0.1, 13.0), true);
console.log("[PASS] Commitment lock window and replacement margin");

const consensus = new PluralityConsensus(4, 8, 5.0, 2);
consensus.vote(101, 2, 1.0);
consensus.vote(102, 2, 1.2);
consensus.vote(103, 1, 1.5);
assert.strictEqual(consensus.resolve(2.0), true);
assert.strictEqual(consensus.value, 2);
console.log("[PASS] PluralityConsensus unweighted resolution");

const claims = new ClaimTable(4);
assert.strictEqual(claims.tryClaim(1, 0.5, 3.0, 0.0, 2), true);
assert.strictEqual(claims.tryClaim(2, 0.8, 3.0, 0.5, 2), true);
assert.strictEqual(claims.tryClaim(3, 0.3, 3.0, 1.0, 2), false);
assert.strictEqual(claims.tryClaim(3, 0.9, 3.0, 1.0, 2), true);
console.log("[PASS] ClaimTable capacity and bid preemption");

const partitions = new PartitionAssignment(4);
const a1 = partitions.tryAssign(10, 0, 5.0, 1.0);
assert.strictEqual(a1.success, true);
assert.strictEqual(a1.partition, 0);
const a2 = partitions.tryAssign(20, 0, 5.0, 1.0);
assert.strictEqual(a2.success, true);
assert.notStrictEqual(a2.partition, 0);
console.log("[PASS] PartitionAssignment collision-free search");

const scorer = new WeightedScorer(
  new Criterion(0.6, (c) => (c === 0 ? 0.9 : 0.3)),
  new Criterion(0.4, (c) => (c === 0 ? 0.8 : 0.9))
);
const sel = scorer.trySelect(2, 0.5);
assert.strictEqual(sel.success, true);
assert.strictEqual(sel.best, 0);
console.log("[PASS] WeightedScorer multi-criteria ranking");

const barrier = new SynchronizationBarrier(4);
barrier.reportReady(1, 10.0);
barrier.reportReady(2, 10.5);
assert.strictEqual(barrier.tick(3, 0.6, 5.0, 11.0), true);
assert.strictEqual(barrier.reachedQuorum, true);
console.log("[PASS] SynchronizationBarrier quorum check");

console.log("All DecisionCore tests passed successfully.");
