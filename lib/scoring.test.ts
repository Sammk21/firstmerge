import { describe, it } from "node:test";
import assert from "node:assert";
import { computeMergeScore, type ScoreSignals } from "./scoring";

function base(): ScoreSignals {
  return {
    isAssigned: false,
    hasLinkedPr: false,
    comments: 2,
    createdAt: new Date().toISOString(),
    prMergeRate90d: 0.6,
    medianResponseHrs: 24,
    lastCommitAt: new Date().toISOString(),
  };
}

describe("computeMergeScore", () => {
  describe("availability", () => {
    it("scores an unclaimed issue higher than an assigned one", () => {
      const unclaimed = computeMergeScore({ ...base(), isAssigned: false, hasLinkedPr: false });
      const assigned = computeMergeScore({ ...base(), isAssigned: true, hasLinkedPr: false });
      assert.ok(unclaimed.score > assigned.score,
        `unclaimed ${unclaimed.score} should be > assigned ${assigned.score}`);
    });

    it("penalises having a linked PR", () => {
      const result = computeMergeScore({ ...base(), hasLinkedPr: true });
      assert.ok(result.reasons.some((r) => r.toLowerCase().includes("open pr")),
        `expected reason about open PR, got: ${result.reasons.join("; ")}`);
    });
  });

  describe("maintainer merge rate", () => {
    it("boosts score for high prMergeRate90d (>= 0.5)", () => {
      const low = computeMergeScore({ ...base(), prMergeRate90d: 0.1 });
      const high = computeMergeScore({ ...base(), prMergeRate90d: 0.8 });
      assert.ok(high.score > low.score,
        `high merge rate score ${high.score} should be > low ${low.score}`);
    });

    it("lowers score for low prMergeRate90d (< 0.2)", () => {
      const result = computeMergeScore({ ...base(), prMergeRate90d: 0.05 });
      assert.ok(result.reasons.some((r) => r.toLowerCase().includes("rarely")),
        `expected "rarely" reason, got: ${result.reasons.join("; ")}`);
    });
  });

  describe("band thresholds", () => {
    function signalWithScore(targetScore: number): ScoreSignals {
      return {
        ...base(),
        isAssigned: false,
        hasLinkedPr: false,
        comments: targetScore >= 65 ? 2 : targetScore >= 40 ? 30 : 50,
        createdAt: targetScore >= 65
          ? new Date().toISOString()
          : targetScore >= 40
            ? new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
            : new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      };
    }

    it("returns green for score >= 65", () => {
      // a fresh, low-comment, high-merge-rate unclaimed issue
      const result = computeMergeScore({
        isAssigned: false,
        hasLinkedPr: false,
        comments: 0,
        createdAt: new Date().toISOString(),
        prMergeRate90d: 0.9,
        medianResponseHrs: 10,
        lastCommitAt: new Date().toISOString(),
      });
      assert.ok(result.score >= 65, `expected score >= 65, got ${result.score}`);
      assert.strictEqual(result.band, "green");
    });

    it("returns yellow for score >= 40 and < 65", () => {
      // unclaimed, medium merge rate, slow response, moderate repo activity
      const result = computeMergeScore({
        isAssigned: false,
        hasLinkedPr: false,
        comments: 5,
        createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
        prMergeRate90d: 0.25,
        medianResponseHrs: 200,
        lastCommitAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      });
      assert.ok(result.score >= 40 && result.score < 65,
        `expected 40 <= score < 65, got ${result.score}`);
      assert.strictEqual(result.band, "yellow");
    });

    it("returns red for score < 40", () => {
      const result = computeMergeScore({
        isAssigned: true,
        hasLinkedPr: false,
        comments: 50,
        createdAt: "2020-01-01T00:00:00Z",
        prMergeRate90d: 0.02,
        medianResponseHrs: 500,
        lastCommitAt: "2020-01-01T00:00:00Z",
      });
      assert.ok(result.score < 40, `expected score < 40, got ${result.score}`);
      assert.strictEqual(result.band, "red");
    });
  });

  describe("null signals (unknown repo data)", () => {
    it("handles all null signals without crashing", () => {
      assert.doesNotThrow(() => {
        computeMergeScore({
          isAssigned: false,
          hasLinkedPr: false,
          comments: 1,
          createdAt: new Date().toISOString(),
          prMergeRate90d: null,
          medianResponseHrs: null,
          lastCommitAt: null,
        });
      });
    });

    it("caps band at yellow when maintainer data is unknown", () => {
      const result = computeMergeScore({
        isAssigned: false,
        hasLinkedPr: false,
        comments: 0,
        createdAt: new Date().toISOString(),
        prMergeRate90d: null,
        medianResponseHrs: null,
        lastCommitAt: new Date().toISOString(),
      });
      // even with good freshness / liveness signals, unknown maintainer caps at yellow
      assert.notStrictEqual(result.band, "green",
        `band should be yellow or red, got ${result.band}`);
    });

    it("all-null baseline returns a numeric score in 0..100", () => {
      const result = computeMergeScore({
        isAssigned: false,
        hasLinkedPr: false,
        comments: 0,
        createdAt: null,
        prMergeRate90d: null,
        medianResponseHrs: null,
        lastCommitAt: null,
      });
      assert.ok(result.score >= 0 && result.score <= 100,
        `score ${result.score} out of bounds`);
      assert.ok(Number.isFinite(result.score), `score ${result.score} is not finite`);
    });
  });

  describe("freshness", () => {
    it("boosts score for recently opened issues", () => {
      const recent = computeMergeScore({ ...base(), createdAt: new Date().toISOString() });
      const stale = computeMergeScore({ ...base(), createdAt: "2023-01-01T00:00:00Z" });
      assert.ok(recent.score > stale.score,
        `recent ${recent.score} should be > stale ${stale.score}`);
    });
  });

  describe("comments", () => {
    it("penalises long comment threads (>= 25 comments)", () => {
      const few = computeMergeScore({ ...base(), comments: 2 });
      const many = computeMergeScore({ ...base(), comments: 40 });
      assert.ok(few.score > many.score,
        `few-comments ${few.score} should be > many-comments ${many.score}`);
    });
  });

  describe("repo liveness", () => {
    it("boosts score for recently committed repos", () => {
      const active = computeMergeScore({ ...base(), lastCommitAt: new Date().toISOString() });
      const dead = computeMergeScore({
        ...base(),
        lastCommitAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      });
      assert.ok(active.score > dead.score,
        `active ${active.score} should be > dead ${dead.score}`);
    });
  });

  describe("result shape", () => {
    it("returns score, band, and reasons array", () => {
      const result = computeMergeScore(base());
      assert.strictEqual(typeof result.score, "number");
      assert.ok(["green", "yellow", "red"].includes(result.band));
      assert.ok(Array.isArray(result.reasons));
      assert.ok(result.reasons.every((r) => typeof r === "string"));
    });

    it("score is always clamped within 0..100", () => {
      // extreme negative signals
      const terrible = computeMergeScore({
        isAssigned: true,
        hasLinkedPr: true,
        comments: 100,
        createdAt: "2020-01-01T00:00:00Z",
        prMergeRate90d: 0,
        medianResponseHrs: 1000,
        lastCommitAt: "2020-01-01T00:00:00Z",
      });
      assert.ok(terrible.score >= 0, `terrible score ${terrible.score} should be >= 0`);

      // extreme positive signals (but claimed, so capped)
      const perfect = computeMergeScore({
        isAssigned: false,
        hasLinkedPr: false,
        comments: 0,
        createdAt: new Date().toISOString(),
        prMergeRate90d: 1,
        medianResponseHrs: 0.1,
        lastCommitAt: new Date().toISOString(),
      });
      assert.ok(perfect.score <= 100, `perfect score ${perfect.score} should be <= 100`);
    });
  });
});
