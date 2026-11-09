export class CommitmentGate {
  private readonly statesCount: number;
  private readonly minDwellTime: number;
  private readonly cooldowns: Float64Array;
  private readonly lastEntries: Float64Array;
  private readonly exemptions: Uint8Array;
  private currentState: number;
  private enteredAtTime: number;
  private acceptedTransitions: number;
  private rejectedTransitions: number;

  constructor(statesCount: number, minDwellTime: number, defaultCooldown = 0.0) {
    if (statesCount < 1) throw new RangeError("statesCount must be at least 1");
    if (minDwellTime < 0.0) throw new RangeError("minDwellTime cannot be negative");

    this.statesCount = statesCount;
    this.minDwellTime = minDwellTime;
    this.cooldowns = new Float64Array(statesCount);
    this.lastEntries = new Float64Array(statesCount);
    this.exemptions = new Uint8Array(statesCount);

    for (let i = 0; i < statesCount; i++) {
      this.cooldowns[i] = defaultCooldown;
      this.lastEntries[i] = -Infinity;
    }

    this.currentState = 0;
    this.enteredAtTime = 0.0;
    this.acceptedTransitions = 0;
    this.rejectedTransitions = 0;
  }

  public get state(): number {
    return this.currentState;
  }

  public get minDwell(): number {
    return this.minDwellTime;
  }

  public get accepted(): number {
    return this.acceptedTransitions;
  }

  public get rejected(): number {
    return this.rejectedTransitions;
  }

  public setCooldown(state: number, seconds: number): void {
    if (state < 0 || state >= this.statesCount) return;
    this.cooldowns[state] = seconds;
  }

  public setExempt(state: number, exempt: boolean): void {
    if (state < 0 || state >= this.statesCount) return;
    this.exemptions[state] = exempt ? 1 : 0;
  }

  public allowed(next: number, now: number): boolean {
    if (next < 0 || next >= this.statesCount) return false;
    if (next === this.currentState) return false;
    if (this.exemptions[next] !== 0) return true;
    if (this.cooldowns[next] > 0.0 && now - this.lastEntries[next] < this.cooldowns[next]) return false;
    return now - this.enteredAtTime >= this.minDwellTime;
  }

  public tryTransition(next: number, now: number): boolean {
    if (!this.allowed(next, now)) {
      this.rejectedTransitions++;
      return false;
    }

    this.currentState = next;
    this.enteredAtTime = now;
    this.lastEntries[next] = now;
    this.acceptedTransitions++;
    return true;
  }

  public forceTransition(next: number, now: number): void {
    if (next < 0 || next >= this.statesCount) return;
    this.currentState = next;
    this.enteredAtTime = now;
    this.lastEntries[next] = now;
    this.acceptedTransitions++;
  }
}

export class Commitment {
  private readonly lifetime: number;
  private readonly lockWindow: number;
  private adoptedAt: number;
  private currentScore: number;
  private hasCommitment: boolean;

  constructor(lifetime: number, lockWindow: number) {
    if (lifetime <= 0.0) throw new RangeError("lifetime must be positive");
    if (lockWindow < 0.0) throw new RangeError("lockWindow cannot be negative");

    this.lifetime = lifetime;
    this.lockWindow = lockWindow;
    this.adoptedAt = -Infinity;
    this.currentScore = 0.0;
    this.hasCommitment = false;
  }

  public get score(): number {
    return this.currentScore;
  }

  public get committed(): boolean {
    return this.hasCommitment;
  }

  public isExpired(now: number): boolean {
    return !this.hasCommitment || now - this.adoptedAt >= this.lifetime;
  }

  public isLocked(now: number): boolean {
    return this.hasCommitment && now - this.adoptedAt < this.lockWindow;
  }

  public shouldReplace(challengerScore: number, margin: number, now: number): boolean {
    if (this.isExpired(now)) return true;
    if (this.isLocked(now)) return false;
    return challengerScore >= this.currentScore + margin;
  }

