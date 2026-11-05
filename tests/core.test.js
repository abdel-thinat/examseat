// Run with: npm test   (uses Node's built-in test runner, no installs needed)
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../js/core.js");

const MINUTE = 60 * 1000;

function makeStudents(count, accessibleCount = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(1000 + i),
    name: `Student ${i}`,
    accessible: i < accessibleCount
  }));
}

function makeExam(overrides = {}) {
  return Core.normalizeExam({ id: "e1", course: "TEST 101", date: "2026-12-10", room: "R1", rows: 4, cols: 6, ...overrides });
}

// ---------- Students ----------

test("parseStudents reads IDs, names and the accessible flag", () => {
  const { students, skipped } = Core.parseStudents(
    "Student ID,Name,Accessible\n0710001, Sara Ahmed,\n0710002,John Lee,yes\n\"0710003\",\"Maria Garcia\""
  );
  assert.equal(skipped, 0);
  assert.deepEqual(students, [
    { id: "0710001", name: "Sara Ahmed", accessible: false },
    { id: "0710002", name: "John Lee", accessible: true },
    { id: "0710003", name: "Maria Garcia", accessible: false }
  ]);
});

test("parseStudents skips blank names and duplicate IDs", () => {
  const { students, skipped } = Core.parseStudents("1, Ann\n1, Duplicate\n2,\n\n3, Bob, A");
  assert.deepEqual(students.map((s) => s.id), ["1", "3"]);
  assert.equal(students[1].accessible, true);
  assert.equal(skipped, 2);
});

test("removeMissingStudents cleans seats, attendance and keep-apart pairs", () => {
  const exam = makeExam({
    students: [{ id: "a", name: "A" }],
    seats: { "0-0": "a", "0-1": "gone" },
    attendance: { a: "present", gone: "absent" },
    checkInTimes: { gone: 1 },
    keepApart: [["a", "gone"]]
  });
  Core.removeMissingStudents(exam);
  assert.deepEqual(exam.seats, { "0-0": "a" });
  assert.deepEqual(exam.attendance, { a: "present" });
  assert.deepEqual(exam.checkInTimes, {});
  assert.deepEqual(exam.keepApart, []);
});

// ---------- Seats ----------

test("seat labels use row letters and 1-based columns", () => {
  assert.equal(Core.seatLabel(0, 0), "A1");
  assert.equal(Core.seatLabel(2, 9), "C10");
  assert.equal(Core.labelForKey("1-3"), "B4");
});

test("areAdjacent includes diagonals but not the same seat", () => {
  assert.equal(Core.areAdjacent("1-1", "2-2"), true);
  assert.equal(Core.areAdjacent("1-1", "1-3"), false);
  assert.equal(Core.areAdjacent("1-1", "1-1"), false);
});

test("nextSeatType cycles normal -> blocked -> accessible -> normal", () => {
  assert.equal(Core.nextSeatType("normal"), "blocked");
  assert.equal(Core.nextSeatType("blocked"), "accessible");
  assert.equal(Core.nextSeatType("accessible"), "normal");
});

// ---------- Seating ----------

test("assignSeats seats every student once and never uses blocked seats", () => {
  const exam = makeExam({ students: makeStudents(18), layout: { "0-0": "blocked", "1-3": "blocked" } });
  const result = Core.assignSeats(exam, { rng: Core.seededRandom(1) });
  assert.equal(result.ok, true);
  const ids = Object.values(result.seats);
  assert.equal(ids.length, 18);
  assert.equal(new Set(ids).size, 18);
  assert.equal(result.seats["0-0"], undefined);
  assert.equal(result.seats["1-3"], undefined);
});

test("assignSeats with spacing never puts two students side by side", () => {
  const exam = makeExam({ students: makeStudents(12) });
  const result = Core.assignSeats(exam, { spacing: true, rng: Core.seededRandom(2) });
  assert.equal(result.ok, true);
  for (const key of Object.keys(result.seats)) {
    const { row, col } = Core.parseSeatKey(key);
    assert.equal(result.seats[Core.seatKey(row, col + 1)], undefined, `seat ${key} has a neighbour`);
  }
});

