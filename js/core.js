/*
 * ExamSeat core logic.
 *
 * Pure functions only (no DOM access), so the same code runs in the browser
 * (as window.ExamCore) and in Node for the automated tests (via require).
 *
 * Exam data shape:
 * {
 *   id, course, date, room, startTime, durationMin, rows, cols, spacing,
 *   layout:       { "r-c": "blocked" | "accessible" },   // missing = normal seat
 *   students:     [{ id, name, accessible }],
 *   seats:        { "r-c": studentId },
 *   attendance:   { studentId: "present" | "absent" },
 *   checkInTimes: { studentId: timestampMs },
 *   keepApart:    [[studentIdA, studentIdB]],
 *   incidents:    [{ id, time, studentId, type, note, auto }],
 *   timer:        { startedAt, durationMin, extraMin, endedAt } | null
 * }
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.ExamCore = core;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STATE_VERSION = 2;
  const MAX_ROWS = 26; // rows are labelled A–Z
  const MAX_COLS = 30;
  const DEFAULT_DURATION_MIN = 120;
  const MINUTE = 60 * 1000;
  const MAX_ATTEMPTS = 300;

  const SEAT_TYPES = ["normal", "blocked", "accessible"];
  const INCIDENT_TYPES = [
    "Late arrival",
    "Washroom break (out)",
    "Washroom break (back)",
    "Left early",
    "Suspected academic misconduct",
    "Medical",
    "Other"
  ];
  const NEIGHBOURS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1]
  ];
  const ACCESSIBLE_FLAG = /^(a|acc|accessible|y|yes|true)$/i;

  function clamp(value, min, max, fallback) {
    const n = Number(value);
    if (value === null || value === "" || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  // ---------------------------------------------------------------- Seats

  function seatKey(row, col) {
    return `${row}-${col}`;
  }

  function parseSeatKey(key) {
    const [row, col] = key.split("-").map(Number);
    return { row, col };
  }

  // Row 0, column 2 -> "A3"
  function seatLabel(row, col) {
    return String.fromCharCode(65 + row) + (col + 1);
  }

  function labelForKey(key) {
    const { row, col } = parseSeatKey(key);
    return seatLabel(row, col);
  }

  function seatType(exam, key) {
    return (exam.layout && exam.layout[key]) || "normal";
  }

  // normal -> blocked -> accessible -> normal
  function nextSeatType(type) {
    const index = SEAT_TYPES.indexOf(type);
    return SEAT_TYPES[(index + 1) % SEAT_TYPES.length];
  }

  // True if two seats touch, including diagonally.
  function areAdjacent(keyA, keyB) {
    if (keyA === keyB) return false;
    const a = parseSeatKey(keyA);
    const b = parseSeatKey(keyB);
    return Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1;
  }

  // Every seat that is not blocked, front row first, left to right.
  function usableSeats(exam) {
    const seats = [];
    for (let row = 0; row < exam.rows; row++) {
      for (let col = 0; col < exam.cols; col++) {
        const key = seatKey(row, col);
        const type = seatType(exam, key);
        if (type !== "blocked") seats.push({ key, row, col, accessible: type === "accessible" });
      }
    }
    return seats;
  }

  function findSeatOf(exam, studentId) {
    for (const [key, id] of Object.entries(exam.seats)) {
      if (id === studentId) return key;
    }
    return null;
  }

  // --------------------------------------------------------------- Random

  // Small seeded random number generator (mulberry32) so tests are repeatable.
  function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fisher–Yates shuffle: every order is equally likely.
  function shuffle(array, rng = Math.random) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // ------------------------------------------------------------- Students

  function cleanField(text) {
    return text.trim().replace(/^"(.*)"$/, "$1").trim();
  }

  /*
   * Accepts lines like:
   *   0712345, Sara Ahmed
   *   0712346, John Lee, A        <- third column marks "needs accessible seat"
   * Skips a header row, lines without a name, and duplicate IDs.
   */
  function parseStudents(text) {
    const students = [];
    const seenIds = new Set();
    let skipped = 0;

    const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    lines.forEach((line, index) => {
      const parts = line.split(",").map(cleanField);
      while (parts.length > 2 && parts[parts.length - 1] === "") parts.pop();

      let accessible = false;
      if (parts.length > 2 && ACCESSIBLE_FLAG.test(parts[parts.length - 1])) {
        accessible = true;
        parts.pop();
      }

      const id = parts[0];
      const name = parts.slice(1).filter(Boolean).join(" ");

      const isHeader = index === 0 && /id/i.test(id) && /name/i.test(name);
      if (isHeader) return;

      if (!id || !name || seenIds.has(id)) {
        skipped++;
        return;
      }
      seenIds.add(id);
      students.push({ id, name, accessible });
    });

    return { students, skipped };
  }

  // After the student list changes, remove data about students who are gone.
  function removeMissingStudents(exam) {
    const ids = new Set(exam.students.map((s) => s.id));
    for (const [key, id] of Object.entries(exam.seats)) {
      if (!ids.has(id)) delete exam.seats[key];
    }
    for (const id of Object.keys(exam.attendance)) {
      if (!ids.has(id)) delete exam.attendance[id];
    }
    for (const id of Object.keys(exam.checkInTimes)) {
      if (!ids.has(id)) delete exam.checkInTimes[id];
    }
    exam.keepApart = exam.keepApart.filter(([a, b]) => ids.has(a) && ids.has(b));
    return exam;
  }

  // -------------------------------------------------------------- Seating

  // [[a, b], [a, c]] -> Map { a => {b, c}, b => {a}, c => {a} }
  function buildApartMap(pairs) {
    const map = new Map();
    for (const [a, b] of pairs) {
      if (!map.has(a)) map.set(a, new Set());
      if (!map.has(b)) map.set(b, new Set());
      map.get(a).add(b);
      map.get(b).add(a);
    }
    return map;
  }

  function seatFits(student, seat, occupied, apart, spacing) {
    if (student.accessible && !seat.accessible) return false;
    const avoid = apart.get(student.id);

    for (const [dr, dc] of NEIGHBOURS) {
      const neighbour = occupied[seatKey(seat.row + dr, seat.col + dc)];
      if (!neighbour) continue;
      if (spacing && dr === 0) return false;              // someone directly beside
      if (avoid && avoid.has(neighbour)) return false;    // keep-apart partner nearby
    }
    return true;
  }

  // Greedy placement: each student takes the first seat (front to back) that breaks no rule.
  function tryAssign(order, seats, apart, spacing) {
    const occupied = {};
    for (const student of order) {
      const seat = seats.find((s) => !occupied[s.key] && seatFits(student, s, occupied, apart, spacing));
      if (!seat) return null;
      occupied[seat.key] = student.id;
    }
    return occupied;
  }

  /*
   * Randomly seats every student while respecting:
   *  - blocked seats (never used)
   *  - accessible seats (students who need one always get one)
   *  - spacing (nobody directly beside another student)
   *  - keep-apart pairs (never next to each other, including diagonally)
   * Returns { ok: true, seats } or { ok: false, error }.
   */
  function assignSeats(exam, options = {}) {
    const rng = options.rng || Math.random;
    const spacing = Boolean(options.spacing);
    const seats = usableSeats(exam);
    const students = exam.students;

    if (students.length === 0) {
      return { ok: false, error: "Add and save students first." };
    }
    if (students.length > seats.length) {
      return {
        ok: false,
        error: `Not enough seats: ${students.length} students but only ${seats.length} usable seats.`
      };
    }
    const needAccessible = students.filter((s) => s.accessible).length;
    const accessibleSeats = seats.filter((s) => s.accessible).length;
    if (needAccessible > accessibleSeats) {
      return {
        ok: false,
        error: `${needAccessible} student(s) need an accessible seat but the room has ${accessibleSeats}. ` +
          `Mark more seats as accessible in Edit layout.`
      };
    }

    const apart = buildApartMap(exam.keepApart || []);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const order = shuffle([...students], rng);
      // Students who need accessible seats go first so those seats are still free.
      order.sort((a, b) => Number(b.accessible) - Number(a.accessible));
      const result = tryAssign(order, seats, apart, spacing);
      if (result) return { ok: true, seats: result };
    }

    return {
      ok: false,
      error: "Couldn't find a seating that follows every rule. Try turning off spacing, " +
        "removing a keep-apart pair, or unblocking some seats."
    };
  }

  // Move the student in fromKey to toKey. If toKey is taken, the two students swap.
  function moveStudent(seats, fromKey, toKey) {
    const next = { ...seats };
    const moving = next[fromKey];
    if (!moving || fromKey === toKey) return next;
    const other = next[toKey];
    next[toKey] = moving;
    if (other) next[fromKey] = other;
    else delete next[fromKey];
    return next;
  }

  // Rule breaks in the current seating (e.g. after a manual drag). [{ message, keys }]
  function seatingProblems(exam) {
    const problems = [];
    const byId = new Map(exam.students.map((s) => [s.id, s]));

    for (const [key, id] of Object.entries(exam.seats)) {
      const student = byId.get(id);
      if (!student) continue;
      const type = seatType(exam, key);
      if (type === "blocked") {
        problems.push({ message: `${student.name} is in a blocked seat (${labelForKey(key)}).`, keys: [key] });
      }
      if (student.accessible && type !== "accessible") {
        problems.push({ message: `${student.name} needs an accessible seat (now in ${labelForKey(key)}).`, keys: [key] });
      }
    }

    if (exam.spacing) {
      for (const [key, id] of Object.entries(exam.seats)) {
        const { row, col } = parseSeatKey(key);
        const rightKey = seatKey(row, col + 1);
        const rightId = exam.seats[rightKey];
        if (rightId && byId.has(id) && byId.has(rightId)) {
          problems.push({
            message: `${byId.get(id).name} and ${byId.get(rightId).name} are side by side (spacing is on).`,
            keys: [key, rightKey]
          });
        }
      }
    }

    for (const [a, b] of exam.keepApart) {
      const keyA = findSeatOf(exam, a);
      const keyB = findSeatOf(exam, b);
      if (keyA && keyB && areAdjacent(keyA, keyB)) {
        const nameA = byId.get(a) ? byId.get(a).name : a;
        const nameB = byId.get(b) ? byId.get(b).name : b;
        problems.push({ message: `${nameA} and ${nameB} should be kept apart but are sitting together.`, keys: [keyA, keyB] });
      }
    }
    return problems;
  }

  // ----------------------------------------------------------- Attendance

  function isLate(exam, studentId) {
    const timer = exam.timer;
    const checkedInAt = exam.checkInTimes[studentId];
    return Boolean(
      timer && timer.startedAt && checkedInAt &&
      exam.attendance[studentId] === "present" &&
      checkedInAt > timer.startedAt
    );
  }

  function attendanceSummary(exam) {
    const total = exam.students.length;
    let present = 0;
    let absent = 0;
    let late = 0;
    for (const s of exam.students) {
      const status = exam.attendance[s.id];
      if (status === "present") present++;
      if (status === "absent") absent++;
      if (isLate(exam, s.id)) late++;
    }
    const seated = new Set(Object.values(exam.seats)).size;
    return {
      total, present, absent, late, seated,
      notCheckedIn: total - present - absent,
      incidents: exam.incidents.length
    };
  }

  // Exact ID match wins (card scanners type the full ID). Otherwise partial name/ID match.
  function searchStudents(students, query, limit = 8) {
    const q = String(query).trim().toLowerCase();
    if (!q) return [];
    const exact = students.find((s) => s.id.toLowerCase() === q);
    if (exact) return [exact];
    return students
      .filter((s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      .slice(0, limit);
  }

  // ---------------------------------------------------------------- Timer

  /*
   * status: "idle" (not started) | "running" | "timeup" (time ran out) | "ended" (proctor ended it)
   * level:  "normal" | "warning" (≤ 15 min left) | "danger" (≤ 5 min left or time's up)
   */
  function timerInfo(timer, now = Date.now()) {
    if (!timer || !timer.startedAt) {
      return { status: "idle", level: "normal", remainingMs: 0, elapsedMs: 0, totalMs: 0, endsAt: null };
    }
    const totalMs = ((Number(timer.durationMin) || 0) + (Number(timer.extraMin) || 0)) * MINUTE;
    const stop = timer.endedAt || now;
    const elapsedMs = Math.max(0, stop - timer.startedAt);
    const remainingMs = Math.max(0, totalMs - elapsedMs);

    let status = "running";
    if (timer.endedAt) status = "ended";
    else if (remainingMs === 0) status = "timeup";

    let level = "normal";
    if (status === "timeup") level = "danger";
    else if (status === "running" && remainingMs <= 5 * MINUTE) level = "danger";
    else if (status === "running" && remainingMs <= 15 * MINUTE) level = "warning";

    return { status, level, remainingMs, elapsedMs, totalMs, endsAt: timer.startedAt + totalMs };
  }

  function minutesIntoExam(exam, time) {
    if (!exam.timer || !exam.timer.startedAt) return null;
    return Math.floor((time - exam.timer.startedAt) / MINUTE);
  }

  // 3725000 -> "1:02:05", 65000 -> "01:05"
  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // ------------------------------------------------------------------ CSV

  function csvField(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(rows) {
    return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
  }

  const isoTime = (ms) => new Date(ms).toISOString();

  // Attendance rows in seat order (front row first). Unseated students go last.
  function attendanceRows(exam, formatTime = isoTime) {
    const rows = exam.students
      .map((student) => {
        const key = findSeatOf(exam, student.id);
        const pos = key ? parseSeatKey(key) : null;
        return { student, key, order: pos ? pos.row * exam.cols + pos.col : 1e9 };
      })
      .sort((a, b) => a.order - b.order);

    return [
      ["Seat", "Student ID", "Name", "Needs accessible seat", "Status", "Check-in time", "Late"],
      ...rows.map(({ student, key }) => [
        key ? labelForKey(key) : "",
        student.id,
        student.name,
        student.accessible ? "yes" : "no",
        exam.attendance[student.id] || "not checked in",
        exam.checkInTimes[student.id] ? formatTime(exam.checkInTimes[student.id]) : "",
        isLate(exam, student.id) ? "yes" : "no"
      ])
    ];
  }

  function incidentRows(exam, formatTime = isoTime) {
    const byId = new Map(exam.students.map((s) => [s.id, s]));
    const sorted = [...exam.incidents].sort((a, b) => a.time - b.time);
    return [
      ["Time", "Minutes into exam", "Student ID", "Name", "Seat", "Type", "Note"],
      ...sorted.map((incident) => {
        const student = incident.studentId ? byId.get(incident.studentId) : null;
        const key = incident.studentId ? findSeatOf(exam, incident.studentId) : null;
        const minutes = minutesIntoExam(exam, incident.time);
        return [
          formatTime(incident.time),
          minutes === null ? "" : minutes,
          incident.studentId || "",
          student ? student.name : "",
          key ? labelForKey(key) : "",
          incident.type,
          incident.note
        ];
      })
    ];
  }

  // ---------------------------------------------------------------- State

  function plainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  }

  // Fills in defaults and fixes types, so old (v1) data and backups always load safely.
  function normalizeExam(raw) {
    const e = raw || {};
    const timer = e.timer && e.timer.startedAt
      ? {
          startedAt: Number(e.timer.startedAt),
          durationMin: clamp(e.timer.durationMin, 1, 600, DEFAULT_DURATION_MIN),
          extraMin: clamp(e.timer.extraMin, 0, 600, 0),
          endedAt: e.timer.endedAt ? Number(e.timer.endedAt) : null
        }
      : null;

    return {
      id: String(e.id || ""),
      course: String(e.course || "Untitled exam"),
      date: String(e.date || ""),
      room: String(e.room || ""),
      startTime: String(e.startTime || ""),
      durationMin: clamp(e.durationMin, 1, 600, DEFAULT_DURATION_MIN),
      rows: clamp(e.rows, 1, MAX_ROWS, 6),
      cols: clamp(e.cols, 1, MAX_COLS, 8),
      spacing: Boolean(e.spacing),
      layout: plainObject(e.layout),
      students: Array.isArray(e.students)
        ? e.students
            .filter((s) => s && s.id && s.name)
            .map((s) => ({ id: String(s.id), name: String(s.name), accessible: Boolean(s.accessible) }))
        : [],
      seats: plainObject(e.seats),
      attendance: plainObject(e.attendance),
      checkInTimes: plainObject(e.checkInTimes),
      keepApart: Array.isArray(e.keepApart)
        ? e.keepApart.filter((p) => Array.isArray(p) && p.length === 2).map(([a, b]) => [String(a), String(b)])
        : [],
      incidents: Array.isArray(e.incidents)
        ? e.incidents
            .filter((i) => i && i.time)
            .map((i) => ({
              id: String(i.id || i.time),
              time: Number(i.time),
              studentId: i.studentId ? String(i.studentId) : null,
              type: String(i.type || "Other"),
              note: String(i.note || ""),
              auto: Boolean(i.auto)
            }))
        : [],
      timer
    };
  }

  function migrateState(raw) {
    if (!raw || !Array.isArray(raw.exams)) {
      return { version: STATE_VERSION, currentId: null, exams: [] };
    }
    const exams = raw.exams.filter((e) => e && e.id).map(normalizeExam);
    const currentId = exams.some((e) => e.id === raw.currentId) ? raw.currentId : (exams[0] ? exams[0].id : null);
    return { version: STATE_VERSION, currentId, exams };
  }

  return {
    STATE_VERSION, MAX_ROWS, MAX_COLS, INCIDENT_TYPES, SEAT_TYPES,
    clamp, seatKey, parseSeatKey, seatLabel, labelForKey, seatType, nextSeatType,
    areAdjacent, usableSeats, findSeatOf,
    seededRandom, shuffle,
    parseStudents, removeMissingStudents,
    assignSeats, moveStudent, seatingProblems,
    isLate, attendanceSummary, searchStudents,
    timerInfo, minutesIntoExam, formatDuration,
    csvField, toCsv, attendanceRows, incidentRows,
    normalizeExam, migrateState
  };
});