  public adopt(score: number, now: number): void {
    this.currentScore = score;
    this.adoptedAt = now;
    this.hasCommitment = true;
  }

  public clear(): void {
    this.hasCommitment = false;
    this.currentScore = 0.0;
    this.adoptedAt = -Infinity;
  }
}

export class PluralityConsensus {
  private readonly capacity: number;
  private readonly classesCount: number;
  private readonly freshnessWindow: number;
  private readonly minVotesCount: number;
  private readonly voterIds: Int32Array;
  private readonly voterClasses: Int32Array;
  private readonly voterTimes: Float64Array;
  private readonly tallies: Int32Array;
  private agreedValue: number;
  private isSettled: boolean;

  constructor(classesCount: number, capacity = 16, freshnessWindow = 6.0, minVotesCount = 1) {
    if (classesCount < 1) throw new RangeError("classesCount must be at least 1");
    if (capacity < 1) throw new RangeError("capacity must be at least 1");
    if (freshnessWindow <= 0.0) throw new RangeError("freshnessWindow must be positive");
    if (minVotesCount < 1) throw new RangeError("minVotesCount must be at least 1");

    this.classesCount = classesCount;
    this.capacity = capacity;
    this.freshnessWindow = freshnessWindow;
    this.minVotesCount = minVotesCount;
    this.voterIds = new Int32Array(capacity);
    this.voterClasses = new Int32Array(capacity);
    this.voterTimes = new Float64Array(capacity);
    this.tallies = new Int32Array(classesCount);
    this.agreedValue = 0;
    this.isSettled = false;
  }

  public get value(): number {
    return this.agreedValue;
  }

  public get settled(): boolean {
    return this.isSettled;
  }

  public vote(voterId: number, classIndex: number, now: number): boolean {
    if (voterId === 0) return false;
    if (classIndex < 0 || classIndex >= this.classesCount) return false;

    for (let i = 0; i < this.capacity; i++) {
      if (this.voterIds[i] === voterId) {
        this.voterClasses[i] = classIndex;
        this.voterTimes[i] = now;
        return true;
      }
    }

    for (let i = 0; i < this.capacity; i++) {
      const live = this.voterIds[i] !== 0 && now - this.voterTimes[i] < this.freshnessWindow;
      if (!live) {
        this.voterIds[i] = voterId;
        this.voterClasses[i] = classIndex;
        this.voterTimes[i] = now;
        return true;
      }
    }

    return false;
  }

  public resolve(now: number): boolean {
    this.tallies.fill(0);
    let totalLive = 0;

    for (let i = 0; i < this.capacity; i++) {
      if (this.voterIds[i] !== 0 && now - this.voterTimes[i] < this.freshnessWindow) {
        const c = this.voterClasses[i];
        if (c >= 0 && c < this.classesCount) {
          this.tallies[c]++;
          totalLive++;
        }
      }
    }

    if (totalLive < this.minVotesCount) {
      this.isSettled = false;
      return false;
    }

    let topVotes = 0;
    let topClass = 0;
    let tie = false;

    for (let c = 0; c < this.classesCount; c++) {
      const v = this.tallies[c];
      if (v > topVotes) {
        topVotes = v;
        topClass = c;
        tie = false;
      } else if (v === topVotes && topVotes > 0) {
        tie = true;
      }
    }

    if (topVotes >= this.minVotesCount && !tie) {
      this.agreedValue = topClass;
      this.isSettled = true;
      return true;
    }

    this.isSettled = false;
    return false;
  }
}

export class ClaimTable {
  private readonly slotsCount: number;
  private readonly holders: Int32Array;
  private readonly expirationTimes: Float64Array;
  private readonly bids: Float64Array;

  constructor(slotsCount: number) {
    if (slotsCount < 1) throw new RangeError("slotsCount must be at least 1");
    this.slotsCount = slotsCount;
    this.holders = new Int32Array(slotsCount);
    this.expirationTimes = new Float64Array(slotsCount);
    this.bids = new Float64Array(slotsCount);
  }

  public get slots(): number {
    return this.slotsCount;
  }