test("students who need accessible seats always get one", () => {
  const layout = { "3-0": "accessible", "3-5": "accessible" };
  for (let seed = 0; seed < 20; seed++) {
    const exam = makeExam({ students: makeStudents(10, 2), layout });
    const result = Core.assignSeats(exam, { rng: Core.seededRandom(seed) });
    assert.equal(result.ok, true);
    exam.seats = result.seats;
    for (const s of exam.students.filter((x) => x.accessible)) {
      assert.equal(Core.seatType(exam, Core.findSeatOf(exam, s.id)), "accessible");
    }
  }
});

test("keep-apart pairs are never next to each other", () => {
  const students = makeStudents(20);
  const keepApart = [["1000", "1001"], ["1000", "1002"], ["1003", "1004"]];
  for (let seed = 0; seed < 50; seed++) {
    const exam = makeExam({ students, keepApart });
    const result = Core.assignSeats(exam, { rng: Core.seededRandom(seed) });
    assert.equal(result.ok, true);
    exam.seats = result.seats;
    assert.deepEqual(Core.seatingProblems(exam), []);
  }
});

test("assignSeats explains when it cannot seat everyone", () => {
  const tooMany = Core.assignSeats(makeExam({ rows: 2, cols: 2, students: makeStudents(5) }));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /Not enough seats/);

  const noAccessible = Core.assignSeats(makeExam({ students: makeStudents(3, 1) }));
  assert.equal(noAccessible.ok, false);
  assert.match(noAccessible.error, /accessible/);

  const none = Core.assignSeats(makeExam());
  assert.equal(none.ok, false);
});

test("moveStudent moves to an empty seat or swaps two students", () => {
  assert.deepEqual(Core.moveStudent({ "0-0": "a" }, "0-0", "1-1"), { "1-1": "a" });
  assert.deepEqual(Core.moveStudent({ "0-0": "a", "1-1": "b" }, "0-0", "1-1"), { "0-0": "b", "1-1": "a" });
});

test("seatingProblems catches rule breaks after a manual move", () => {
  const exam = makeExam({
    students: [{ id: "a", name: "Ann" }, { id: "b", name: "Bob" }, { id: "c", name: "Cy", accessible: true }],
    seats: { "0-0": "a", "0-1": "b", "2-2": "c" },
    keepApart: [["a", "b"]],
    layout: {}
  });
  const messages = Core.seatingProblems(exam).map((p) => p.message);
  assert.equal(messages.length, 2);
  assert.ok(messages.some((m) => m.includes("kept apart")));
  assert.ok(messages.some((m) => m.includes("accessible")));
});

test("seatingProblems flags side-by-side students when spacing is on", () => {
  const exam = makeExam({
    spacing: true,
    students: [{ id: "a", name: "Ann" }, { id: "b", name: "Bob" }],
    seats: { "0-0": "a", "0-1": "b" }
  });
  assert.equal(Core.seatingProblems(exam).length, 1);
  exam.spacing = false;
  assert.equal(Core.seatingProblems(exam).length, 0);
});

// ---------- Attendance & search ----------

test("searchStudents prefers an exact ID match", () => {
  const students = [{ id: "123", name: "Ann" }, { id: "1234", name: "Bob" }, { id: "9", name: "Annie" }];
  assert.deepEqual(Core.searchStudents(students, "123").map((s) => s.id), ["123"]);
  assert.deepEqual(Core.searchStudents(students, "ANN").map((s) => s.id), ["123", "9"]);
  assert.deepEqual(Core.searchStudents(students, "  "), []);
});

test("late arrivals are students checked in after the timer started", () => {
  const exam = makeExam({
    students: makeStudents(3),
    attendance: { 1000: "present", 1001: "present", 1002: "absent" },
    checkInTimes: { 1000: 1000, 1001: 5000 },
    timer: { startedAt: 2000, durationMin: 60 }
  });
  assert.equal(Core.isLate(exam, "1000"), false);
  assert.equal(Core.isLate(exam, "1001"), true);
  const summary = Core.attendanceSummary(exam);
  assert.deepEqual(
    [summary.present, summary.absent, summary.late, summary.notCheckedIn],
    [2, 1, 1, 0]
  );
});

