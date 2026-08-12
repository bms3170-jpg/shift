/* =========================================================
   ShiftMate · app.js
   서버 없이 브라우저 localStorage 만으로 동작하는 근무표 + 가계부.
   구조: 상태(state) → 저장/불러오기 → 계산 유틸 → 렌더 → 이벤트 바인딩
   ========================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     1. 상수와 기본값
     --------------------------------------------------------- */
  var STORAGE_KEY = "shiftmate.data.v1";
  var THEME_KEY = "shiftmate.theme";
  var REMINDER_SHOWN_KEY = "shiftmate.reminder.shown";
  var WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

  var PRESET_COLORS = [
    "#3B82F6",
    "#F59E0B",
    "#8B5CF6",
    "#6BAA75",
    "#EC6B74",
    "#14B8A6",
    "#64748B",
    "#E879A9",
  ];

  var EXPENSE_CATEGORIES = [
    "식비",
    "교통",
    "주거·통신",
    "생활용품",
    "의료·건강",
    "문화·여가",
    "의류·미용",
    "경조사",
    "저축·투자",
    "기타",
  ];
  var INCOME_CATEGORIES = ["급여", "상여", "용돈", "환급", "기타"];

  function defaultData() {
    return {
      version: 1,
      homeAddress: "",
      notice: "",
      reminders: [],
      shiftTypes: [
        { id: uid(), name: "오픈", color: "#3B82F6", start: "06:00", end: "13:30" },
        { id: uid(), name: "미들", color: "#F59E0B", start: "10:00", end: "18:00" },
        { id: uid(), name: "마감", color: "#8B5CF6", start: "15:00", end: "22:30" },
        { id: uid(), name: "휴무", color: "#6BAA75", start: "", end: "" },
      ],
      events: [],
      transactions: [],
      salaries: [],
    };
  }

  /* ---------------------------------------------------------
     2. 저장소
     --------------------------------------------------------- */
  var data = load();
  var view = "calendar";
  var cursor = startOfMonth(new Date()); // 달력이 보고 있는 달
  var finCursor = startOfMonth(new Date()); // 가계부가 보고 있는 달
  var selectedDate = toKey(new Date());
  var editingEventId = null;
  var editingTxId = null;
  var editingSalaryId = null;
  var editingShiftId = null;
  var txKind = "expense";
  var shiftColor = PRESET_COLORS[0];
  var toastTimer = null;
    // 무료 OCR 스케줄 가져오기
  var importedScheduleItems = [];

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultData();
      var parsed = JSON.parse(raw);
      return normalize(parsed);
    } catch (err) {
      console.warn("저장된 데이터를 읽지 못했습니다:", err);
      return defaultData();
    }
  }

  function normalize(obj) {
    var base = defaultData();
    if (!obj || typeof obj !== "object") return base;
    return {
      version: 1,
      homeAddress: typeof obj.homeAddress === "string" ? obj.homeAddress : "",
      notice: typeof obj.notice === "string" ? obj.notice : "",
      reminders: Array.isArray(obj.reminders)
        ? obj.reminders.map(function (r) {
            return {
              id: r.id || uid(),
              date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")) ? String(r.date) : "",
              text: String(r.text || "").trim(),
            };
          }).filter(function (r) { return r.date && r.text; })
        : [],
      shiftTypes: Array.isArray(obj.shiftTypes) && obj.shiftTypes.length
        ? obj.shiftTypes.map(function (t) {
            return {
              id: t.id || uid(),
              name: String(t.name || "근무"),
              color: t.color || PRESET_COLORS[0],
              start: t.start || "",
              end: t.end || "",
            };
          })
        : base.shiftTypes,
      events: Array.isArray(obj.events)
        ? obj.events.map(function (e) {
            return {
              id: e.id || uid(),
              date: e.date,
              title: String(e.title || "일정"),
              allDay: !!e.allDay,
              start: e.start || "",
              end: e.end || "",
              shiftTypeId: e.shiftTypeId || "",
              place: e.place || "",
              memo: e.memo || "",
              source: e.source || "",
              attendanceSource: e.attendanceSource === "R" ? "R" : (e.attendanceSource === "P" ? "P" : ""),
              breakMode: e.breakMode === "manual" ? "manual" : "auto",
              breakMinutes: Math.max(0, Number(e.breakMinutes) || 0),
            };
          }).filter(function (e) {
            return /^\d{4}-\d{2}-\d{2}$/.test(e.date);
          })
        : [],
      transactions: Array.isArray(obj.transactions)
        ? obj.transactions.map(function (t) {
            return {
              id: t.id || uid(),
              date: t.date,
              kind: t.kind === "income" ? "income" : "expense",
              amount: Math.max(0, Number(t.amount) || 0),
              category: String(t.category || "기타"),
              memo: t.memo || "",
              source: t.source || "",
            };
          }).filter(function (t) {
            return /^\d{4}-\d{2}-\d{2}$/.test(t.date);
          })
        : [],
      salaries: Array.isArray(obj.salaries)
        ? obj.salaries.map(function (s) {
            return {
              id: s.id || uid(),
              label: String(s.label || "월급"),
              payDay: clamp(Number(s.payDay) || 25, 1, 31),
              amount: Math.max(0, Number(s.amount) || 0),
              budget: Math.max(0, Number(s.budget) || 0),
            };
          })
        : [],
    };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      toast("저장 공간이 부족해 기록하지 못했습니다.");
    }
  }

  /* ---------------------------------------------------------
     3. 유틸
     --------------------------------------------------------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function $(id) {
    return document.getElementById(id);
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /** Date → "YYYY-MM-DD" (로컬 기준) */
  function toKey(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  /** "YYYY-MM-DD" → Date (로컬 기준, 시간대 오차 없음) */
  function fromKey(key) {
    var p = key.split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  /** 윤년 판정: 4로 나뉘고, 100으로 나뉘면 400으로도 나뉘어야 한다 */
  function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  /** 해당 연·월의 실제 일수 (28/29/30/31) */
  function daysInMonth(y, m) {
    var table = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return table[m - 1];
  }

  /** 달력 6주(42칸) 그리드 생성 */
  function buildMonthGrid(y, m) {
    var first = new Date(y, m - 1, 1);
    var lead = first.getDay(); // 일요일 시작
    var cells = [];
    var startMs = new Date(y, m - 1, 1 - lead).getTime();
    for (var i = 0; i < 42; i++) {
      var d = new Date(startMs + i * 86400000);
      cells.push({
        key: toKey(d),
        day: d.getDate(),
        weekday: d.getDay(),
        inMonth: d.getMonth() === m - 1 && d.getFullYear() === y,
      });
    }
    return cells;
  }

  /** 근무 시간(분). 종료가 시작보다 이르면 자정을 넘긴 것으로 계산 */
  function durationMinutes(start, end) {
    if (!start || !end) return null;
    var s = start.split(":");
    var e = end.split(":");
    var sm = Number(s[0]) * 60 + Number(s[1]);
    var em = Number(e[0]) * 60 + Number(e[1]);
    if (em <= sm) em += 24 * 60;
    return em - sm;
  }

  function autoBreakMinutes(start, end) {
    var minutes = durationMinutes(start, end);
    if (minutes == null) return 0;
    if (minutes >= 8 * 60) return 60;
    if (minutes >= 7 * 60) return 30;
    return 0;
  }

  function eventBreakMinutes(e) {
    if (!e || e.allDay) return 0;
    if (e.breakMode === "manual") return Math.max(0, Number(e.breakMinutes) || 0);
    return autoBreakMinutes(e.start, e.end);
  }

  function formatDuration(min) {
    if (min == null) return "";
    var h = Math.floor(min / 60);
    var m = min % 60;
    if (m === 0) return h + "시간";
    if (h === 0) return m + "분";
    return h + "시간 " + m + "분";
  }

  function formatKRW(n) {
    return Number(n || 0).toLocaleString("ko-KR") + "원";
  }

  function digitsWithComma(str) {
    var digits = String(str).replace(/[^\d]/g, "");
    if (!digits) return "";
    return Number(digits).toLocaleString("ko-KR");
  }

  function parseDigits(str) {
    var digits = String(str).replace(/[^\d]/g, "");
    return digits ? Number(digits) : 0;
  }

  function formatDateKo(key) {
    var d = fromKey(key);
    return (
      d.getFullYear() +
      "년 " +
      (d.getMonth() + 1) +
      "월 " +
      d.getDate() +
      "일 " +
      WEEKDAY_KO[d.getDay()] +
      "요일"
    );
  }

  /** 다음 급여일 계산. 말일이 짧은 달은 말일로 보정한다 */
  function nextPayday(payDay, base) {
    var today = base || new Date();
    var y = today.getFullYear();
    var m = today.getMonth() + 1;
    var thisMonthDay = Math.min(payDay, daysInMonth(y, m));
    var target;
    if (today.getDate() <= thisMonthDay) {
      target = new Date(y, m - 1, thisMonthDay);
    } else {
      var ny = m === 12 ? y + 1 : y;
      var nm = m === 12 ? 1 : m + 1;
      target = new Date(ny, nm - 1, Math.min(payDay, daysInMonth(ny, nm)));
    }
    var t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var daysLeft = Math.round((target - t0) / 86400000);
    return { date: toKey(target), daysLeft: daysLeft };
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function shiftById(id) {
    for (var i = 0; i < data.shiftTypes.length; i++) {
      if (data.shiftTypes[i].id === id) return data.shiftTypes[i];
    }
    return null;
  }

  /* ---------------------------------------------------------
     4. 네이버지도 링크
     --------------------------------------------------------- */
  /**
   * 장소를 네이버지도에서 연다.
   * ShiftMate는 장소명을 저장하고 좌표를 별도로 보관하지 않기 때문에,
   * 네이버지도 검색 화면으로 연결한 뒤 사용자가 길찾기 방식을 선택하도록 한다.
   */
  function buildDirectionsUrl(opts) {
    var destination = String(opts && opts.destination ? opts.destination : "").trim();
    return "https://map.naver.com/p/search/" + encodeURIComponent(destination);
  }

  function buildNaverMapUrl(place) {
    return "https://map.naver.com/p/search/" + encodeURIComponent(String(place || "").trim());
  }

  /* ---------------------------------------------------------
     5. 렌더 · 달력
     --------------------------------------------------------- */
  function eventsOn(key) {
    return data.events
      .filter(function (e) {
        return e.date === key;
      })
      .sort(function (a, b) {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return String(a.start || "").localeCompare(String(b.start || ""));
      });
  }

  function renderCalendar() {
    var y = cursor.getFullYear();
    var m = cursor.getMonth() + 1;
    var todayKey = toKey(new Date());

    $("monthLabel").textContent = m + "월";
    $("yearLabel").textContent = String(y);

    var monthCount = data.events.filter(function (e) {
      return e.date.slice(0, 7) === y + "-" + pad(m);
    }).length;
    $("monthMeta").textContent = daysInMonth(y, m) + "일 · 일정 " + monthCount + "건";

    var cells = buildMonthGrid(y, m);
    var html = "";

    cells.forEach(function (c) {
      var evs = eventsOn(c.key);
      var cls = ["cell"];
      if (!c.inMonth) cls.push("is-out");
      if (c.key === todayKey) cls.push("is-today");
      if (c.key === selectedDate) cls.push("is-selected");
      if (c.weekday === 0) cls.push("is-weekend");
      if (c.weekday === 6) cls.push("is-sat");

      var pills = "";
      evs.slice(0, 3).forEach(function (e) {
        var st = shiftById(e.shiftTypeId);
        var color = st ? st.color : "#9c9188";
        if (e.allDay || !e.start) {
          pills +=
            '<span class="pill" style="background:' +
            color +
            '1f;color:' +
            color +
            '" title="' +
            escapeHtml(e.title) +
            '">' +
            escapeHtml(e.title) +
            "</span>";
        } else if (e.end) {
          var breakMin = eventBreakMinutes(e);
          pills +=
            '<span class="pill pill--work" style="background:' +
            color +
            '1f;color:' +
            color +
            '" title="' +
            escapeHtml(e.title) +
            '">' +
            '<span class="pill__time">' + escapeHtml(e.start) + '</span>' +
            '<span class="pill__time">' + escapeHtml(e.end) + '</span>' +
            '<span class="pill__break">(휴게 ' + breakMin + '분)</span>' +
            "</span>";
        } else {
          pills +=
            '<span class="pill" style="background:' +
            color +
            '1f;color:' +
            color +
            '" title="' +
            escapeHtml(e.title) +
            '">' +
            escapeHtml(e.start) +
            "</span>";
        }
      });
      if (evs.length > 3) {
        pills += '<span class="pill pill--more">+' + (evs.length - 3) + "</span>";
      }

      html +=
        '<button type="button" class="' +
        cls.join(" ") +
        '" data-date="' +
        c.key +
        '"><span class="cell__num">' +
        c.day +
        "</span>" +
        pills +
        "</button>";
    });

    $("calendarGrid").innerHTML = html;

    // 근무 유형 범례
    var legend = '<span class="legend__label">근무 유형</span>';
    data.shiftTypes.forEach(function (t) {
      var time = t.start && t.end ? '<span class="legend__time">' + t.start + "–" + t.end + "</span>" : "";
      legend +=
        '<span class="legend__item" style="background:' +
        t.color +
        '1a"><span class="dot" style="background:' +
        t.color +
        '"></span>' +
        escapeHtml(t.name) +
        time +
        "</span>";
    });
    $("legend").innerHTML = data.shiftTypes.length ? legend : "";

    renderCalendarOverview(y, m);
    renderDayPanel();
    renderUpcoming();
  }


  function renderCalendarOverview(y, m) {
    var monthKey = y + "-" + pad(m);
    var monthEvents = data.events.filter(function (e) {
      return e.date && e.date.slice(0, 7) === monthKey;
    });

    var workDays = 0;
    var offDays = 0;
    var totalMinutes = 0;

    monthEvents.forEach(function (e) {
      var title = String(e.title || "");
      var st = shiftById(e.shiftTypeId);
      var shiftName = st ? String(st.name || "") : "";
      var offLike =
        e.allDay ||
        /휴무|비번|휴일|정규휴일/.test(title) ||
        /휴무|비번|휴일/.test(shiftName);

      if (offLike) {
        offDays += 1;
        return;
      }

      if (e.start) {
        workDays += 1;
        var minutes = durationMinutes(e.start, e.end);
        if (minutes) totalMinutes += Math.max(0, minutes - eventBreakMinutes(e));
      }
    });

    if ($("statShiftTotal")) $("statShiftTotal").textContent = String(monthEvents.length);
    if ($("statWorkDays")) $("statWorkDays").textContent = String(workDays);
    if ($("statOffDays")) $("statOffDays").textContent = String(offDays);
    if ($("statMonthHours")) {
      var hours = totalMinutes / 60;
      $("statMonthHours").textContent =
        (Math.round(hours * 10) / 10).toLocaleString("ko-KR") + "h";
    }
  }

  function renderDayPanel() {
    $("selectedDateLabel").textContent = formatDateKo(selectedDate);
    var evs = eventsOn(selectedDate);
    var box = $("dayEvents");

    if (!evs.length) {
      box.innerHTML =
        '<div class="empty"><p class="empty__title">아직 기록한 일정이 없어요</p>' +
        '<p class="empty__desc">추가 버튼을 눌러 근무나 약속을 남겨 보세요.</p></div>';
      return;
    }

    var html = '<ul class="list">';
    evs.forEach(function (e) {
      html += renderEventItem(e);
    });
    html += "</ul>";
    box.innerHTML = html;
  }

  function renderEventItem(e) {
    var st = shiftById(e.shiftTypeId);
    var color = st ? st.color : "#9c9188";

    var timeText = "종일";
    if (!e.allDay && e.start) {
      timeText = e.start + (e.end ? " – " + e.end : "");
      var dur = durationMinutes(e.start, e.end);
      if (dur) {
        var breakMin = eventBreakMinutes(e);
        var net = Math.max(0, dur - breakMin);
        timeText += " (실근무 " + formatDuration(net);
        if (breakMin) timeText += " · 휴게 " + formatDuration(breakMin);
        timeText += ")";
      }
    }

    var tag = st
      ? '<span class="tag" style="background:' +
        color +
        '22;color:' +
        color +
        '">' +
        escapeHtml(st.name) +
        "</span>"
      : "";

    var links = "";
    if (e.place) {
      var origin = data.homeAddress;
      var time = e.allDay ? "" : e.start;
      links =
        '<div class="item__links">' +
        '<a class="maplink" target="_blank" rel="noopener" href="' +
        buildDirectionsUrl({ destination: e.place, origin: origin, date: e.date, time: time, mode: "transit" }) +
        '">대중교통</a>' +
        '<a class="maplink" target="_blank" rel="noopener" href="' +
        buildDirectionsUrl({ destination: e.place, origin: origin, date: e.date, time: time, mode: "driving" }) +
        '">자동차</a>' +
        '<a class="maplink" target="_blank" rel="noopener" href="' +
        buildDirectionsUrl({ destination: e.place, origin: origin, date: e.date, time: time, mode: "walking" }) +
        '">도보</a>' +
        '<a class="maplink" target="_blank" rel="noopener" href="' +
        buildNaverMapUrl(e.place) +
        '">네이버지도</a>' +
        "</div>";
    }

    return (
      '<li class="item"><span class="item__bar" style="background:' +
      color +
      '"></span><div class="item__body">' +
      '<div class="item__top"><p class="item__title">' +
      escapeHtml(e.title) +
      "</p>" +
      tag +
      "</div>" +
      '<p class="item__meta"><span>' +
      escapeHtml(timeText) +
      "</span>" +
      (e.place ? "<span>· " + escapeHtml(e.place) + "</span>" : "") +
      "</p>" +
      (e.memo ? '<p class="item__memo">' + escapeHtml(e.memo) + "</p>" : "") +
      links +
      '</div><div class="item__actions">' +
      '<button class="icon-btn" data-edit-event="' +
      e.id +
      '" aria-label="일정 수정"><svg viewBox="0 0 24 24" class="icon icon--sm"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
      '<button class="icon-btn" data-del-event="' +
      e.id +
      '" aria-label="일정 삭제"><svg viewBox="0 0 24 24" class="icon icon--sm"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>' +
      "</div></li>"
    );
  }

  function renderUpcoming() {
    var todayKey = toKey(new Date());
    var list = data.events
      .filter(function (e) {
        return e.date >= todayKey;
      })
      .sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return String(a.start || "").localeCompare(String(b.start || ""));
      })
      .slice(0, 5);

    if (!list.length) {
      $("upcomingList").innerHTML =
        '<p class="empty__desc" style="margin-top:14px">예정된 일정이 없습니다.</p>';
      return;
    }

    var html = '<ul class="list">';
    list.forEach(function (e) {
      var st = shiftById(e.shiftTypeId);
      var color = st ? st.color : "#9c9188";
      var d = fromKey(e.date);
      var when =
        d.getMonth() + 1 + "월 " + d.getDate() + "일 (" + WEEKDAY_KO[d.getDay()] + ")";
      if (!e.allDay && e.start) when += " " + e.start;
      html +=
        '<li class="item"><span class="item__bar" style="background:' +
        color +
        '"></span><div class="item__body"><div class="item__top">' +
        '<p class="item__title">' +
        escapeHtml(e.title) +
        "</p></div>" +
        '<p class="item__meta"><span>' +
        when +
        "</span>" +
        (e.place ? "<span>· " + escapeHtml(e.place) + "</span>" : "") +
        "</p></div></li>";
    });
    html += "</ul>";
    $("upcomingList").innerHTML = html;
  }

  /* ---------------------------------------------------------
     6. 렌더 · 가계부
     --------------------------------------------------------- */
  function renderFinance() {
    var y = finCursor.getFullYear();
    var m = finCursor.getMonth() + 1;
    var prefix = y + "-" + pad(m);

    $("finMonthLabel").textContent = m + "월";
    $("finYearLabel").textContent = String(y);

    var txs = data.transactions
      .filter(function (t) {
        return t.date.slice(0, 7) === prefix;
      })
      .sort(function (a, b) {
        return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
      });

    var expense = 0;
    var income = 0;
    var byCat = {};
    txs.forEach(function (t) {
      if (t.kind === "expense") {
        expense += t.amount;
        byCat[t.category] = (byCat[t.category] || 0) + t.amount;
      } else {
        income += t.amount;
      }
    });

    var budget = data.salaries.reduce(function (sum, s) {
      return sum + s.budget;
    }, 0);
    var salaryTotal = data.salaries.reduce(function (sum, s) {
      return sum + s.amount;
    }, 0);

    $("statExpense").textContent = formatKRW(expense);
    $("statIncome").textContent = formatKRW(income);

    var remainEl = $("statRemain");
    if (budget > 0) {
      remainEl.textContent = formatKRW(budget - expense);
      remainEl.classList.remove("is-muted");
    } else {
      remainEl.textContent = "예산 미설정";
      remainEl.classList.add("is-muted");
    }

    // 다음 급여일: 등록된 급여 중 가장 가까운 날
    var paydayEl = $("statPayday");
    if (data.salaries.length) {
      var soonest = null;
      data.salaries.forEach(function (s) {
        var np = nextPayday(s.payDay);
        if (!soonest || np.daysLeft < soonest.daysLeft) soonest = np;
      });
      var pd = fromKey(soonest.date);
      paydayEl.textContent =
        pd.getMonth() + 1 + "월 " + pd.getDate() + "일 · D-" + soonest.daysLeft;
      paydayEl.classList.remove("is-muted");
    } else {
      paydayEl.textContent = "급여 미설정";
      paydayEl.classList.add("is-muted");
    }

    // 예산 진행바
    var bar = $("budgetBar");
    if (budget > 0) {
      var pct = Math.round((expense / budget) * 1000) / 10;
      $("budgetPct").textContent = pct + "%";
      bar.style.width = Math.min(100, pct) + "%";
      bar.classList.toggle("is-over", expense > budget);

      var note;
      if (expense > budget) {
        note = "예산을 " + formatKRW(expense - budget) + " 초과했습니다";
      } else {
        var today = new Date();
        var isCurrentMonth =
          today.getFullYear() === y && today.getMonth() + 1 === m;
        var daysLeft = isCurrentMonth
          ? daysInMonth(y, m) - today.getDate() + 1
          : daysInMonth(y, m);
        var perDay = Math.floor((budget - expense) / Math.max(1, daysLeft));
        note = "남은 " + daysLeft + "일 동안 하루 " + formatKRW(perDay) + " 사용 가능";
      }
      $("budgetNote").textContent = note;
    } else {
      $("budgetPct").textContent = "—";
      bar.style.width = "0%";
      bar.classList.remove("is-over");
      $("budgetNote").textContent = "월급과 예산을 등록하면 사용률이 표시됩니다";
    }

    // 내역 목록
    $("txCount").textContent = txs.length + "건";
    var listBox = $("txList");
    if (!txs.length) {
      listBox.innerHTML =
        '<div class="empty"><p class="empty__title">이번 달은 아직 기록이 비어 있어요</p>' +
        '<p class="empty__desc">지출 한 건만 남겨도 예산 잔액이 자동으로 계산돼요.</p></div>';
    } else {
      var html = '<ul class="list">';
      txs.forEach(function (t) {
        var d = fromKey(t.date);
        var sign = t.kind === "expense" ? "-" : "+";
        html +=
          '<li class="item"><div class="item__body"><div class="item__top">' +
          '<p class="item__title">' +
          escapeHtml(t.category) +
          "</p>" +
          '<span class="tag" style="background:var(--surface-soft);color:var(--ink-soft)">' +
          (d.getMonth() + 1) +
          "/" +
          d.getDate() +
          "</span></div>" +
          (t.memo ? '<p class="item__meta"><span>' + escapeHtml(t.memo) + "</span></p>" : "") +
          '</div><div style="display:flex;align-items:center;gap:6px">' +
          '<span class="amount amount--' +
          t.kind +
          '">' +
          sign +
          formatKRW(t.amount) +
          "</span>" +
          '<button class="icon-btn" data-edit-tx="' +
          t.id +
          '" aria-label="내역 수정"><svg viewBox="0 0 24 24" class="icon icon--sm"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
          "</div></li>";
      });
      html += "</ul>";
      listBox.innerHTML = html;
    }

    // 분류별
    var cats = Object.keys(byCat)
      .map(function (k) {
        return { category: k, amount: byCat[k] };
      })
      .sort(function (a, b) {
        return b.amount - a.amount;
      });

    var catBox = $("categoryList");
    if (!cats.length) {
      catBox.innerHTML =
        '<p class="empty__desc" style="margin-top:16px">지출을 등록하면 어디에 많이 썼는지 보여드려요.</p>';
    } else {
      var max = cats[0].amount;
      var chtml = "";
      cats.forEach(function (c, i) {
        var color = PRESET_COLORS[i % PRESET_COLORS.length];
        var ratio = expense > 0 ? Math.round((c.amount / expense) * 100) : 0;
        chtml +=
          '<div class="catrow"><div class="catrow__top"><span>' +
          escapeHtml(c.category) +
          " <span class=\"catrow__amount\">" +
          ratio +
          "%</span></span>" +
          '<span class="catrow__amount">' +
          formatKRW(c.amount) +
          '</span></div><div class="catbar"><div class="catbar__fill" style="width:' +
          Math.round((c.amount / max) * 100) +
          "%;background:" +
          color +
          '"></div></div></div>';
      });
      catBox.innerHTML = chtml;
    }

    // 급여 목록
    var salBox = $("salaryList");
    if (!data.salaries.length) {
      salBox.innerHTML =
        '<p class="empty__desc" style="margin-top:16px">월급날과 금액을 등록하면 D-day와 예산이 계산돼요.</p>';
    } else {
      var shtml = '<ul class="list">';
      data.salaries.forEach(function (s) {
        var np = nextPayday(s.payDay);
        shtml +=
          '<li class="item"><div class="item__body"><div class="item__top">' +
          '<p class="item__title">' +
          escapeHtml(s.label) +
          '</p><span class="tag" style="background:color-mix(in srgb, var(--gold) 18%, transparent);color:var(--gold-ink)">매월 ' +
          s.payDay +
          '일</span></div><p class="item__meta"><span>' +
          formatKRW(s.amount) +
          "</span><span>· 예산 " +
          formatKRW(s.budget) +
          "</span><span>· D-" +
          np.daysLeft +
          '</span></p></div><button class="icon-btn" data-edit-sal="' +
          s.id +
          '" aria-label="월급 수정"><svg viewBox="0 0 24 24" class="icon icon--sm"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button></li>';
      });
      shtml += "</ul>";
      salBox.innerHTML = shtml;
    }
  }

  /* ---------------------------------------------------------
     7. 렌더 · 설정
     --------------------------------------------------------- */
  function renderSettings() {
    $("homeAddress").value = data.homeAddress;
    if ($("noticeText")) $("noticeText").value = data.notice || "";
    renderNotice();
    renderReminderList();

    var box = $("shiftList");
    if (!data.shiftTypes.length) {
      box.innerHTML =
        '<p class="empty__desc" style="margin-top:16px">주간·야간처럼 자주 쓰는 근무를 등록해 두면 입력이 빨라져요.</p>';
      return;
    }

    var html = '<ul class="list">';
    data.shiftTypes.forEach(function (t) {
      var time = t.start && t.end ? t.start + " – " + t.end : "시간 없음 (종일)";
      html +=
        '<li class="item"><span class="dot" style="margin-top:6px;background:' +
        t.color +
        '"></span><div class="item__body"><p class="item__title">' +
        escapeHtml(t.name) +
        '</p><p class="item__meta"><span>' +
        time +
        '</span></p></div><div class="item__actions">' +
        '<button class="icon-btn" data-edit-shift="' +
        t.id +
        '" aria-label="근무 유형 수정"><svg viewBox="0 0 24 24" class="icon icon--sm"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>' +
        '<button class="icon-btn" data-del-shift="' +
        t.id +
        '" aria-label="근무 유형 삭제"><svg viewBox="0 0 24 24" class="icon icon--sm"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button>' +
        "</div></li>";
    });
    html += "</ul>";
    box.innerHTML = html;
  }

  function renderNotice() {
    var bar = $("noticeBar");
    if (!bar) return;
    var text = String(data.notice || "").trim();
    bar.hidden = !text;
    if (text && $("noticeBarText")) $("noticeBarText").textContent = text;
  }

  function renderReminderList() {
    var box = $("reminderList");
    if (!box) return;
    var items = (data.reminders || []).slice().sort(function (a, b) {
      return a.date.localeCompare(b.date);
    });
    if (!items.length) {
      box.innerHTML = '<p class="empty__desc" style="margin-top:14px">등록된 날짜 알림이 없어요.</p>';
      return;
    }
    var html = '<ul class="list">';
    items.forEach(function (r) {
      html += '<li class="item"><div class="item__body"><p class="item__title">' +
        escapeHtml(r.text) + '</p><p class="item__meta"><span>' +
        escapeHtml(formatDateKo(r.date)) + '</span></p></div>' +
        '<button class="icon-btn" data-del-reminder="' + r.id + '" aria-label="알림 삭제">' +
        '<svg viewBox="0 0 24 24" class="icon icon--sm"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg></button></li>';
    });
    html += '</ul>';
    box.innerHTML = html;
  }

  function saveNotice() {
    data.notice = $("noticeText").value.trim();
    save();
    renderNotice();
    toast(data.notice ? "공지를 저장했습니다." : "공지를 비웠습니다.");
  }

  function addReminder() {
    var date = $("reminderDate").value;
    var text = $("reminderText").value.trim();
    if (!date || !text) {
      toast("알림 날짜와 내용을 입력해 주세요.");
      return;
    }
    data.reminders.push({ id: uid(), date: date, text: text });
    $("reminderText").value = "";
    save();
    renderReminderList();
    try { localStorage.removeItem(REMINDER_SHOWN_KEY); } catch (err) {}
    toast("날짜 알림을 추가했습니다.");
  }

  function deleteReminder(id) {
    data.reminders = data.reminders.filter(function (r) { return r.id !== id; });
    save();
    renderReminderList();
    toast("날짜 알림을 삭제했습니다.");
  }

  function showTodayReminders(force) {
    var today = toKey(new Date());
    var todays = (data.reminders || []).filter(function (r) { return r.date === today; });
    if (!todays.length || !$("todayReminderModal")) return;
    var shown = "";
    try { shown = localStorage.getItem(REMINDER_SHOWN_KEY) || ""; } catch (err) {}
    if (!force && shown === today) return;
    $("todayReminderList").innerHTML = todays.map(function (r) {
      return '<li>' + escapeHtml(r.text) + '</li>';
    }).join("");
    $("todayReminderCount").textContent = todays.length + "개의 알림";
    openModal("todayReminderModal");
    try { localStorage.setItem(REMINDER_SHOWN_KEY, today); } catch (err) {}
  }

  function renderAll() {
    renderCalendar();
    renderFinance();
    renderSettings();
  }

  /* ---------------------------------------------------------
     8. 화면 전환 · 토스트 · 테마
     --------------------------------------------------------- */
  function setView(next) {
    view = next;
    ["calendar", "finance", "settings"].forEach(function (v) {
      $("view-" + v).classList.toggle("is-active", v === next);
    });
    document.querySelectorAll("[data-view]").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-view") === next);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    closeDrawer();
  }

  function toast(message) {
    var el = $("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, 2400);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (err) {
      /* 무시 */
    }
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "dark" ? "light" : "dark");
  }

  function openDrawer() {
    $("sidebar").classList.add("is-open");
    $("scrim").hidden = false;
  }

  function closeDrawer() {
    $("sidebar").classList.remove("is-open");
    $("scrim").hidden = true;
  }

  /* ---------------------------------------------------------
     9. 모달 공통
     --------------------------------------------------------- */
  function openModal(id) {
    $(id).hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeModal(id) {
    $(id).hidden = true;
    document.body.style.overflow = "";
  }

  function closeAllModals() {
    ["eventModal", "scheduleImportModal", "txModal", "salaryModal", "shiftModal"].forEach(function (id) {
      $(id).hidden = true;
    });
    document.body.style.overflow = "";
  }

  /* ---------------------------------------------------------
     10. 일정 모달
     --------------------------------------------------------- */
  function fillShiftSelect() {
    var sel = $("evShift");
    var html = '<option value="">지정 없음</option>';
    data.shiftTypes.forEach(function (t) {
      html += '<option value="' + t.id + '">' + escapeHtml(t.name) + "</option>";
    });
    sel.innerHTML = html;
  }

  function openEventModal(eventId, dateKey) {
    editingEventId = eventId || null;
    fillShiftSelect();

    var ev = null;
    if (eventId) {
      ev = data.events.filter(function (e) {
        return e.id === eventId;
      })[0];
    }

    $("eventModalTitle").textContent = ev ? "일정 수정" : "일정 추가";
    $("evDelete").hidden = !ev;

    $("evTitle").value = ev ? ev.title : "";
    $("evDate").value = ev ? ev.date : dateKey || selectedDate;
    $("evShift").value = ev ? ev.shiftTypeId : "";
    $("evAllDay").checked = ev ? ev.allDay : false;
    $("evStart").value = ev ? ev.start : "";
    $("evEnd").value = ev ? ev.end : "";
    $("evPlace").value = ev ? ev.place : "";
    $("evMemo").value = ev ? ev.memo : "";
    $("evBreakMode").value = ev && ev.breakMode === "manual" ? "manual" : "auto";
    $("evBreakMinutes").value = ev && ev.breakMode === "manual" ? Math.max(0, Number(ev.breakMinutes) || 0) : autoBreakMinutes(ev ? ev.start : "", ev ? ev.end : "");

    syncTimeRow();
    syncBreakControls();
    syncDurationHint();
    syncMapLinks();
    openModal("eventModal");
    setTimeout(function () {
      $("evTitle").focus();
    }, 60);
  }

  function syncTimeRow() {
    var allDay = $("evAllDay").checked;
    $("timeRow").style.display = allDay ? "none" : "grid";
    if (allDay) $("durationHint").textContent = "";
  }

  function syncBreakControls() {
    var row = $("breakRow");
    if (!row) return;
    var allDay = $("evAllDay").checked;
    row.style.display = allDay ? "none" : "grid";
    var manual = $("evBreakMode").value === "manual";
    $("evBreakMinutes").disabled = !manual;
    if (!manual && !allDay) {
      $("evBreakMinutes").value = autoBreakMinutes($("evStart").value, $("evEnd").value);
    }
  }

  function syncDurationHint() {
    if ($("evAllDay").checked) {
      $("durationHint").textContent = "";
      return;
    }
    var dur = durationMinutes($("evStart").value, $("evEnd").value);
    if (dur == null) {
      $("durationHint").textContent = "";
      return;
    }
    var breakMin = $("evBreakMode").value === "manual"
      ? Math.max(0, Number($("evBreakMinutes").value) || 0)
      : autoBreakMinutes($("evStart").value, $("evEnd").value);
    if ($("evBreakMode").value !== "manual") $("evBreakMinutes").value = breakMin;
    var net = Math.max(0, dur - breakMin);
    var overnight =
      $("evEnd").value && $("evStart").value && $("evEnd").value <= $("evStart").value;
    $("durationHint").textContent =
      "전체 " + formatDuration(dur) + " · 휴게 " + formatDuration(breakMin) + " · 실근무 " + formatDuration(net) +
      (overnight ? " · 다음날까지 이어집니다" : "");
  }

  function syncMapLinks() {
    var place = $("evPlace").value.trim();
    var box = $("mapLinks");
    if (!place) {
      box.hidden = true;
      return;
    }
    var date = $("evDate").value;
    var time = $("evAllDay").checked ? "" : $("evStart").value;
    var origin = data.homeAddress;

    $("linkTransit").href = buildDirectionsUrl({
      destination: place, origin: origin, date: date, time: time, mode: "transit",
    });
    $("linkDriving").href = buildDirectionsUrl({
      destination: place, origin: origin, date: date, time: time, mode: "driving",
    });
    $("linkWalking").href = buildDirectionsUrl({
      destination: place, origin: origin, date: date, time: time, mode: "walking",
    });
    $("linkNaver").href = buildNaverMapUrl(place);
    box.hidden = false;
  }

      /* ---------------------------------------------------------
     무료 OCR 스케줄 사진 가져오기 (Tesseract.js)
     --------------------------------------------------------- */

  var ocrWorker = null;

  function openScheduleImportModal() {
    importedScheduleItems = [];

    $("scheduleImportLoading").hidden = true;
    $("scheduleImportResult").hidden = true;
    $("scheduleImportError").hidden = true;
    $("scheduleImportSaveBtn").disabled = true;
    $("scheduleImportList").innerHTML = "";

    openModal("scheduleImportModal");
  }

  function setScheduleImportLoading(isLoading, message) {
    $("scheduleImportLoading").hidden = !isLoading;
    $("scheduleImportResult").hidden = isLoading;
    $("scheduleImportError").hidden = true;
    $("scheduleImportSaveBtn").disabled = isLoading;

    var loadingText = $("scheduleImportLoading").querySelector("p");
    if (loadingText && message) loadingText.textContent = message;
  }

  function showScheduleImportError(message) {
    $("scheduleImportLoading").hidden = true;
    $("scheduleImportResult").hidden = true;
    $("scheduleImportError").hidden = false;
    $("scheduleImportError").textContent = message;
    $("scheduleImportSaveBtn").disabled = true;
  }

  function normalizeImportedSchedule(item) {
    var date = String(item.date || "").trim();
    var title = String(item.title || "일정").trim();
    var start = String(item.start || "").trim();
    var end = String(item.end || "").trim();
    var shiftName = String(item.shiftName || "").trim();

    var shift = findShiftTypeByName(shiftName);

    if (shift) {
      if (!start && shift.start) start = shift.start;
      if (!end && shift.end) end = shift.end;
    }

    var allDay = !!item.allDay;

    if (!allDay && !start && !end) {
      allDay = true;
    }

    return {
      selected: true,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
      title: title,
      allDay: allDay,
      start: allDay ? "" : normalizeTime(start),
      end: allDay ? "" : normalizeTime(end),
      shiftName: shiftName,
      shiftTypeId: shift ? shift.id : "",
      place: String(item.place || "").trim(),
      memo: String(item.memo || "").trim(),
      attendanceSource: item.attendanceSource === "R" ? "R" : (item.attendanceSource === "P" ? "P" : ""),
      breakMode: item.breakMode === "manual" ? "manual" : "auto",
      breakMinutes: item.breakMode === "manual"
        ? Math.max(0, Number(item.breakMinutes) || 0)
        : autoBreakMinutes(allDay ? "" : normalizeTime(start), allDay ? "" : normalizeTime(end)),
    };
  }

  function normalizeTime(value) {
    var raw = String(value || "").trim();
    var match = raw.match(/^(\d{1,2})[:.](\d{2})$/);

    if (!match) {
      // OCR이 900, 1830처럼 읽은 경우도 허용
      var digits = raw.replace(/\D/g, "");
      if (digits.length === 3) {
        match = [digits, digits.slice(0, 1), digits.slice(1)];
      } else if (digits.length === 4) {
        match = [digits, digits.slice(0, 2), digits.slice(2)];
      }
    }

    if (!match) return "";

    var h = Number(match[1]);
    var m = Number(match[2]);

    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return "";
    }

    return pad(h) + ":" + pad(m);
  }

  function findShiftTypeByName(name) {
    if (!name) return null;

    var target = String(name)
      .replace(/\s+/g, "")
      .toLowerCase();

    for (var i = 0; i < data.shiftTypes.length; i++) {
      var current = String(data.shiftTypes[i].name)
        .replace(/\s+/g, "")
        .toLowerCase();

      if (current === target || target.indexOf(current) >= 0 || current.indexOf(target) >= 0) {
        return data.shiftTypes[i];
      }
    }

    var aliases = {
      주간: ["주간", "주", "day", "d"],
      야간: ["야간", "야", "night", "n"],
      비번: ["비번", "비", "off"],
      휴무: ["휴무", "휴일", "휴", "offday"],
    };

    for (var key in aliases) {
      var words = aliases[key];
      for (var a = 0; a < words.length; a++) {
        if (target === words[a] || target.indexOf(words[a]) >= 0) {
          for (var j = 0; j < data.shiftTypes.length; j++) {
            if (data.shiftTypes[j].name === key) {
              return data.shiftTypes[j];
            }
          }
        }
      }
    }

    return null;
  }

  async function getOcrWorker() {
    if (!window.Tesseract) {
      throw new Error(
        "무료 OCR 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해 주세요."
      );
    }

    if (ocrWorker) return ocrWorker;

    setScheduleImportLoading(true, "처음 한 번은 한글 OCR 데이터를 준비하고 있어요...");

    ocrWorker = await Tesseract.createWorker("kor+eng", 1, {
      logger: function (m) {
        if (!m || !m.status) return;

        var percent = typeof m.progress === "number"
          ? " " + Math.round(m.progress * 100) + "%"
          : "";

        var statusMap = {
          "loading tesseract core": "OCR 엔진 준비 중",
          "initializing tesseract": "OCR 초기화 중",
          "loading language traineddata": "한글 인식 데이터 받는 중",
          "initializing api": "OCR 준비 중",
          "recognizing text": "사진에서 글자를 읽는 중",
        };

        setScheduleImportLoading(
          true,
          (statusMap[m.status] || "스케줄 사진을 분석하고 있어요") + percent
        );
      },
    });

    return ocrWorker;
  }

  async function importScheduleImage(file) {
    if (!file) return;

    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      openScheduleImportModal();
      showScheduleImportError(
        "PNG, JPG, JPEG, WEBP 이미지만 사용할 수 있습니다."
      );
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      openScheduleImportModal();
      showScheduleImportError(
        "사진 크기가 너무 큽니다. 15MB 이하의 사진을 사용해 주세요."
      );
      return;
    }

    openScheduleImportModal();
    setScheduleImportLoading(true, "스케줄 사진을 준비하고 있어요...");

    try {
      var preparedImages = await preprocessScheduleImage(file);
      var worker = await getOcrWorker();

      setScheduleImportLoading(true, "표 영역을 크게 확대해서 읽는 중...");

      // 1차: 스케줄 표 중심 영역을 한 덩어리 표로 인식
      await worker.setParameters({
        tessedit_pageseg_mode: "6",
        preserve_interword_spaces: "1",
      });

      var tableResult = await worker.recognize(preparedImages.table);
      var tableText =
        tableResult && tableResult.data
          ? tableResult.data.text || ""
          : "";

      // 2차: 전체 화면에서 흩어진 텍스트를 보조 인식
      setScheduleImportLoading(true, "날짜와 시간을 한 번 더 확인하는 중...");

      await worker.setParameters({
        tessedit_pageseg_mode: "11",
        preserve_interword_spaces: "1",
      });

      var fullResult = await worker.recognize(preparedImages.full);
      var fullText =
        fullResult && fullResult.data
          ? fullResult.data.text || ""
          : "";

      var text = tableText + "\n" + fullText;

      console.log("무료 OCR - 표 영역:\n", tableText);
      console.log("무료 OCR - 전체 화면:\n", fullText);

      importedScheduleItems = parseScheduleText(text).map(normalizeImportedSchedule);

      if (!importedScheduleItems.length) {
        throw new Error(
          "사진에서 날짜와 출퇴근 시간을 찾지 못했습니다. 표의 날짜·출근·퇴근 영역이 보이도록 캡처한 사진을 사용해 주세요."
        );
      }

      renderImportedScheduleList();

    } catch (error) {
      console.error("무료 OCR 스케줄 가져오기 오류:", error);

      showScheduleImportError(
        error.message || "스케줄 사진을 읽지 못했습니다."
      );
    }
  }

  function preprocessScheduleImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);

      img.onload = function () {
        try {
          /*
           * 휴대폰 스크린샷은 원본 폭이 700~1200px 정도라
           * 작은 날짜/시간 글씨가 OCR에서 빠지는 경우가 많다.
           * 폭을 약 1900~2300px까지 확대해서 먼저 읽는다.
           */
          var targetWidth = 2100;
          var scale = Math.max(1.55, Math.min(2.6, targetWidth / img.width));
          var width = Math.max(1, Math.round(img.width * scale));
          var height = Math.max(1, Math.round(img.height * scale));

          function makeCanvas(sx, sy, sw, sh, outW) {
            var ratio = outW / sw;
            var outH = Math.max(1, Math.round(sh * ratio));

            var canvas = document.createElement("canvas");
            canvas.width = outW;
            canvas.height = outH;

            var ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";

            ctx.drawImage(
              img,
              sx, sy, sw, sh,
              0, 0, outW, outH
            );

            var imageData = ctx.getImageData(0, 0, outW, outH);
            var px = imageData.data;

            // 밝은 스크린샷 표에 맞춘 흑백 + 대비 보정.
            // 회색 글씨도 너무 날아가지 않도록 완전 이진화는 하지 않는다.
            for (var i = 0; i < px.length; i += 4) {
              var gray =
                px[i] * 0.299 +
                px[i + 1] * 0.587 +
                px[i + 2] * 0.114;

              var adjusted;

              if (gray > 238) {
                adjusted = 255;
              } else if (gray < 155) {
                adjusted = Math.max(0, gray - 34);
              } else {
                adjusted = Math.max(0, gray - 18);
              }

              px[i] = adjusted;
              px[i + 1] = adjusted;
              px[i + 2] = adjusted;
            }

            ctx.putImageData(imageData, 0, 0);
            return canvas;
          }

          // 전체 화면 보조 인식
          var fullCanvas = makeCanvas(
            0,
            0,
            img.width,
            img.height,
            width
          );

          /*
           * 일반적인 모바일 근무표 캡처:
           * 상단 앱바/사용자 이름은 제외하고,
           * 날짜·출근·퇴근·근태코드가 있는 중앙 표를 집중 인식한다.
           * 너무 과하게 자르지 않도록 세로 25%~86%를 사용한다.
           */
          var cropX = Math.round(img.width * 0.025);
          var cropY = Math.round(img.height * 0.25);
          var cropW = Math.round(img.width * 0.95);
          var cropH = Math.round(img.height * 0.61);

          var tableCanvas = makeCanvas(
            cropX,
            cropY,
            cropW,
            cropH,
            Math.min(2300, Math.max(1800, Math.round(cropW * scale * 1.12)))
          );

          URL.revokeObjectURL(url);

          resolve({
            full: fullCanvas,
            table: tableCanvas,
          });
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };

      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("사진을 불러올 수 없습니다."));
      };

      img.src = url;
    });
  }

  function parseScheduleText(text) {
    var cleaned = String(text || "")
      .replace(/\r/g, "\n")
      // OCR에서 날짜/시간 숫자 주변의 자주 생기는 오인식 보정
      .replace(/(?<=\d)[Oo](?=\d)/g, "0")
      .replace(/(?<=\d)[Il](?=\d)/g, "1")
      .replace(/[|｜]/g, " ")
      .replace(/[‐‑–—]/g, "-")
      .replace(/[：]/g, ":")
      .replace(/[．]/g, ".")
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")");

    var lines = cleaned
      .split(/\n+/)
      .map(function (line) {
        return line.replace(/\s+/g, " ").trim();
      })
      .filter(Boolean);

    var base = new Date();
    var context = detectYearMonth(cleaned, base);
    var events = [];

    /* =====================================================
       1. 날짜 블록 기준 판별 (최우선)

       Tesseract가 표 한 행을 여러 줄로 쪼개도 처리한다.

       예:
       07/20(월)
       15:00
       22:30
       정상
       07/21(화)
       정규휴일

       → 07/20 블록 전체에서 15:00 / 22:30을 찾고,
         다음 날짜(07/21)가 나오면 새 블록으로 넘어간다.
       ===================================================== */
    var blocks = [];
    var currentBlock = null;

    lines.forEach(function (line) {
      var dates = extractDatesFromLine(line, context.year, context.month);

      if (dates.length) {
        // 한 줄에 여러 날짜가 있는 특수 표는 기존 fallback이 처리하도록 넘긴다.
        if (dates.length === 1) {
          if (currentBlock) blocks.push(currentBlock);
          currentBlock = {
            date: dates[0],
            lines: [line],
          };
        } else {
          if (currentBlock) {
            blocks.push(currentBlock);
            currentBlock = null;
          }
        }
        return;
      }

      if (currentBlock) {
        currentBlock.lines.push(line);
      }
    });

    if (currentBlock) blocks.push(currentBlock);

    blocks.forEach(function (block) {
      // 너무 멀리 있는 다른 표 내용까지 붙는 것을 막기 위해 최대 8줄까지만 본다.
      var blockText = block.lines.slice(0, 8).join(" ");

      // 정규휴일 / 휴무 / 비번은 종일 일정으로 처리
      if (/정규\s*휴일|정규휴일|휴무|휴일|비번|공휴일/.test(blockText)) {
        var offShift = findShiftTypeByName("휴무") || findShiftTypeByName("비번");

        events.push({
          date: block.date,
          title: offShift ? offShift.name : "휴무",
          shiftName: offShift ? offShift.name : "휴무",
          allDay: true,
          start: "",
          end: "",
          place: "",
          memo: "무료 OCR 스케줄 가져오기",
        });
        return;
      }

      // P(계획)와 R(실적)이 함께 있는 표는 R 시간을 최우선으로 사용한다.
      // 예: P 06:00 / R 08:00, P 15:00 / R 15:00 → 08:00~15:00
      var preferredTimes = extractPreferredScheduleTimes(blockText);

      if (preferredTimes.start && preferredTimes.end) {
        var startTime = preferredTimes.start;
        var endTime = preferredTimes.end;
        var matchedShift = classifyShiftByStartTime(startTime);

        events.push({
          date: block.date,
          title: matchedShift ? matchedShift.name : "근무",
          shiftName: matchedShift ? matchedShift.name : "",
          allDay: false,
          start: startTime,
          end: endTime,
          attendanceSource: preferredTimes.source,
          place: "",
          memo: preferredTimes.source === "R"
            ? "무료 OCR 스케줄 가져오기 · R 실적 적용"
            : "무료 OCR 스케줄 가져오기",
        });
      }
    });

    /* =====================================================
       2. 한 줄짜리 시간표 fallback
       예: 07/20(월) 15:00 22:30 정상
       ===================================================== */
    lines.forEach(function (line) {
      var dates = extractDatesFromLine(line, context.year, context.month);
      if (dates.length !== 1) return;

      // 이미 블록 방식으로 같은 날짜가 만들어졌으면 건너뜀
      if (events.some(function (e) { return e.date === dates[0]; })) return;

      if (/정규\s*휴일|정규휴일|휴무|휴일|비번|공휴일/.test(line)) {
        var offShift = findShiftTypeByName("휴무") || findShiftTypeByName("비번");
        events.push({
          date: dates[0],
          title: offShift ? offShift.name : "휴무",
          shiftName: offShift ? offShift.name : "휴무",
          allDay: true,
          start: "",
          end: "",
          place: "",
          memo: "무료 OCR 스케줄 가져오기",
        });
        return;
      }

      var preferredTimes = extractPreferredScheduleTimes(line);
      if (preferredTimes.start && preferredTimes.end) {
        var startTime = preferredTimes.start;
        var endTime = preferredTimes.end;
        var matchedShift = classifyShiftByStartTime(startTime);

        events.push({
          date: dates[0],
          title: matchedShift ? matchedShift.name : "근무",
          shiftName: matchedShift ? matchedShift.name : "",
          allDay: false,
          start: startTime,
          end: endTime,
          attendanceSource: preferredTimes.source,
          place: "",
          memo: preferredTimes.source === "R"
            ? "무료 OCR 스케줄 가져오기 · R 실적 적용"
            : "무료 OCR 스케줄 가져오기",
        });
      }
    });

    /* =====================================================
       3. 기존 근무명 기준 판별 (최후 fallback)
       ===================================================== */
    lines.forEach(function (line) {
      var dates = extractDatesFromLine(line, context.year, context.month);
      var shiftHits = extractShiftHits(line);
      var timeRange = extractTimeRange(line);

      if (!dates.length || !shiftHits.length) return;

      if (dates.length === 1) {
        if (!events.some(function (e) { return e.date === dates[0]; })) {
          events.push(makeParsedEvent(dates[0], shiftHits[0], timeRange));
        }
        return;
      }

      if (dates.length === shiftHits.length) {
        for (var i = 0; i < dates.length; i++) {
          if (!events.some(function (e) { return e.date === dates[i]; })) {
            events.push(makeParsedEvent(dates[i], shiftHits[i], null));
          }
        }
      }
    });

    // 날짜 여러 개 행 + 근무명 여러 개 행
    for (var i = 0; i < lines.length - 1; i++) {
      var dateRow = extractDatesFromLine(lines[i], context.year, context.month);
      if (dateRow.length < 2) continue;

      for (var look2 = 1; look2 <= 3 && i + look2 < lines.length; look2++) {
        var shiftRow = extractShiftHits(lines[i + look2]);
        if (shiftRow.length === dateRow.length) {
          for (var j = 0; j < dateRow.length; j++) {
            if (!events.some(function (e) { return e.date === dateRow[j]; })) {
              events.push(makeParsedEvent(dateRow[j], shiftRow[j], null));
            }
          }
          break;
        }
      }
    }

    return dedupeParsedEvents(events);
  }

  /**
   * P = 계획, R = 실적(변경 후 실제 스케줄)로 사용하는 근무표를 처리한다.
   * 새 사진에 R 시간이 2개 이상 인식되면 반드시 R의 출근/퇴근을 사용한다.
   * R이 없거나 불완전하면 P를 사용하고, P도 없으면 일반 시간 추출로 fallback한다.
   */
  function extractPreferredScheduleTimes(text) {
    var source = String(text || "")
      .replace(/[Ⓡ®]/g, " R ")
      .replace(/[Ⓟ℗]/g, " P ")
      .replace(/[：]/g, ":")
      .replace(/[．]/g, ".");

    function markedTimes(marker) {
      var regex = new RegExp(
        "(?:^|[^A-Za-z0-9])" + marker + "\\s*[.:·_-]*\\s*(\\d{1,2})\\s*[:.]\\s*(\\d{2})(?!\\d)",
        "gi"
      );
      var found = [];
      var match;

      while ((match = regex.exec(source)) !== null) {
        var value = normalizeTime(match[1] + ":" + match[2]);
        if (value) found.push(value);
      }
      return found;
    }

    var rTimes = markedTimes("R");
    if (rTimes.length >= 2) {
      return { start: rTimes[0], end: rTimes[1], source: "R" };
    }

    var pTimes = markedTimes("P");
    if (pTimes.length >= 2) {
      return { start: pTimes[0], end: pTimes[1], source: "P" };
    }

    var times = extractTimesFromLine(source);
    var uniqueTimes = [];
    times.forEach(function (time) {
      if (uniqueTimes.indexOf(time) < 0) uniqueTimes.push(time);
    });

    return {
      start: uniqueTimes[0] || "",
      end: uniqueTimes[1] || "",
      source: "",
    };
  }

  /** 한 줄에서 HH:MM 형태의 시간을 순서대로 모두 추출 */
  function extractTimesFromLine(line) {
    var source = String(line || "")
      .replace(/[：]/g, ":")
      .replace(/[．]/g, ".");

    var matches = source.match(/(?:^|[^\d])(\d{1,2})\s*[:.]\s*(\d{2})(?!\d)/g) || [];
    var times = [];

    matches.forEach(function (raw) {
      var m = raw.match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
      if (!m) return;

      var value = normalizeTime(m[1] + ":" + m[2]);
      if (value) times.push(value);
    });

    return times;
  }

  /**
   * 시작 시간 기준으로 근무 유형을 자동 판별한다.
   * 05:00~09:59  → 오픈
   * 10:00~14:59  → 미들
   * 15:00~23:59  → 마감
   *
   * ShiftMate 설정에 같은 이름의 근무 유형이 있으면 그 ID를 연결하고,
   * 없으면 이름만 오픈/미들/마감으로 사용한다.
   */
  function classifyShiftByStartTime(start) {
    start = normalizeTime(start);
    if (!start) return null;

    var hour = Number(start.split(":")[0]);
    var name = "";

    if (hour >= 5 && hour < 10) {
      name = "오픈";
    } else if (hour >= 10 && hour < 15) {
      name = "미들";
    } else if (hour >= 15) {
      name = "마감";
    } else {
      // 00:00~04:59 시작은 일반 근무로 둔다.
      name = "근무";
    }

    var registered = findShiftTypeByName(name);
    if (registered) return registered;

    return {
      id: "",
      name: name,
      start: "",
      end: "",
    };
  }

  function detectYearMonth(text, baseDate) {
    var year = baseDate.getFullYear();
    var month = baseDate.getMonth() + 1;
    var m;

    m = text.match(/(20\d{2})\s*[년.\/-]\s*(1[0-2]|0?[1-9])\s*월?/);
    if (m) {
      year = Number(m[1]);
      month = Number(m[2]);
      return { year: year, month: month };
    }

    m = text.match(/(1[0-2]|0?[1-9])\s*월/);
    if (m) month = Number(m[1]);

    m = text.match(/\b(20\d{2})\b/);
    if (m) year = Number(m[1]);

    return { year: year, month: month };
  }

  function extractDatesFromLine(line, fallbackYear, fallbackMonth) {
    var found = [];
    var occupied = [];
    var match;

    function pushDate(year, month, day, start, end) {
      year = Number(year);
      month = Number(month);
      day = Number(day);
      if (!isValidYmd(year, month, day)) return;
      var key = year + "-" + pad(month) + "-" + pad(day);
      if (found.indexOf(key) < 0) found.push(key);
      occupied.push([start, end]);
    }

    var full = /(20\d{2})\s*[.\/-]\s*(1[0-2]|0?[1-9])\s*[.\/-]\s*(3[01]|[12]?\d)/g;
    while ((match = full.exec(line))) {
      pushDate(match[1], match[2], match[3], match.index, full.lastIndex);
    }

    var korean = /(20\d{2})\s*년\s*(1[0-2]|0?[1-9])\s*월\s*(3[01]|[12]?\d)\s*일?/g;
    while ((match = korean.exec(line))) {
      pushDate(match[1], match[2], match[3], match.index, korean.lastIndex);
    }

    var md = /(^|[^\d])(1[0-2]|0?[1-9])\s*[.\/-]\s*(3[01]|[12]?\d)(?!\s*[:\d])/g;
    while ((match = md.exec(line))) {
      var s = match.index + match[1].length;
      var e = md.lastIndex;
      var overlaps = occupied.some(function (r) { return s < r[1] && e > r[0]; });
      if (!overlaps) pushDate(fallbackYear, match[2], match[3], s, e);
    }

    var mdKo = /(1[0-2]|0?[1-9])\s*월\s*(3[01]|[12]?\d)\s*일?/g;
    while ((match = mdKo.exec(line))) {
      pushDate(fallbackYear, match[1], match[2], match.index, mdKo.lastIndex);
    }

    // 날짜만 적힌 표의 헤더. 시간/연도처럼 보이는 숫자는 제외
    if (!found.length) {
      var dayOnly = line.match(/^\s*(3[01]|[12]?\d)\s*(?:일|\([월화수목금토일]\))?\s*$/);
      if (dayOnly) pushDate(fallbackYear, fallbackMonth, dayOnly[1], 0, line.length);
    }

    // 날짜 행: "1 2 3 4 5 ...". 근무명이 없는 줄에서만 허용
    if (!found.length && !extractShiftHits(line).length && !/:/.test(line)) {
      var nums = line.match(/\b(?:3[01]|[12]?\d)\b/g) || [];
      if (nums.length >= 2 && nums.length <= 31) {
        nums.forEach(function (n) {
          pushDate(fallbackYear, fallbackMonth, n, 0, 0);
        });
      }
    }

    return found;
  }

  function extractShiftHits(line) {
    var source = String(line || "");
    var hits = [];

    data.shiftTypes.forEach(function (shift) {
      var name = String(shift.name || "").trim();
      if (!name) return;

      var re = new RegExp(escapeRegExp(name), "gi");
      var m;
      while ((m = re.exec(source))) {
        hits.push({
          name: shift.name,
          index: m.index,
          shiftTypeId: shift.id,
        });
        if (!m[0].length) re.lastIndex++;
      }
    });

    var aliases = [
      { re: /\bday\b|주간|주근/gi, name: "주간" },
      { re: /\bnight\b|야간|야근/gi, name: "야간" },
      { re: /\boff\b|비번/gi, name: "비번" },
      { re: /휴무|휴일|off\s*day/gi, name: "휴무" },
    ];

    aliases.forEach(function (alias) {
      var m;
      while ((m = alias.re.exec(source))) {
        if (!hits.some(function (h) { return Math.abs(h.index - m.index) < 2; })) {
          var shift = findShiftTypeByName(alias.name);
          hits.push({
            name: shift ? shift.name : alias.name,
            index: m.index,
            shiftTypeId: shift ? shift.id : "",
          });
        }
        if (!m[0].length) alias.re.lastIndex++;
      }
    });

    hits.sort(function (a, b) { return a.index - b.index; });
    return hits;
  }

  function extractTimeRange(line) {
    var m = String(line || "").match(
      /(\d{1,2}(?::|\.)\d{2}|\b\d{3,4}\b)\s*(?:~|-|부터|–)\s*(\d{1,2}(?::|\.)\d{2}|\b\d{3,4}\b)/
    );

    if (!m) return null;

    var start = normalizeTime(m[1]);
    var end = normalizeTime(m[2]);

    return start || end ? { start: start, end: end } : null;
  }

  function makeParsedEvent(date, shiftHit, timeRange) {
    var shift = shiftHit && shiftHit.shiftTypeId
      ? shiftById(shiftHit.shiftTypeId)
      : findShiftTypeByName(shiftHit ? shiftHit.name : "");

    var start = timeRange && timeRange.start ? timeRange.start : (shift ? shift.start : "");
    var end = timeRange && timeRange.end ? timeRange.end : (shift ? shift.end : "");
    var allDay = !start && !end;
    var name = shift ? shift.name : (shiftHit ? shiftHit.name : "근무");

    return {
      date: date,
      title: name,
      shiftName: name,
      allDay: allDay,
      start: start,
      end: end,
      place: "",
      memo: "무료 OCR 스케줄 가져오기",
    };
  }

  function dedupeParsedEvents(events) {
    var seen = {};
    return events
      .filter(function (item) { return item && item.date; })
      .filter(function (item) {
        var key = item.date + "|" + item.shiftName + "|" + item.start + "|" + item.end;
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
  }

  function isValidYmd(year, month, day) {
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
    return day <= daysInMonth(year, month);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function renderImportedScheduleList() {
    $("scheduleImportLoading").hidden = true;
    $("scheduleImportResult").hidden = false;
    $("scheduleImportError").hidden = true;

    var box = $("scheduleImportList");
    var html = "";

    importedScheduleItems.forEach(function (item, index) {
      html +=
        '<div class="schedule-import-item" data-import-index="' + index + '">' +
        '<label class="schedule-import-item__check">' +
        '<input type="checkbox" data-import-check="' + index + '" ' +
        (item.selected ? "checked" : "") + '>' +
        '<strong>일정 ' + (index + 1) + "</strong>" +
        (item.attendanceSource === "R"
          ? '<span class="schedule-import-source schedule-import-source--r">R 실적 적용</span>'
          : (item.attendanceSource === "P"
            ? '<span class="schedule-import-source">P 계획</span>'
            : "")) +
        "</label>" +
        '<label><span>날짜</span>' +
        '<input type="date" data-import-date="' + index + '" value="' + escapeHtml(item.date) + '">' +
        "</label>" +
        '<label><span>근무</span>' +
        '<select data-import-shift="' + index + '">' +
        buildImportedShiftOptions(item.shiftTypeId) +
        "</select></label>" +
        '<label><span>시작</span>' +
        '<input type="time" data-import-start="' + index + '" value="' + escapeHtml(item.start) + '">' +
        "</label>" +
        '<label><span>종료</span>' +
        '<input type="time" data-import-end="' + index + '" value="' + escapeHtml(item.end) + '">' +
        "</label>" +
        '<label><span>휴게시간</span>' +
        '<select data-import-break-mode="' + index + '">' +
        '<option value="auto" ' + (item.breakMode !== "manual" ? "selected" : "") + '>자동</option>' +
        '<option value="manual" ' + (item.breakMode === "manual" ? "selected" : "") + '>직접 설정</option>' +
        '</select></label>' +
        '<label><span>휴게(분)</span>' +
        '<input type="number" min="0" step="5" data-import-break="' + index + '" value="' + Math.max(0, Number(item.breakMinutes) || 0) + '" ' + (item.breakMode === "manual" ? "" : "disabled") + '>' +
        "</label>" +
        '<label style="grid-column:1/-1"><span>제목</span>' +
        '<input type="text" data-import-title="' + index + '" value="' + escapeHtml(item.title) + '">' +
        "</label>" +
        "</div>";
    });

    box.innerHTML = html;

    $("scheduleImportSaveBtn").disabled =
      !importedScheduleItems.some(function (item) {
        return item.selected && item.date;
      });
  }

  function buildImportedShiftOptions(selectedId) {
    var html = '<option value="">지정 없음</option>';

    data.shiftTypes.forEach(function (shift) {
      html +=
        '<option value="' + escapeHtml(shift.id) + '" ' +
        (shift.id === selectedId ? "selected" : "") +
        ">" + escapeHtml(shift.name) + "</option>";
    });

    return html;
  }

  function syncImportedItem(index) {
    var item = importedScheduleItems[index];
    if (!item) return;

    var check = document.querySelector('[data-import-check="' + index + '"]');
    var date = document.querySelector('[data-import-date="' + index + '"]');
    var shift = document.querySelector('[data-import-shift="' + index + '"]');
    var start = document.querySelector('[data-import-start="' + index + '"]');
    var end = document.querySelector('[data-import-end="' + index + '"]');
    var title = document.querySelector('[data-import-title="' + index + '"]');
    var breakMode = document.querySelector('[data-import-break-mode="' + index + '"]');
    var breakInput = document.querySelector('[data-import-break="' + index + '"]');

    item.selected = check ? check.checked : false;
    item.date = date ? date.value : "";
    item.shiftTypeId = shift ? shift.value : "";
    item.start = start ? start.value : "";
    item.end = end ? end.value : "";
    item.title = title ? title.value.trim() : "일정";
    item.breakMode = breakMode && breakMode.value === "manual" ? "manual" : "auto";

    var shiftType = shiftById(item.shiftTypeId);

    if (shiftType) {
      item.shiftName = shiftType.name;

      if (!item.start && shiftType.start) {
        item.start = shiftType.start;
        if (start) start.value = shiftType.start;
      }

      if (!item.end && shiftType.end) {
        item.end = shiftType.end;
        if (end) end.value = shiftType.end;
      }

      if (!item.title) {
        item.title = shiftType.name;
        if (title) title.value = shiftType.name;
      }

      item.allDay = !shiftType.start && !shiftType.end;
    } else {
      item.allDay = !item.start && !item.end;
    }

    if (item.allDay) {
      item.breakMinutes = 0;
    } else if (item.breakMode === "manual") {
      item.breakMinutes = Math.max(0, Number(breakInput ? breakInput.value : item.breakMinutes) || 0);
    } else {
      item.breakMinutes = autoBreakMinutes(item.start, item.end);
      if (breakInput) breakInput.value = item.breakMinutes;
    }
    if (breakInput) breakInput.disabled = item.breakMode !== "manual";
  }

  function saveImportedSchedule() {
    importedScheduleItems.forEach(function (_, index) {
      syncImportedItem(index);
    });

    var selected = importedScheduleItems.filter(function (item) {
      return item.selected && item.date;
    });

    if (!selected.length) {
      toast("추가할 일정을 선택해 주세요.");
      return;
    }

    /*
     * 새 근무표 사진을 다시 불러오면 같은 달에 이전 OCR로 등록했던
     * 근무표만 먼저 지운 뒤 새 결과로 교체한다.
     * 사용자가 직접 추가한 약속/일정은 삭제하지 않는다.
     *
     * 예전 버전에서 저장된 OCR 일정에는 source가 없을 수 있으므로
     * memo의 "OCR 스케줄 가져오기" 문구도 함께 확인한다.
     */
    var replaceMonths = {};
    selected.forEach(function (item) {
      if (item.date) replaceMonths[item.date.slice(0, 7)] = true;
    });

    var removedCount = 0;
    data.events = data.events.filter(function (event) {
      var sameMonth = event.date && replaceMonths[event.date.slice(0, 7)];
      var isOcrSchedule =
        event.source === "schedule-ocr" ||
        /OCR\s*스케줄\s*가져오기/i.test(String(event.memo || ""));

      if (sameMonth && isOcrSchedule) {
        removedCount++;
        return false;
      }
      return true;
    });

    var addedCount = 0;

    selected.forEach(function (item) {
      data.events.push({
        id: uid(),
        date: item.date,
        title: item.title || item.shiftName || "일정",
        allDay: item.allDay,
        start: item.allDay ? "" : item.start,
        end: item.allDay ? "" : item.end,
        shiftTypeId: item.shiftTypeId || "",
        place: item.place || "",
        memo: item.memo || "무료 OCR 스케줄 가져오기",
        source: "schedule-ocr",
        attendanceSource: item.attendanceSource === "R" ? "R" : (item.attendanceSource === "P" ? "P" : ""),
        breakMode: item.breakMode === "manual" ? "manual" : "auto",
        breakMinutes: item.allDay ? 0 : Math.max(0, Number(item.breakMinutes) || 0),
      });

      addedCount++;
    });

    if (selected.length === 1) {
      selectedDate = selected[0].date;
    }

    save();

    var lastDate = fromKey(selected[selected.length - 1].date);
    cursor = startOfMonth(lastDate);

    renderAll();
    closeModal("scheduleImportModal");
    if (removedCount > 0) {
      toast("기존 OCR 근무표 " + removedCount + "개를 지우고 새 일정 " + addedCount + "개로 교체했습니다.");
    } else {
      toast(addedCount + "개의 새 근무 일정을 추가했습니다.");
    }
  }

  function saveEvent() {
    var title = $("evTitle").value.trim();
    var date = $("evDate").value;
    if (!date) {
      toast("날짜를 선택해 주세요.");
      return;
    }
    var shiftId = $("evShift").value;
    var st = shiftById(shiftId);
    if (!title) title = st ? st.name : "일정";

    var allDay = $("evAllDay").checked;
    var payload = {
      date: date,
      title: title,
      allDay: allDay,
      start: allDay ? "" : $("evStart").value,
      end: allDay ? "" : $("evEnd").value,
      shiftTypeId: shiftId,
      place: $("evPlace").value.trim(),
      memo: $("evMemo").value.trim(),
      breakMode: allDay ? "auto" : ($("evBreakMode").value === "manual" ? "manual" : "auto"),
      breakMinutes: allDay ? 0 : ($("evBreakMode").value === "manual"
        ? Math.max(0, Number($("evBreakMinutes").value) || 0)
        : autoBreakMinutes($("evStart").value, $("evEnd").value)),
    };

    if (editingEventId) {
      data.events = data.events.map(function (e) {
        if (e.id !== editingEventId) return e;
        return Object.assign({}, e, payload);
      });
      toast("일정을 수정했습니다.");
    } else {
      payload.id = uid();
      data.events.push(payload);
      toast("일정을 추가했습니다.");
    }

    selectedDate = date;
    save();
    renderAll();
    closeModal("eventModal");
  }

  function deleteEvent() {
    if (!editingEventId) return;
    data.events = data.events.filter(function (e) {
      return e.id !== editingEventId;
    });
    save();
    renderAll();
    closeModal("eventModal");
    toast("일정을 삭제했습니다.");
  }

  /* ---------------------------------------------------------
     가계부 사진 OCR
     --------------------------------------------------------- */
  function parseReceiptDate(text) {
    var src = String(text || "");
    var m = src.match(/\b(20\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})\b/);
    if (m) {
      var y = Number(m[1]);
      var mo = Number(m[2]);
      var d = Number(m[3]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) {
        return y + "-" + pad(mo) + "-" + pad(d);
      }
    }

    m = src.match(/\b(\d{2})\s*[.\/-]\s*(\d{1,2})\s*[.\/-]\s*(\d{1,2})\b/);
    if (m) {
      var yy = 2000 + Number(m[1]);
      var mm = Number(m[2]);
      var dd = Number(m[3]);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysInMonth(yy, mm)) {
        return yy + "-" + pad(mm) + "-" + pad(dd);
      }
    }

    m = src.match(/\b(\d{1,2})\s*월\s*(\d{1,2})\s*일\b/);
    if (m) {
      var fy = finCursor.getFullYear();
      var fm = Number(m[1]);
      var fd = Number(m[2]);
      if (fm >= 1 && fm <= 12 && fd >= 1 && fd <= daysInMonth(fy, fm)) {
        return fy + "-" + pad(fm) + "-" + pad(fd);
      }
    }

    return defaultFinanceDate();
  }

  function receiptNumbers(line) {
    var out = [];
    String(line || "").replace(/(?:₩|￦|원)?\s*(\d{1,3}(?:,\d{3})+|\d{3,8})\s*(?:원)?/g, function (_, raw) {
      var n = Number(String(raw).replace(/,/g, ""));
      if (n >= 100 && n <= 99999999) out.push(n);
      return _;
    });
    return out;
  }

  function parseReceiptAmount(text) {
    var lines = String(text || "").split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var strong = /결제\s*금액|승인\s*금액|합계\s*금액|총\s*금액|총액|합계|받을\s*금액|청구\s*금액|카드\s*결제/i;
    var weak = /금액|결제|total|amount/i;
    var candidates = [];

    lines.forEach(function (line) {
      var nums = receiptNumbers(line);
      if (!nums.length) return;
      var score = strong.test(line) ? 100 : weak.test(line) ? 30 : 0;
      nums.forEach(function (n) {
        candidates.push({ amount: n, score: score });
      });
    });

    if (!candidates.length) return 0;
    candidates.sort(function (a, b) {
      if (a.score !== b.score) return b.score - a.score;
      return b.amount - a.amount;
    });
    return candidates[0].amount;
  }

  function guessReceiptCategory(text) {
    var t = String(text || "").toLowerCase();
    if (/카페|커피|스타벅스|메가커피|컴포즈|빽다방|음식|식당|분식|치킨|피자|버거|배달|restaurant|cafe|coffee/.test(t)) return "식비";
    if (/버스|지하철|택시|주유|주차|철도|기차|교통|t-money|tmoney/.test(t)) return "교통";
    if (/월세|관리비|전기|가스|수도|통신|휴대폰|인터넷/.test(t)) return "주거·통신";
    if (/마트|편의점|다이소|생활|세제|휴지|문구/.test(t)) return "생활용품";
    if (/약국|병원|의원|치과|의료|건강/.test(t)) return "의료·건강";
    if (/영화|극장|공연|노래방|게임|문화|여가|여행/.test(t)) return "문화·여가";
    if (/미용|헤어|네일|의류|옷|신발|화장품/.test(t)) return "의류·미용";
    if (/축의|부의|경조/.test(t)) return "경조사";
    if (/증권|주식|펀드|저축|적금|투자/.test(t)) return "저축·투자";
    return "기타";
  }

  function guessReceiptMemo(text) {
    var skip = /사업자|대표자|주소|전화|tel|카드|승인|거래|영수증|매출|합계|금액|부가세|과세|면세|일시|날짜|date|total|amount/i;
    var lines = String(text || "").split(/\n+/).map(function (x) {
      return x.replace(/\s+/g, " ").trim();
    }).filter(Boolean);

    for (var i = 0; i < Math.min(lines.length, 12); i++) {
      var line = lines[i];
      if (line.length < 2 || line.length > 35) continue;
      if (skip.test(line)) continue;
      if (/^[\d\s:./,\-₩￦원]+$/.test(line)) continue;
      if (/[가-힣A-Za-z]/.test(line)) return line;
    }
    return "사진 OCR 가져오기";
  }

  async function importTransactionImage(file) {
    if (!file) return;

    if (!/^image\/(png|jpeg|webp)$/.test(file.type || "")) {
      toast("JPG, PNG, WEBP 영수증 사진을 선택해 주세요.");
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      toast("사진 크기는 15MB 이하로 선택해 주세요.");
      return;
    }

    var btn = $("importTxImageBtn");
    var originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "영수증 읽는 중...";
    toast("영수증에서 날짜와 금액을 읽고 있어요...");

    try {
      var worker = await getOcrWorker();

      // 영수증은 줄 단위 구조가 중요해서 6 모드로 우선 인식
      await worker.setParameters({
        tessedit_pageseg_mode: "6",
        preserve_interword_spaces: "1",
      });

      var result = await worker.recognize(file);
      var text = result && result.data ? result.data.text || "" : "";

      if (!text.trim()) {
        throw new Error("영수증에서 글자를 읽지 못했습니다.");
      }

      console.log("가계부 영수증 OCR:\n", text);

      var parsedDate = parseReceiptDate(text);
      var parsedAmount = parseReceiptAmount(text);
      var parsedCategory = guessReceiptCategory(text);
      var parsedMemo = guessReceiptMemo(text);

      /*
       * 금액까지 정상 인식되면 사용자가 저장 버튼을 누르지 않아도
       * 가계부 지출 내역으로 바로 등록한다.
       */
      if (parsedAmount > 0) {
        var duplicate = data.transactions.some(function (t) {
          return (
            t.kind === "expense" &&
            t.date === parsedDate &&
            Number(t.amount) === Number(parsedAmount) &&
            String(t.memo || "") === String(parsedMemo || "")
          );
        });

        if (duplicate) {
          toast("같은 날짜·금액의 영수증이 이미 등록되어 있어 중복 추가하지 않았습니다.");
          return;
        }

        data.transactions.push({
          id: uid(),
          date: parsedDate,
          kind: "expense",
          amount: Number(parsedAmount),
          category:
            EXPENSE_CATEGORIES.indexOf(parsedCategory) >= 0
              ? parsedCategory
              : "기타",
          memo: parsedMemo || "영수증 OCR 자동등록",
          source: "receipt-ocr",
        });

        save();

        var receiptDate = fromKey(parsedDate);
        finCursor = startOfMonth(receiptDate);

        renderAll();

        toast(
          formatKRW(parsedAmount) +
            " · " +
            (parsedCategory || "기타") +
            " 자동 등록 완료"
        );
        return;
      }

      /*
       * 금액을 못 읽었을 때는 잘못된 0원 내역을 자동 저장하지 않고
       * 기존 입력 창에 OCR 결과를 채워 사용자가 직접 확인하게 한다.
       */
      openTxModal(null);
      setTxKind("expense");
      $("txDate").value = parsedDate;
      $("txAmount").value = "";
      $("txCategory").value =
        EXPENSE_CATEGORIES.indexOf(parsedCategory) >= 0
          ? parsedCategory
          : "기타";
      $("txMemo").value = parsedMemo;
      $("txOcrNotice").hidden = false;

      toast("금액을 정확히 읽지 못했습니다. 금액만 확인해서 저장해 주세요.");
    } catch (err) {
      console.error("가계부 영수증 OCR 오류:", err);
      toast(
        err && err.message
          ? err.message
          : "영수증 사진을 읽지 못했습니다."
      );
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }

  /* ---------------------------------------------------------
     11. 거래 모달
     --------------------------------------------------------- */
  function fillCategorySelect() {
    var list = txKind === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
    var current = $("txCategory").value;
    var html = "";
    list.forEach(function (c) {
      html += '<option value="' + c + '">' + c + "</option>";
    });
    $("txCategory").innerHTML = html;
    if (list.indexOf(current) >= 0) $("txCategory").value = current;
  }

  function setTxKind(kind) {
    txKind = kind;
    document.querySelectorAll("#txKind .segmented__item").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-kind") === kind);
    });
    fillCategorySelect();
  }

  function openTxModal(txId) {
    editingTxId = txId || null;
    if ($("txOcrNotice")) $("txOcrNotice").hidden = true;
    var tx = null;
    if (txId) {
      tx = data.transactions.filter(function (t) {
        return t.id === txId;
      })[0];
    }

    $("txModalTitle").textContent = tx ? "내역 수정" : "내역 추가";
    $("txDelete").hidden = !tx;

    setTxKind(tx ? tx.kind : "expense");
    $("txDate").value = tx ? tx.date : defaultFinanceDate();
    $("txAmount").value = tx ? Number(tx.amount).toLocaleString("ko-KR") : "";
    $("txCategory").value = tx ? tx.category : txKind === "expense" ? "식비" : "급여";
    $("txMemo").value = tx ? tx.memo : "";

    openModal("txModal");
    setTimeout(function () {
      $("txAmount").focus();
    }, 60);
  }

  /** 가계부가 보고 있는 달 기준 기본 날짜 (이번 달이면 오늘) */
  function defaultFinanceDate() {
    var today = new Date();
    if (
      today.getFullYear() === finCursor.getFullYear() &&
      today.getMonth() === finCursor.getMonth()
    ) {
      return toKey(today);
    }
    return toKey(new Date(finCursor.getFullYear(), finCursor.getMonth(), 1));
  }

  function saveTx() {
    var amount = parseDigits($("txAmount").value);
    if (amount <= 0) {
      toast("금액을 입력해 주세요.");
      return;
    }
    var date = $("txDate").value;
    if (!date) {
      toast("날짜를 선택해 주세요.");
      return;
    }

    var payload = {
      date: date,
      kind: txKind,
      amount: amount,
      category: $("txCategory").value || "기타",
      memo: $("txMemo").value.trim(),
    };

    if (editingTxId) {
      data.transactions = data.transactions.map(function (t) {
        if (t.id !== editingTxId) return t;
        return Object.assign({}, t, payload);
      });
      toast("내역을 수정했습니다.");
    } else {
      payload.id = uid();
      data.transactions.push(payload);
      toast("내역을 추가했습니다.");
    }

    finCursor = new Date(fromKey(date).getFullYear(), fromKey(date).getMonth(), 1);
    save();
    renderFinance();
    closeModal("txModal");
  }

  function deleteTx() {
    if (!editingTxId) return;
    data.transactions = data.transactions.filter(function (t) {
      return t.id !== editingTxId;
    });
    save();
    renderFinance();
    closeModal("txModal");
    toast("내역을 삭제했습니다.");
  }

  /* ---------------------------------------------------------
     12. 급여 모달
     --------------------------------------------------------- */
  function openSalaryModal(salId) {
    editingSalaryId = salId || null;
    var s = null;
    if (salId) {
      s = data.salaries.filter(function (x) {
        return x.id === salId;
      })[0];
    }

    $("salaryModalTitle").textContent = s ? "월급 수정" : "월급 설정";
    $("salDelete").hidden = !s;
    $("salLabel").value = s ? s.label : "내 월급";
    $("salPayDay").value = s ? s.payDay : 25;
    $("salAmount").value = s ? Number(s.amount).toLocaleString("ko-KR") : "";
    $("salBudget").value = s ? Number(s.budget).toLocaleString("ko-KR") : "";

    openModal("salaryModal");
  }

  function saveSalary() {
    var payDay = clamp(Number($("salPayDay").value) || 25, 1, 31);
    var payload = {
      label: $("salLabel").value.trim() || "월급",
      payDay: payDay,
      amount: parseDigits($("salAmount").value),
      budget: parseDigits($("salBudget").value),
    };

    if (editingSalaryId) {
      data.salaries = data.salaries.map(function (s) {
        if (s.id !== editingSalaryId) return s;
        return Object.assign({}, s, payload);
      });
      toast("월급 정보를 수정했습니다.");
    } else {
      payload.id = uid();
      data.salaries.push(payload);
      toast("월급 정보를 저장했습니다.");
    }

    save();
    renderFinance();
    closeModal("salaryModal");
  }

  function deleteSalary() {
    if (!editingSalaryId) return;
    data.salaries = data.salaries.filter(function (s) {
      return s.id !== editingSalaryId;
    });
    save();
    renderFinance();
    closeModal("salaryModal");
    toast("월급 정보를 삭제했습니다.");
  }

  /* ---------------------------------------------------------
     13. 근무 유형 모달
     --------------------------------------------------------- */
  function renderSwatches() {
    var html = "";
    PRESET_COLORS.forEach(function (c) {
      html +=
        '<button type="button" class="swatch' +
        (c === shiftColor ? " is-active" : "") +
        '" data-color="' +
        c +
        '" style="background:' +
        c +
        '" aria-label="색상 ' +
        c +
        '"></button>';
    });
    $("stColors").innerHTML = html;
  }

  function openShiftModal(shiftId) {
    editingShiftId = shiftId || null;
    var t = shiftId ? shiftById(shiftId) : null;

    $("shiftModalTitle").textContent = t ? "근무 유형 수정" : "근무 유형 추가";
    $("stName").value = t ? t.name : "";
    $("stStart").value = t ? t.start : "";
    $("stEnd").value = t ? t.end : "";
    shiftColor = t ? t.color : PRESET_COLORS[0];
    renderSwatches();

    openModal("shiftModal");
    setTimeout(function () {
      $("stName").focus();
    }, 60);
  }

  function saveShift() {
    var name = $("stName").value.trim();
    if (!name) {
      toast("근무 유형 이름을 입력해 주세요.");
      return;
    }
    var payload = {
      name: name,
      color: shiftColor,
      start: $("stStart").value,
      end: $("stEnd").value,
    };

    if (editingShiftId) {
      data.shiftTypes = data.shiftTypes.map(function (t) {
        if (t.id !== editingShiftId) return t;
        return Object.assign({}, t, payload);
      });
      toast("근무 유형을 수정했습니다.");
    } else {
      payload.id = uid();
      data.shiftTypes.push(payload);
      toast("근무 유형을 추가했습니다.");
    }

    save();
    renderAll();
    closeModal("shiftModal");
  }

  function deleteShift(id) {
    var t = shiftById(id);
    if (!t) return;
    if (!confirm('"' + t.name + '" 근무 유형을 삭제할까요?\n이 유형을 쓰던 일정은 유지되고 유형만 해제됩니다.')) {
      return;
    }
    data.shiftTypes = data.shiftTypes.filter(function (x) {
      return x.id !== id;
    });
    data.events = data.events.map(function (e) {
      if (e.shiftTypeId !== id) return e;
      return Object.assign({}, e, { shiftTypeId: "" });
    });
    save();
    renderAll();
    toast("근무 유형을 삭제했습니다.");
  }

  /* ---------------------------------------------------------
     14. 백업 / 복원
     --------------------------------------------------------- */
  function exportData() {
    var json = JSON.stringify(data);
    var code;
    try {
      // 한글이 포함된 JSON 을 안전하게 Base64 로 변환
      code = btoa(unescape(encodeURIComponent(json)));
    } catch (err) {
      code = json;
    }
    $("backupBox").value = code;
    toast("백업 코드를 만들었습니다. 복사해 두세요.");
  }

  function importData() {
    var raw = $("backupBox").value.trim();
    if (!raw) {
      toast("백업 코드를 붙여 넣어 주세요.");
      return;
    }
    var json = raw;
    // Base64 형태면 먼저 복호화 시도
    if (!/^[\s{[]/.test(raw)) {
      try {
        json = decodeURIComponent(escape(atob(raw)));
      } catch (err) {
        toast("백업 코드를 읽을 수 없습니다.");
        return;
      }
    }
    var parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      toast("백업 코드 형식이 올바르지 않습니다.");
      return;
    }
    if (!confirm("현재 기록을 모두 지우고 백업 내용으로 바꿉니다. 계속할까요?")) return;

    data = normalize(parsed);
    save();
    renderAll();
    toast("백업을 불러왔습니다.");
  }

  function downloadBackup() {
    if (!$("backupBox").value.trim()) exportData();
    var blob = new Blob([$("backupBox").value], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "shiftmate-backup-" + toKey(new Date()) + ".txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function copyBackup() {
    var box = $("backupBox");
    if (!box.value.trim()) exportData();
    box.select();
    var ok = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(
        function () {
          toast("백업 코드를 복사했습니다.");
        },
        function () {
          toast("복사에 실패했습니다. 직접 선택해 복사해 주세요.");
        },
      );
      return;
    }
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    toast(ok ? "백업 코드를 복사했습니다." : "복사에 실패했습니다.");
  }

  function resetAll() {
    if (!confirm("모든 일정과 가계부 기록을 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) return;
    data = defaultData();
    save();
    renderAll();
    toast("초기화했습니다.");
  }

  /* ---------------------------------------------------------
     15. 이벤트 바인딩
     --------------------------------------------------------- */
  function bind() {
    // 화면 전환
    document.querySelectorAll("[data-view]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setView(btn.getAttribute("data-view"));
      });
    });

    // 드로어
    $("menuToggle").addEventListener("click", openDrawer);
    $("scrim").addEventListener("click", closeDrawer);

    // 테마
    $("themeToggle").addEventListener("click", toggleTheme);
    $("themeToggleMobile").addEventListener("click", toggleTheme);

    // 백업 바로가기
    $("backupShortcut").addEventListener("click", function () {
      setView("settings");
      setTimeout(function () {
        $("backupBox").scrollIntoView({ behavior: "smooth", block: "center" });
      }, 180);
    });

    // 달력 이동
    $("prevMonth").addEventListener("click", function () {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
      renderCalendar();
    });
    $("nextMonth").addEventListener("click", function () {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      renderCalendar();
    });
    $("todayBtn").addEventListener("click", function () {
      var now = new Date();
      cursor = startOfMonth(now);
      selectedDate = toKey(now);
      renderCalendar();
    });

    // 날짜 셀 클릭 (이벤트 위임)
    $("calendarGrid").addEventListener("click", function (e) {
      var cell = e.target.closest("[data-date]");
      if (!cell) return;
      selectedDate = cell.getAttribute("data-date");
      var d = fromKey(selectedDate);
      if (d.getMonth() !== cursor.getMonth() || d.getFullYear() !== cursor.getFullYear()) {
        cursor = startOfMonth(d);
      }
      renderCalendar();
      $("dayPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    // 일정 추가 버튼
    $("addEventBtn").addEventListener("click", function () {
      openEventModal(null, selectedDate);
    });
        // AI 스케줄 사진 가져오기
    $("importScheduleBtn").addEventListener("click", function () {
      $("scheduleImageInput").click();
    });

    $("scheduleImageInput").addEventListener("change", function () {
      var file = this.files && this.files[0];

      if (file) {
        importScheduleImage(file);
      }

      // 같은 사진을 다시 선택할 수 있도록 초기화
      this.value = "";
    });

    $("scheduleImportList").addEventListener("input", function (e) {
      var index = e.target.closest("[data-import-index]");

      if (!index) return;

      var i = Number(index.getAttribute("data-import-index"));

      syncImportedItem(i);

      $("scheduleImportSaveBtn").disabled =
        !importedScheduleItems.some(function (item) {
          return item.selected && item.date;
        });
    });

    $("scheduleImportList").addEventListener("change", function (e) {
      var row = e.target.closest("[data-import-index]");

      if (!row) return;

      var i = Number(row.getAttribute("data-import-index"));

      syncImportedItem(i);

      $("scheduleImportSaveBtn").disabled =
        !importedScheduleItems.some(function (item) {
          return item.selected && item.date;
        });
    });

    $("scheduleImportSaveBtn").addEventListener(
      "click",
      saveImportedSchedule
    );
    $("addEventBtn2").addEventListener("click", function () {
      openEventModal(null, selectedDate);
    });

    // 일정 수정/삭제 (위임)
    $("dayEvents").addEventListener("click", function (e) {
      var edit = e.target.closest("[data-edit-event]");
      if (edit) {
        openEventModal(edit.getAttribute("data-edit-event"));
        return;
      }
      var del = e.target.closest("[data-del-event]");
      if (del) {
        var id = del.getAttribute("data-del-event");
        if (!confirm("이 일정을 삭제할까요?")) return;
        data.events = data.events.filter(function (x) {
          return x.id !== id;
        });
        save();
        renderAll();
        toast("일정을 삭제했습니다.");
      }
    });

    // 일정 모달 내부
    $("evAllDay").addEventListener("change", function () {
      syncTimeRow();
      syncBreakControls();
      syncDurationHint();
      syncMapLinks();
    });
    $("evStart").addEventListener("change", function () {
      syncBreakControls();
      syncDurationHint();
      syncMapLinks();
    });
    $("evEnd").addEventListener("change", function () {
      syncBreakControls();
      syncDurationHint();
    });
    $("evBreakMode").addEventListener("change", function () {
      syncBreakControls();
      syncDurationHint();
    });
    $("evBreakMinutes").addEventListener("input", syncDurationHint);
    $("evPlace").addEventListener("input", syncMapLinks);
    $("evDate").addEventListener("change", syncMapLinks);
    $("evShift").addEventListener("change", function () {
      var st = shiftById($("evShift").value);
      if (!st) return;
      if (!$("evTitle").value.trim()) $("evTitle").value = st.name;
      if (st.start && st.end) {
        $("evAllDay").checked = false;
        $("evStart").value = st.start;
        $("evEnd").value = st.end;
      } else {
        $("evAllDay").checked = true;
        $("evStart").value = "";
        $("evEnd").value = "";
      }
      syncTimeRow();
      syncBreakControls();
      syncDurationHint();
      syncMapLinks();
    });
    $("evSave").addEventListener("click", saveEvent);
    $("evDelete").addEventListener("click", function () {
      if (confirm("이 일정을 삭제할까요?")) deleteEvent();
    });

    // 가계부
    $("finPrev").addEventListener("click", function () {
      finCursor = new Date(finCursor.getFullYear(), finCursor.getMonth() - 1, 1);
      renderFinance();
    });
    $("finNext").addEventListener("click", function () {
      finCursor = new Date(finCursor.getFullYear(), finCursor.getMonth() + 1, 1);
      renderFinance();
    });
    $("addTxBtn").addEventListener("click", function () {
      openTxModal(null);
    });
    $("importTxImageBtn").addEventListener("click", function () {
      $("txImageInput").click();
    });
    $("txImageInput").addEventListener("change", function () {
      var file = this.files && this.files[0];
      if (file) importTransactionImage(file);
      this.value = "";
    });
    $("txList").addEventListener("click", function (e) {
      var edit = e.target.closest("[data-edit-tx]");
      if (edit) openTxModal(edit.getAttribute("data-edit-tx"));
    });
    document.querySelectorAll("#txKind .segmented__item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTxKind(btn.getAttribute("data-kind"));
      });
    });
    $("txAmount").addEventListener("input", function () {
      var pos = $("txAmount").value.length;
      $("txAmount").value = digitsWithComma($("txAmount").value);
      if (pos) {
        /* 커서 유지 로직 생략: 대부분 끝에서 입력 */
      }
    });
    $("txSave").addEventListener("click", saveTx);
    $("txDelete").addEventListener("click", function () {
      if (confirm("이 내역을 삭제할까요?")) deleteTx();
    });

    // 급여
    $("addSalaryBtn").addEventListener("click", function () {
      openSalaryModal(null);
    });
    $("salaryList").addEventListener("click", function (e) {
      var edit = e.target.closest("[data-edit-sal]");
      if (edit) openSalaryModal(edit.getAttribute("data-edit-sal"));
    });
    $("salAmount").addEventListener("input", function () {
      $("salAmount").value = digitsWithComma($("salAmount").value);
    });
    $("salBudget").addEventListener("input", function () {
      $("salBudget").value = digitsWithComma($("salBudget").value);
    });
    $("salSave").addEventListener("click", saveSalary);
    $("salDelete").addEventListener("click", function () {
      if (confirm("이 월급 정보를 삭제할까요?")) deleteSalary();
    });

    // 설정
    $("saveNotice").addEventListener("click", saveNotice);
    $("noticeEditTop").addEventListener("click", function () {
      setView("settings");
      setTimeout(function () { $("noticeText").focus(); }, 120);
    });
    $("addReminderBtn").addEventListener("click", addReminder);
    $("reminderText").addEventListener("keydown", function (e) {
      if (e.key === "Enter") addReminder();
    });
    $("reminderList").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del-reminder]");
      if (del) deleteReminder(del.getAttribute("data-del-reminder"));
    });
    $("saveHome").addEventListener("click", function () {
      data.homeAddress = $("homeAddress").value.trim();
      save();
      renderCalendar();
      toast("기본 출발지를 저장했습니다.");
    });
    $("addShiftBtn").addEventListener("click", function () {
      openShiftModal(null);
    });
    $("shiftList").addEventListener("click", function (e) {
      var edit = e.target.closest("[data-edit-shift]");
      if (edit) {
        openShiftModal(edit.getAttribute("data-edit-shift"));
        return;
      }
      var del = e.target.closest("[data-del-shift]");
      if (del) deleteShift(del.getAttribute("data-del-shift"));
    });
    $("stColors").addEventListener("click", function (e) {
      var sw = e.target.closest("[data-color]");
      if (!sw) return;
      shiftColor = sw.getAttribute("data-color");
      renderSwatches();
    });
    $("stSave").addEventListener("click", saveShift);

    // 백업
    $("exportBtn").addEventListener("click", exportData);
    $("importBtn").addEventListener("click", importData);
    $("copyBackupBtn").addEventListener("click", copyBackup);
    $("downloadBtn").addEventListener("click", downloadBackup);
    $("resetBtn").addEventListener("click", resetAll);

    // 모달 닫기 (배경 클릭, X 버튼, ESC)
    document.querySelectorAll(".modal").forEach(function (modal) {
      modal.addEventListener("click", function (e) {
        if (e.target === modal) closeModal(modal.id);
        if (e.target.closest("[data-close]")) closeModal(modal.id);
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeAllModals();
        closeDrawer();
      }
      // Ctrl/Cmd + Enter 로 열려 있는 모달 저장
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (!$("eventModal").hidden) saveEvent();
        else if (!$("scheduleImportModal").hidden) saveImportedSchedule();
        else if (!$("txModal").hidden) saveTx();
        else if (!$("salaryModal").hidden) saveSalary();
        else if (!$("shiftModal").hidden) saveShift();
      }
    });
  }

  /* ---------------------------------------------------------
     16. 시작
     --------------------------------------------------------- */
  function init() {
    var savedTheme = null;
    try {
      savedTheme = localStorage.getItem(THEME_KEY);
    } catch (err) {
      savedTheme = null;
    }
    if (!savedTheme) {
      savedTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    applyTheme(savedTheme);

    fillShiftSelect();
    fillCategorySelect();
    renderSwatches();
    bind();
    renderAll();
    setView("calendar");
    setTimeout(function () { showTodayReminders(false); }, 80);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