  public occupancy(now: number): number {
    let n = 0;
    for (let i = 0; i < this.slotsCount; i++) {
      if (this.holders[i] !== 0 && now < this.expirationTimes[i]) n++;
    }
    return n;
  }

  public tryClaim(holderId: number, bid: number, lifetime: number, now: number, capacity: number): boolean {
    if (holderId === 0 || capacity < 1 || lifetime <= 0.0) return false;

    for (let i = 0; i < this.slotsCount; i++) {
      if (this.holders[i] === holderId) {
        this.expirationTimes[i] = now + lifetime;
        this.bids[i] = bid;
        return true;
      }
    }

    let used = 0;
    let freeIndex = -1;
    let weakestIndex = -1;
    let weakestBid = Infinity;

    for (let i = 0; i < this.slotsCount; i++) {
      const live = this.holders[i] !== 0 && now < this.expirationTimes[i];
      if (!live) {
        if (freeIndex < 0) freeIndex = i;
        continue;
      }
      used++;
      if (this.bids[i] < weakestBid) {
        weakestBid = this.bids[i];
        weakestIndex = i;
      }
    }

    if (used < capacity && freeIndex >= 0) {
      this.holders[freeIndex] = holderId;
      this.expirationTimes[freeIndex] = now + lifetime;
      this.bids[freeIndex] = bid;
      return true;
    }

    if (weakestIndex >= 0 && bid > weakestBid) {
      this.holders[weakestIndex] = holderId;
      this.expirationTimes[weakestIndex] = now + lifetime;
      this.bids[weakestIndex] = bid;
      return true;
    }

    return false;
  }

  public release(holderId: number): void {
    for (let i = 0; i < this.slotsCount; i++) {
      if (this.holders[i] === holderId) {
        this.holders[i] = 0;
        this.expirationTimes[i] = 0.0;
        this.bids[i] = 0.0;
      }
    }
  }
}

export class PartitionAssignment {
  private readonly partitionsCount: number;
  private readonly assignments: Int32Array;
  private readonly expirationTimes: Float64Array;

  constructor(partitionsCount: number) {
    if (partitionsCount < 1) throw new RangeError("partitionsCount must be at least 1");
    this.partitionsCount = partitionsCount;
    this.assignments = new Int32Array(partitionsCount);
    this.expirationTimes = new Float64Array(partitionsCount);
  }

  public tryAssign(agentId: number, preferred: number, lifetime: number, now: number): { success: boolean; partition: number } {
    if (agentId === 0 || lifetime <= 0.0) return { success: false, partition: -1 };

    for (let i = 0; i < this.partitionsCount; i++) {
      if (this.assignments[i] === agentId && now < this.expirationTimes[i]) {
        this.expirationTimes[i] = now + lifetime;
        return { success: true, partition: i };
      }
    }

    const normPref = ((preferred % this.partitionsCount) + this.partitionsCount) % this.partitionsCount;

    for (let step = 0; step <= Math.floor(this.partitionsCount / 2); step++) {
      const candidates = step === 0 ? [normPref] : [
        (normPref + step) % this.partitionsCount,
        ((normPref - step) % this.partitionsCount + this.partitionsCount) % this.partitionsCount
      ];

      for (const c of candidates) {
        const live = this.assignments[c] !== 0 && now < this.expirationTimes[c];
        if (!live) {
          this.assignments[c] = agentId;
          this.expirationTimes[c] = now + lifetime;
          return { success: true, partition: c };
        }
      }
    }

    return { success: false, partition: -1 };
  }

  public release(agentId: number): void {
    for (let i = 0; i < this.partitionsCount; i++) {
      if (this.assignments[i] === agentId) {
        this.assignments[i] = 0;
        this.expirationTimes[i] = 0.0;
      }
    }
  }
}

export class Criterion {
  public readonly weight: number;
  public readonly term: (candidate: number) => number;