// ---------- Timer ----------

test("timerInfo reports status and warning levels", () => {
  const start = 1_000_000;
  const timer = { startedAt: start, durationMin: 60, extraMin: 0, endedAt: null };

  assert.equal(Core.timerInfo(null).status, "idle");

  const early = Core.timerInfo(timer, start + 10 * MINUTE);
  assert.equal(early.status, "running");
  assert.equal(early.level, "normal");
  assert.equal(early.remainingMs, 50 * MINUTE);

  assert.equal(Core.timerInfo(timer, start + 50 * MINUTE).level, "warning");
  assert.equal(Core.timerInfo(timer, start + 56 * MINUTE).level, "danger");
  assert.equal(Core.timerInfo(timer, start + 61 * MINUTE).status, "timeup");

  const extended = Core.timerInfo({ ...timer, extraMin: 5 }, start + 61 * MINUTE);
  assert.equal(extended.status, "running");
  assert.equal(extended.remainingMs, 4 * MINUTE);

  const ended = Core.timerInfo({ ...timer, endedAt: start + 30 * MINUTE }, start + 90 * MINUTE);
  assert.equal(ended.status, "ended");
  assert.equal(ended.elapsedMs, 30 * MINUTE);
});

test("formatDuration shows h:mm:ss or mm:ss", () => {
  assert.equal(Core.formatDuration(65_000), "01:05");
  assert.equal(Core.formatDuration(3_725_000), "1:02:05");
  assert.equal(Core.formatDuration(-5), "00:00");
});

// ---------- CSV ----------

test("toCsv escapes commas, quotes and new lines", () => {
  assert.equal(Core.toCsv([["a", "b,c"], ['say "hi"', "x\ny"]]), 'a,"b,c"\r\n"say ""hi""","x\ny"');
});

test("attendanceRows are in seat order with unseated students last", () => {
  const exam = makeExam({
    students: [{ id: "a", name: "Ann" }, { id: "b", name: "Bob" }, { id: "c", name: "Cy" }],
    seats: { "1-0": "a", "0-2": "b" },
    attendance: { b: "present" },
    checkInTimes: { b: 0 }
  });
  const rows = Core.attendanceRows(exam);
  assert.deepEqual(rows.slice(1).map((r) => [r[0], r[1], r[4]]), [
    ["A3", "b", "present"],
    ["B1", "a", "not checked in"],
    ["", "c", "not checked in"]
  ]);
});

test("incidentRows include minutes into the exam", () => {
  const exam = makeExam({
    students: [{ id: "a", name: "Ann" }],
    seats: { "0-0": "a" },
    timer: { startedAt: 100 * MINUTE, durationMin: 60 },
    incidents: [{ id: "1", time: 112 * MINUTE, studentId: "a", type: "Late arrival", note: "" }]
  });
  const [, row] = Core.incidentRows(exam);
  assert.deepEqual(row.slice(1), [12, "a", "Ann", "A1", "Late arrival", ""]);
});

// ---------- State ----------

test("migrateState upgrades version 1 data", () => {
  const v1 = {
    currentId: "x",
    exams: [{
      id: "x", course: "OLD 100", date: "2026-01-01", room: "R", rows: 5, cols: 5,
      students: [{ id: "1", name: "Ann" }], seats: { "0-0": "1" }, attendance: { 1: "present" }
    }]
  };
  const state = Core.migrateState(v1);
  assert.equal(state.version, 2);
  assert.equal(state.currentId, "x");
  const exam = state.exams[0];
  assert.deepEqual(exam.layout, {});
  assert.deepEqual(exam.keepApart, []);
  assert.deepEqual(exam.incidents, []);
  assert.equal(exam.timer, null);
  assert.equal(exam.students[0].accessible, false);
  assert.equal(exam.durationMin, 120);
});

test("migrateState handles empty or broken data", () => {
  assert.deepEqual(Core.migrateState(null), { version: 2, currentId: null, exams: [] });
  assert.deepEqual(Core.migrateState({ exams: "nope" }).exams, []);
});
