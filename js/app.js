/*
 * ExamSeat — browser UI.
 * This file handles the page (events, rendering, saving).
 * The rules and calculations live in core.js (window.ExamCore), which has unit tests.
 */
(function () {
  "use strict";

  const Core = window.ExamCore;
  const STORAGE_KEY = "examseat-data";
  const OLD_STORAGE_KEY = "examseat-data-v1"; // data from version 1 is upgraded automatically
  const THEME_KEY = "examseat-theme";

  let state = loadState();
  let activeTab = "setup";        // "setup" | "examday" | "report"
  let gridMode = "checkin";       // "checkin" | "layout"
  let highlighted = new Set();    // seat keys highlighted by a search
  let dragFromKey = null;         // seat a student is being dragged from
  let toastTimer = null;

  // =============================================================== Storage

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(OLD_STORAGE_KEY);
      if (saved) return Core.migrateState(JSON.parse(saved));
    } catch (err) {
      console.warn("Could not load saved data:", err);
    }
    return Core.migrateState(null);
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn("Could not save data:", err);
      toast("Couldn't save. Your browser storage may be full or disabled.", "error");
    }
  }

  // =============================================================== Helpers

  const $ = (id) => document.getElementById(id);

  // Creates an element. Text is set with textContent, so student names can't inject HTML.
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, onClick) {
    const b = el("button", className, text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function currentExam() {
    return state.exams.find((exam) => exam.id === state.currentId) || null;
  }

  function studentById(exam, id) {
    return exam.students.find((s) => s.id === id) || null;
  }

  function seatNameOf(exam, studentId) {
    const key = Core.findSeatOf(exam, studentId);
    return key ? Core.labelForKey(key) : "no seat";
  }

  function formatDate(isoDate) {
    if (!isoDate) return "";
    const [y, m, d] = isoDate.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: "short", year: "numeric", month: "short", day: "numeric"
    });
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function formatClock(hhmm) {
    if (!hhmm) return "";
    const [h, m] = hhmm.split(":").map(Number);
    return formatTime(new Date(2000, 0, 1, h, m).getTime());
  }

  function setMessage(id, text, kind = "") {
    const node = $(id);
    node.textContent = text;
    node.className = "message " + kind;
  }

  function toast(text, kind = "info") {
    const node = $("toast");
    node.textContent = text;
    node.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename.replace(/[^\w.-]+/g, "_");
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  // Save and redraw after every change.
  function commit() {
    saveState();
    render();
  }

  // ================================================================= Theme

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $("theme-toggle").textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* ignore */ }
  }

  // ================================================================= Exams

  function createExam(form) {
    const data = new FormData(form);
    const exam = Core.normalizeExam({
      id: makeId(),
      course: data.get("course").trim(),
      room: data.get("room").trim(),
      date: data.get("date"),
      startTime: data.get("startTime"),
      durationMin: data.get("durationMin"),
      rows: data.get("rows"),
      cols: data.get("cols")
    });
    state.exams.push(exam);
    form.reset();
    selectExam(exam.id);
    toast(`Created ${exam.course}. Add students next.`, "success");
  }

  function selectExam(id) {
    state.currentId = id;
    const exam = currentExam();
    const timer = exam ? Core.timerInfo(exam.timer) : null;
    activeTab = timer && (timer.status === "running" || timer.status === "timeup") ? "examday" : "setup";
    gridMode = "checkin";
    highlighted = new Set();

    $("student-input").value = exam
      ? exam.students.map((s) => `${s.id}, ${s.name}${s.accessible ? ", A" : ""}`).join("\n")
      : "";
    $("search-input").value = "";
    for (const id of ["student-message", "seat-message", "apart-message"]) setMessage(id, "");
    commit();
  }

  function deleteExam() {
    const exam = currentExam();
    if (!exam) return;
    if (!confirm(`Delete "${exam.course}" and all its data? This cannot be undone.`)) return;
    state.exams = state.exams.filter((e) => e.id !== exam.id);
    selectExam(state.exams.length ? state.exams[0].id : null);
    toast("Exam deleted.");
  }

  // ============================================================== Students

  function saveStudents() {
    const exam = currentExam();
    if (!exam) return;
    const { students, skipped } = Core.parseStudents($("student-input").value);
    exam.students = students;
    Core.removeMissingStudents(exam);
    commit();

    const accessible = students.filter((s) => s.accessible).length;
    let message = `Saved ${students.length} student(s)` +
      (accessible ? `, ${accessible} needing an accessible seat.` : ".");
    if (skipped) message += ` Skipped ${skipped} line(s) with a missing name or a duplicate ID.`;
    setMessage("student-message", message, skipped ? "error" : "success");
  }

  async function uploadCsv(file) {
    if (!file) return;
    $("student-input").value = await file.text();
    saveStudents();
  }

  function addKeepApart() {
    const exam = currentExam();
    const a = $("apart-a").value;
    const b = $("apart-b").value;
    if (!a || !b) return setMessage("apart-message", "Pick two students.", "error");
    if (a === b) return setMessage("apart-message", "Pick two different students.", "error");
    const exists = exam.keepApart.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    if (exists) return setMessage("apart-message", "That pair is already on the list.", "error");

    exam.keepApart.push([a, b]);
    commit();
    setMessage("apart-message", "Added. Click Auto-assign to apply it.", "success");
  }

  function removeKeepApart(index) {
    const exam = currentExam();
    exam.keepApart.splice(index, 1);
    commit();
  }

  // =============================================================== Seating

  function autoAssign() {
    const exam = currentExam();
    if (!exam) return;
    if (Object.keys(exam.seats).length > 0 &&
        !confirm("Reassign all seats? The current seating will be replaced.")) {
      return;
    }
    const result = Core.assignSeats(exam, { spacing: exam.spacing });
    if (!result.ok) {
      setMessage("seat-message", result.error, "error");
      return;
    }
    exam.seats = result.seats;
    highlighted = new Set();
    commit();
    setMessage("seat-message", `Seated ${exam.students.length} students randomly. Drag students to adjust.`, "success");
  }

  function onSeatClick(key) {
    const exam = currentExam();
    if (!exam) return;

    if (gridMode === "layout") {
      const next = Core.nextSeatType(Core.seatType(exam, key));
      if (next === "normal") delete exam.layout[key];
      else exam.layout[key] = next;

      if (next === "blocked" && exam.seats[key]) {
        const student = studentById(exam, exam.seats[key]);
        delete exam.seats[key];
        toast(`${student ? student.name : "A student"} was unseated because ${Core.labelForKey(key)} is now blocked.`, "warning");
      }
      commit();
      return;
    }

    // Check-in mode: not checked in -> present -> absent -> not checked in
    const studentId = exam.seats[key];
    if (!studentId) return;
    const status = exam.attendance[studentId];
    const next = !status ? "present" : status === "present" ? "absent" : null;
    setStatus(exam, studentId, next);
    commit();
  }

  function onDrop(toKey) {
    const exam = currentExam();
    const fromKey = dragFromKey;
    dragFromKey = null;
    if (!exam || !fromKey || fromKey === toKey) return;
    if (Core.seatType(exam, toKey) === "blocked") {
      toast("That seat is blocked.", "warning");
      return;
    }
    const swapped = Boolean(exam.seats[toKey]);
    exam.seats = Core.moveStudent(exam.seats, fromKey, toKey);
    highlighted = new Set([toKey]);
    commit();

    const problems = Core.seatingProblems(exam);
    if (problems.length) toast(`Moved, but: ${problems[0].message}`, "warning");
    else toast(swapped ? `Swapped ${Core.labelForKey(fromKey)} and ${Core.labelForKey(toKey)}.` : `Moved to ${Core.labelForKey(toKey)}.`, "success");
  }

  // ============================================================ Attendance

  function setStatus(exam, studentId, status) {
    // Remove any automatic "late arrival" entry; it is re-added below if still true.
    exam.incidents = exam.incidents.filter((i) => !(i.auto && i.studentId === studentId));

    if (!status) {
      delete exam.attendance[studentId];
      delete exam.checkInTimes[studentId];
      return;
    }

    exam.attendance[studentId] = status;
    if (status !== "present") {
      delete exam.checkInTimes[studentId];
      return;
    }

    const now = Date.now();
    exam.checkInTimes[studentId] = now;
    const timer = Core.timerInfo(exam.timer, now);
    if (timer.status === "running" || timer.status === "timeup") {
      exam.incidents.push({
        id: makeId(),
        time: now,
        studentId,
        type: "Late arrival",
        note: `Checked in ${Math.floor(timer.elapsedMs / 60000)} min after start`,
        auto: true
      });
    }
  }

  function checkIn(studentId) {
    const exam = currentExam();
    const student = studentById(exam, studentId);
    if (!student) return;

    if (exam.attendance[studentId] === "present") {
      toast(`${student.name} is already checked in (seat ${seatNameOf(exam, studentId)}).`);
    } else {
      setStatus(exam, studentId, "present");
      const late = Core.isLate(exam, studentId);
      toast(`✓ ${student.name}: seat ${seatNameOf(exam, studentId)}${late ? " (late arrival logged)" : ""}`,
        late ? "warning" : "success");
    }

    const key = Core.findSeatOf(exam, studentId);
    highlighted = new Set(key ? [key] : []);
    $("search-input").value = "";
    commit();
    $("search-input").focus();
    scrollToSeat(key);
  }

  function onSearchInput() {
    const exam = currentExam();
    if (!exam) return;
    const matches = Core.searchStudents(exam.students, $("search-input").value);
    highlighted = new Set(matches.map((s) => Core.findSeatOf(exam, s.id)).filter(Boolean));
    renderSearchResults(exam);
    renderGrid(exam);
  }

  function onSearchKey(event) {
    if (event.key === "Escape") {
      $("search-input").value = "";
      onSearchInput();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const exam = currentExam();
    const query = $("search-input").value;
    if (!query.trim()) return;
    const matches = Core.searchStudents(exam.students, query);
    if (matches.length === 1) checkIn(matches[0].id);
    else if (matches.length === 0) toast(`No student matches "${query.trim()}".`, "error");
    else toast(`${matches.length} students match. Pick one from the list.`, "warning");
  }

  function resetAttendance() {
    const exam = currentExam();
    if (!exam || !confirm("Clear all check-ins (and automatic late-arrival entries) for this exam?")) return;
    exam.attendance = {};
    exam.checkInTimes = {};
    exam.incidents = exam.incidents.filter((i) => !i.auto);
    commit();
    toast("Check-in reset.");
  }

  function scrollToSeat(key) {
    if (!key) return;
    const node = document.querySelector(`.seat[data-key="${key}"]`);
    if (node) node.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  // ============================================================= Incidents

  function addIncident() {
    const exam = currentExam();
    if (!exam) return;
    exam.incidents.push({
      id: makeId(),
      time: Date.now(),
      studentId: $("incident-student").value || null,
      type: $("incident-type").value,
      note: $("incident-note").value.trim(),
      auto: false
    });
    $("incident-note").value = "";
    commit();
    toast("Incident logged.", "success");
  }

  function deleteIncident(id) {
    const exam = currentExam();
    exam.incidents = exam.incidents.filter((i) => i.id !== id);
    commit();
  }

  // ================================================================= Timer

  function startTimer() {
    const exam = currentExam();
    if (!exam) return;
    exam.timer = { startedAt: Date.now(), durationMin: exam.durationMin, extraMin: 0, endedAt: null };
    activeTab = "examday";
    commit();
    toast(`Exam started. ${exam.durationMin} minutes on the clock.`, "success");
    $("search-input").focus();
  }

  function extendTimer() {
    const exam = currentExam();
    if (!exam || !exam.timer) return;
    exam.timer.extraMin += 5;
    commit();
    toast(`+5 minutes added (${exam.timer.extraMin} min extra in total).`);
  }

  function endTimer() {
    const exam = currentExam();
    if (!exam || !exam.timer || !confirm("End the exam now?")) return;
    exam.timer.endedAt = Date.now();
    activeTab = "report";
    commit();
    toast("Exam ended. Check the Report tab for exports.");
  }

  function resetTimer() {
    const exam = currentExam();
    if (!exam || !confirm("Reset the timer? Check-ins are kept.")) return;
    exam.timer = null;
    commit();
  }

  // ======================================================= Export & backup

  function exportAttendance() {
    const exam = currentExam();
    downloadFile(`${exam.course}_${exam.date}_attendance.csv`, Core.toCsv(Core.attendanceRows(exam, formatTime)), "text/csv");
  }

  function exportIncidents() {
    const exam = currentExam();
    if (exam.incidents.length === 0) {
      toast("No incidents logged for this exam.");
      return;
    }
    downloadFile(`${exam.course}_${exam.date}_incidents.csv`, Core.toCsv(Core.incidentRows(exam, formatTime)), "text/csv");
  }

  function downloadBackup() {
    const today = new Date().toISOString().slice(0, 10);
    downloadFile(`examseat-backup-${today}.json`, JSON.stringify(state, null, 2), "application/json");
  }

  async function restoreBackup(file) {
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!raw || !Array.isArray(raw.exams)) throw new Error("not an ExamSeat backup");
      const restored = Core.migrateState(raw);
      if (!confirm(`Restore ${restored.exams.length} exam(s) from this backup? Your current data will be replaced.`)) return;
      state = restored;
      selectExam(state.currentId);
      toast("Backup restored.", "success");
    } catch (err) {
      toast("That file isn't a valid ExamSeat backup.", "error");
    }
  }

  // ============================================================= Rendering

  function render() {
    renderExamList();
    const exam = currentExam();
    $("empty-state").hidden = Boolean(exam);
    $("exam-detail").hidden = !exam;
    if (!exam) return;

    $("exam-title").textContent = exam.course;
    const meta = [formatDate(exam.date)];
    if (exam.startTime) meta.push(`starts ${formatClock(exam.startTime)}`);
    meta.push(`Room ${exam.room}`, `${exam.durationMin} min`);
    $("exam-meta").textContent = meta.join(" · ");

    renderTabs();
    renderTimer(exam);
    renderSetup(exam);
    renderSearchResults(exam);
    renderIncidents(exam);
    renderStats(exam);
    renderRoom(exam);
  }

  function renderExamList() {
    const list = $("exam-list");
    list.innerHTML = "";
    if (state.exams.length === 0) {
      list.appendChild(el("li", "muted", "No exams yet."));
      return;
    }
    const sorted = [...state.exams].sort((a, b) => a.date.localeCompare(b.date));
    for (const exam of sorted) {
      const item = el("li");
      const b = button("", "exam-item" + (exam.id === state.currentId ? " active" : ""), () => selectExam(exam.id));
      const title = el("strong", "", exam.course);
      const status = Core.timerInfo(exam.timer).status;
      if (status === "running" || status === "timeup") {
        const dot = el("i", "live-dot");
        dot.title = "Exam in progress";
        title.appendChild(dot);
      }
      b.appendChild(title);
      b.appendChild(el("span", "muted", `${formatDate(exam.date)} · ${exam.room}`));
      item.appendChild(b);
      list.appendChild(item);
    }
  }

  function renderTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      const active = tab.dataset.tab === activeTab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    $("tab-setup").hidden = activeTab !== "setup";
    $("tab-examday").hidden = activeTab !== "examday";
    $("tab-report").hidden = activeTab !== "report";
  }

  function renderTimer(exam) {
    const info = Core.timerInfo(exam.timer);
    $("timer").className = `timer no-print ${info.status} ${info.level}`;

    let label = "Exam timer";
    let display = Core.formatDuration(exam.durationMin * 60000);
    let sub = "Not started";

    if (info.status === "running") {
      label = "Time remaining";
      display = Core.formatDuration(info.remainingMs);
      sub = `Ends at ${formatTime(info.endsAt)}` + (exam.timer.extraMin ? ` (+${exam.timer.extraMin} min)` : "");
    } else if (info.status === "timeup") {
      label = "Time's up";
      display = "00:00";
      sub = `Ended at ${formatTime(info.endsAt)}. Collect papers.`;
    } else if (info.status === "ended") {
      label = "Exam ended";
      display = Core.formatDuration(info.elapsedMs);
      sub = `Ran ${formatTime(exam.timer.startedAt)}–${formatTime(exam.timer.endedAt)}`;
    }

    $("timer-label").textContent = label;
    $("timer-display").textContent = display;
    $("timer-sub").textContent = sub;
    $("timer-start").hidden = info.status !== "idle";
    $("timer-extend").hidden = !(info.status === "running" || info.status === "timeup");
    $("timer-end").hidden = !(info.status === "running" || info.status === "timeup");
    $("timer-reset").hidden = info.status === "idle";
  }

  function fillStudentSelect(select, students, placeholder) {
    const previous = select.value;
    select.innerHTML = "";
    const first = el("option", "", placeholder);
    first.value = "";
    select.appendChild(first);
    for (const s of [...students].sort((a, b) => a.name.localeCompare(b.name))) {
      const option = el("option", "", `${s.name} (${s.id})`);
      option.value = s.id;
      select.appendChild(option);
    }
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
  }

  function renderSetup(exam) {
    $("student-count").textContent = `${exam.students.length} student(s) saved`;
    $("spacing").checked = exam.spacing;

    fillStudentSelect($("apart-a"), exam.students, "Student…");
    fillStudentSelect($("apart-b"), exam.students, "Student…");

    const list = $("apart-list");
    list.innerHTML = "";
    exam.keepApart.forEach(([a, b], index) => {
      const sa = studentById(exam, a);
      const sb = studentById(exam, b);
      const chip = el("li", "chip", `${sa ? sa.name : a} ↔ ${sb ? sb.name : b}`);
      const remove = button("×", "icon", () => removeKeepApart(index));
      remove.setAttribute("aria-label", "Remove pair");
      chip.appendChild(remove);
      list.appendChild(chip);
    });
  }

  function renderSearchResults(exam) {
    const list = $("search-results");
    list.innerHTML = "";
    const query = $("search-input").value;
    if (!query.trim()) return;

    const matches = Core.searchStudents(exam.students, query);
    if (matches.length === 0) {
      list.appendChild(el("li", "muted", "No student matches."));
      return;
    }
    for (const s of matches) {
      const row = el("li", "result");
      const info = el("div");
      info.appendChild(el("strong", "", s.name));
      info.appendChild(el("span", "muted", `${s.id} · Seat ${seatNameOf(exam, s.id)}${s.accessible ? " · ♿" : ""}`));
      row.appendChild(info);

      const status = exam.attendance[s.id];
      if (status === "present") row.appendChild(el("span", "pill present", "✓ Present"));
      else row.appendChild(button(status === "absent" ? "Check in (was absent)" : "Check in", "small", () => checkIn(s.id)));
      list.appendChild(row);
    }
  }

  function renderIncidents(exam) {
    fillStudentSelect($("incident-student"), exam.students, "No specific student");

    const typeSelect = $("incident-type");
    if (typeSelect.options.length === 0) {
      for (const type of Core.INCIDENT_TYPES) typeSelect.appendChild(el("option", "", type));
      typeSelect.value = "Washroom break (out)";
    }

    const list = $("incident-list");
    list.innerHTML = "";
    if (exam.incidents.length === 0) {
      list.appendChild(el("li", "muted", "No incidents logged."));
      return;
    }
    const sorted = [...exam.incidents].sort((a, b) => b.time - a.time); // newest first
    for (const incident of sorted) {
      const row = el("li", "incident");
      const minutes = Core.minutesIntoExam(exam, incident.time);
      row.appendChild(el("span", "incident-time", formatTime(incident.time) + (minutes !== null && minutes >= 0 ? `\n+${minutes} min` : "")));

      const body = el("div");
      const kind = incident.type === "Suspected academic misconduct" ? "pill absent"
        : incident.type === "Late arrival" ? "pill warn" : "pill";
      body.appendChild(el("span", kind, incident.type));
      const student = incident.studentId ? studentById(exam, incident.studentId) : null;
      if (student) body.appendChild(el("span", "", ` ${student.name} · seat ${seatNameOf(exam, student.id)}`));
      if (incident.note) body.appendChild(el("div", "incident-note", incident.note));
      row.appendChild(body);

      const remove = button("×", "icon", () => deleteIncident(incident.id));
      remove.setAttribute("aria-label", "Delete incident");
      row.appendChild(remove);
      list.appendChild(row);
    }
  }

  function renderStats(exam) {
    const s = Core.attendanceSummary(exam);
    const stats = $("stats");
    stats.innerHTML = "";
    const items = [
      ["", s.total, "Students"],
      ["present", s.present, "Present"],
      ["late", s.late, "Late"],
      ["absent", s.absent, "Absent"],
      ["", s.notCheckedIn, "Not checked in"],
      ["", s.incidents, "Incidents"]
    ];
    for (const [cls, value, label] of items) {
      const box = el("div", "stat " + cls);
      box.appendChild(el("strong", "", String(value)));
      box.appendChild(el("span", "", label));
      stats.appendChild(box);
    }
  }

  function renderRoom(exam) {
    const usable = Core.usableSeats(exam);
    const accessible = usable.filter((s) => s.accessible).length;
    const summary = Core.attendanceSummary(exam);
    const unseated = summary.total - summary.seated;
    $("room-summary").textContent =
      `${exam.rows} × ${exam.cols} · ${usable.length} usable seats` +
      (accessible ? ` · ${accessible} accessible` : "") +
      ` · ${summary.seated}/${summary.total} students seated` +
      (unseated > 0 && summary.seated > 0 ? ` (${unseated} without a seat)` : "");

    $("mode-checkin").classList.toggle("active", gridMode === "checkin");
    $("mode-layout").classList.toggle("active", gridMode === "layout");
    $("grid-hint").textContent = gridMode === "layout"
      ? "Editing layout: click a seat to switch it between normal → blocked ✕ (aisle or broken seat) → accessible ♿."
      : "Click a student's seat to switch: not checked in → present → absent. Drag a student onto another seat to move or swap.";

    const problems = Core.seatingProblems(exam);
    const problemList = $("seat-problems");
    problemList.innerHTML = "";
    problemList.hidden = problems.length === 0;
    for (const p of problems) problemList.appendChild(el("li", "", p.message));

    renderGrid(exam, problems);
  }

  function renderGrid(exam, problems = Core.seatingProblems(exam)) {
    const grid = $("seat-grid");
    grid.innerHTML = "";
    grid.style.gridTemplateColumns = `repeat(${exam.cols}, minmax(78px, 1fr))`;
    grid.classList.toggle("layout-mode", gridMode === "layout");

    const studentsById = new Map(exam.students.map((s) => [s.id, s]));
    const problemKeys = new Set(problems.flatMap((p) => p.keys));

    for (let row = 0; row < exam.rows; row++) {
      for (let col = 0; col < exam.cols; col++) {
        const key = Core.seatKey(row, col);
        const type = Core.seatType(exam, key);
        const student = studentsById.get(exam.seats[key]);

        const seat = el("button", `seat type-${type}`);
        seat.type = "button";
        seat.dataset.key = key;
        seat.appendChild(el("span", "seat-label", Core.seatLabel(row, col) + (type === "accessible" ? " ♿" : "")));

        if (student) {
          const status = exam.attendance[student.id];
          const late = Core.isLate(exam, student.id);
          if (status) seat.classList.add(status);
          if (late) seat.classList.add("late");
          seat.appendChild(el("span", "seat-name", student.name));

          let sub = student.id;
          if (status === "present") {
            const at = exam.checkInTimes[student.id];
            sub = (at ? `✓ ${formatTime(at)}` : "✓ Present") + (late ? " · late" : "");
          } else if (status === "absent") {
            sub = "Absent";
          }
          seat.appendChild(el("span", "seat-id", sub));
          seat.title = `${student.name} (${student.id}): ${status || "not checked in"}${late ? ", late" : ""}`;

          if (gridMode === "checkin") {
            seat.draggable = true;
            seat.addEventListener("dragstart", (event) => {
              dragFromKey = key;
              event.dataTransfer.setData("text/plain", key);
              event.dataTransfer.effectAllowed = "move";
              seat.classList.add("dragging");
            });
            seat.addEventListener("dragend", () => {
              dragFromKey = null;
              seat.classList.remove("dragging");
            });
          }
        } else if (type === "blocked") {
          seat.appendChild(el("span", "seat-x", "✕"));
          seat.title = "Blocked (aisle or broken seat)";
        } else {
          seat.classList.add("vacant");
          seat.title = type === "accessible" ? "Empty accessible seat" : "Empty seat";
        }

        if (problemKeys.has(key)) seat.classList.add("problem");
        if (highlighted.has(key)) seat.classList.add("highlight");

        // Clicks: layout mode edits any seat; check-in mode only seats with a student.
        if (gridMode === "layout" || student) {
          seat.addEventListener("click", () => onSeatClick(key));
        } else {
          seat.tabIndex = -1;
          seat.setAttribute("aria-disabled", "true");
        }

        // Any non-blocked seat accepts a dragged student.
        if (gridMode === "checkin" && type !== "blocked") {
          seat.addEventListener("dragover", (event) => {
            if (!dragFromKey) return;
            event.preventDefault();
            seat.classList.add("drop-target");
          });
          seat.addEventListener("dragleave", () => seat.classList.remove("drop-target"));
          seat.addEventListener("drop", (event) => {
            event.preventDefault();
            seat.classList.remove("drop-target");
            onDrop(key);
          });
        }

        grid.appendChild(seat);
      }
    }
  }

  // ======================================================= Event listeners

  $("theme-toggle").addEventListener("click", toggleTheme);

  $("exam-form").addEventListener("submit", (event) => {
    event.preventDefault();
    createExam(event.target);
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      renderTabs();
      if (activeTab === "examday") $("search-input").focus();
    });
  });

  // Setup
  $("save-students").addEventListener("click", saveStudents);
  $("csv-upload").addEventListener("change", (event) => {
    uploadCsv(event.target.files[0]);
    event.target.value = ""; // allows uploading the same file again
  });
  $("spacing").addEventListener("change", (event) => {
    const exam = currentExam();
    if (!exam) return;
    exam.spacing = event.target.checked;
    saveState();
  });
  $("apart-add").addEventListener("click", addKeepApart);
  $("assign-seats").addEventListener("click", autoAssign);

  // Exam day
  $("search-input").addEventListener("input", onSearchInput);
  $("search-input").addEventListener("keydown", onSearchKey);
  $("incident-add").addEventListener("click", addIncident);
  $("incident-note").addEventListener("keydown", (event) => {
    if (event.key === "Enter") addIncident();
  });

  // Timer
  $("timer-start").addEventListener("click", startTimer);
  $("timer-extend").addEventListener("click", extendTimer);
  $("timer-end").addEventListener("click", endTimer);
  $("timer-reset").addEventListener("click", resetTimer);

  // Room mode
  $("mode-checkin").addEventListener("click", () => { gridMode = "checkin"; render(); });
  $("mode-layout").addEventListener("click", () => { gridMode = "layout"; highlighted = new Set(); render(); });

  // Report
  $("export-attendance").addEventListener("click", exportAttendance);
  $("export-incidents").addEventListener("click", exportIncidents);
  $("print").addEventListener("click", () => window.print());
  $("reset-attendance").addEventListener("click", resetAttendance);
  $("delete-exam").addEventListener("click", deleteExam);

  // Backup
  $("backup-download").addEventListener("click", downloadBackup);
  $("backup-restore").addEventListener("change", (event) => {
    restoreBackup(event.target.files[0]);
    event.target.value = "";
  });

  // Tick the timer once a second (only the timer box is redrawn).
  setInterval(() => {
    const exam = currentExam();
    if (exam && exam.timer) renderTimer(exam);
  }, 1000);

  // ================================================================= Start
  applyTheme(document.documentElement.dataset.theme || "light");
  selectExam(state.currentId);
})();