  constructor(weight: number, term: (candidate: number) => number) {
    if (weight < 0.0) throw new RangeError("weight cannot be negative");
    if (!term) throw new TypeError("term cannot be null");
    this.weight = weight;
    this.term = term;
  }
}

export class WeightedScorer {
  private readonly criteria: Criterion[];
  private readonly totalWeight: number;

  constructor(...criteria: Criterion[]) {
    if (!criteria || criteria.length === 0) throw new TypeError("criteria cannot be null or empty");
    this.criteria = [...criteria];
    let m = 0.0;
    for (const c of this.criteria) {
      if (!c || !c.term) throw new TypeError("criterion or term cannot be null");
      m += c.weight;
    }
    if (m <= 0.0) throw new RangeError("total weight must be positive");
    this.totalWeight = m;
  }

  public score(candidate: number): number {
    let s = 0.0;
    for (const c of this.criteria) {
      let f = c.term(candidate);
      if (f < 0.0) f = 0.0;
      else if (f > 1.0) f = 1.0;
      s += c.weight * f;
    }
    return s / this.totalWeight;
  }

  public trySelect(candidateCount: number, threshold: number, bias = 1.0): { success: boolean; best: number; score: number } {
    if (candidateCount < 1 || bias <= 0.0) return { success: false, best: -1, score: 0.0 };

    const effectiveThreshold = threshold / bias;
    let bestIndex = -1;
    let bestScore = -1.0;

    for (let i = 0; i < candidateCount; i++) {
      const s = this.score(i);
      if (s > bestScore) {
        bestScore = s;
        bestIndex = i;
      }
    }

    if (bestScore >= effectiveThreshold && bestIndex >= 0) {
      return { success: true, best: bestIndex, score: bestScore };
    }

    return { success: false, best: bestIndex, score: bestScore };
  }
}

export enum BarrierBudget {
  Patient = 0,
  Measured = 1,
  Hasty = 2,
  Immediate = 3
}

export class SynchronizationBarrier {
  private readonly capacity: number;
  private readonly agentIds: Int32Array;
  private readonly readyStates: Uint8Array;
  private readonly reportedEtas: Float64Array;
  private readonly reportTimes: Float64Array;
  private quorumReached: boolean;
  private currentPhase: number;
  private stageStartTime: number;

  constructor(capacity = 16) {
    if (capacity < 1) throw new RangeError("capacity must be at least 1");
    this.capacity = capacity;
    this.agentIds = new Int32Array(capacity);
    this.readyStates = new Uint8Array(capacity);
    this.reportedEtas = new Float64Array(capacity);
    this.reportTimes = new Float64Array(capacity);
    this.quorumReached = false;
    this.currentPhase = 0;
    this.stageStartTime = 0.0;
  }

  public get reachedQuorum(): boolean {
    return this.quorumReached;
  }

  public reportReady(agentId: number, now: number): void {
    if (agentId === 0) return;
    for (let i = 0; i < this.capacity; i++) {
      if (this.agentIds[i] === agentId || this.agentIds[i] === 0) {
        this.agentIds[i] = agentId;
        this.readyStates[i] = 1;
        this.reportTimes[i] = now;
        return;
      }
    }
  }

  public tick(population: number, quorumThreshold = 0.6, timeoutSeconds = 10.0, now: number): boolean {
    if (population < 1) return false;
    const required = Math.ceil(population * quorumThreshold);

    let readyCount = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.agentIds[i] !== 0 && this.readyStates[i] === 1) {
        readyCount++;
      }
    }

    if (this.stageStartTime === 0.0) this.stageStartTime = now;

    if (readyCount >= required) {
      this.quorumReached = true;
      return true;
    }

    if (now - this.stageStartTime >= timeoutSeconds) {
      this.quorumReached = false;
      return true;
    }

    return false;
  }

  public reset(): void {
    this.agentIds.fill(0);
    this.readyStates.fill(0);
    this.reportedEtas.fill(0.0);
    this.reportTimes.fill(0.0);
    this.quorumReached = false;
    this.currentPhase = 0;
    this.stageStartTime = 0.0;
  }
}
