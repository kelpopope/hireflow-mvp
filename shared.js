/* HireFlow AI MVP — shared engine.
 * Runs on the server (Node, require) and in the browser (window.HF).
 * Pure functions: engine.apply(state, action) -> { state, outbound }.
 * `outbound` lists messages the bot must deliver: { candidateId, channel, phone, text }.
 */
(function (root) {
  "use strict";

  var PRICE = 5000; // test price, KZT, charged only for a hire who stays 30 days
  var DAY_NAMES = {
    ru: ["", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    en: ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  };
  var REASONS = {
    ru: ["", "График или учёба", "Оплата", "Нагрузка", "Коллектив или руководитель", "Нашёл другую работу", "Другое"],
    en: ["", "Schedule or studies", "Pay", "Workload", "Team or manager", "Found another job", "Other"],
  };
  var HORIZON = {
    ru: ["", "меньше месяца", "1–3 месяца", "больше 3 месяцев"],
    en: ["", "less than a month", "1–3 months", "more than 3 months"],
  };

  function uid(p) {
    return (p || "") + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function money(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸"; }
  function dayList(days, lang) {
    return (days || []).slice().sort().map(function (d) { return DAY_NAMES[lang][d]; }).join(", ");
  }

  // ---------- parsing candidate replies ----------
  var WORD_DAYS = [
    [1, /(^|[^а-яa-z])(пн|понед|mon)/i], [2, /(^|[^а-яa-z])(вт|втор|tue)/i], [3, /(^|[^а-яa-z])(ср|сред|wed)/i],
    [4, /(^|[^а-яa-z])(чт|четв|thu)/i], [5, /(^|[^а-яa-z])(пт|пятн|fri)/i], [6, /(^|[^а-яa-z])(сб|субб|sat)/i],
    [7, /(^|[^а-яa-z])(вс|воскр|sun)/i],
  ];
  function parseDays(text) {
    var t = String(text || "").toLowerCase();
    var set = {};
    var range = t.match(/([1-7])\s*[-–]\s*([1-7])/);
    if (range) {
      for (var i = +range[1]; i <= +range[2]; i++) set[i] = 1;
    }
    (t.match(/[1-7]/g) || []).forEach(function (d) { set[+d] = 1; });
    WORD_DAYS.forEach(function (w) { if (w[1].test(t)) set[w[0]] = 1; });
    if (/(любые|все дни|any|every day|all days)/.test(t)) for (var k = 1; k <= 7; k++) set[k] = 1;
    return Object.keys(set).map(Number).sort();
  }
  function parseYesNo(text) {
    var t = String(text || "").trim().toLowerCase();
    if (/^(1|да|ага|подходит|ок|ok|yes|y|иә|ия)\b/.test(t)) return true;
    if (/^(2|нет|не подходит|no|n|жоқ)\b/.test(t)) return false;
    return null;
  }
  function parseChoice(text, max) {
    var m = String(text || "").match(/[1-9]/);
    if (!m) return null;
    var n = +m[0];
    return n >= 1 && n <= max ? n : null;
  }

  // ---------- bot texts ----------
  var T = {
    ru: {
      welcome: function (v) {
        return "Здравствуйте! Это HireFlow, помощник кафе «" + v.cafe + "». Спасибо за интерес к вакансии.\n\n" +
          "*" + v.role + "*, " + v.area + "\n" +
          "• Смены: " + dayList(v.days, "ru") + ", " + v.hours + " (смен в неделю: " + v.shiftsPerWeek + ")\n" +
          "• Оплата: " + money(v.pay) + " за смену\n" +
          "• Нагрузка: " + v.workload + "\n" +
          "• Начало: " + v.start + "\n\n" +
          "Ответьте на 6 коротких вопросов, это займёт 2 минуты.";
      },
      qDays: "1/6. В какие дни вы можете работать? Напишите цифры через пробел: 1 Пн, 2 Вт, 3 Ср, 4 Чт, 5 Пт, 6 Сб, 7 Вс. Например: 1 3 5 6",
      qPay: function (v) { return "2/6. Оплата " + money(v.pay) + " за смену. Вам подходит? 1 Да, 2 Нет"; },
      qWork: function (v) { return "3/6. Нагрузка: " + v.workload + ". Вам подходит? 1 Да, 2 Нет"; },
      qHorizon: "4/6. Сколько вы планируете у нас работать? 1 Меньше месяца, 2 От 1 до 3 месяцев, 3 Больше 3 месяцев",
      qName: "5/6. Как вас зовут?",
      qExp: "6/6. Опыт работы одной строкой (или напишите «нет»):",
      again: "Не понял ответ. Пожалуйста, ответьте цифрой из вариантов.",
      againDays: "Не нашёл дни в ответе. Напишите цифры дней, например: 2 4 6",
      matched: function (c) {
        return "Спасибо, " + c.name + "! Ваши ответы подходят под условия. Владелец кафе посмотрит анкету и предложит время встречи в течение дня. Мы напишем сюда.";
      },
      mismatch: function (c, why) {
        return "Спасибо, " + (c.name || "") + "! Честно скажем: эта вакансия вам не совсем подходит (" + why + "). Мы сохраним анкету и напишем, если появится вакансия с другими условиями.";
      },
      whyDays: function (n) { return "нужно смен в неделю: " + n + ", в указанные дни"; },
      whyPay: "оплата", whyWork: "нагрузка", whyHorizon: "нужно работать хотя бы месяц",
      invite: function (v, c) {
        return "Хорошие новости, " + c.name + "! Владелец кафе «" + v.cafe + "» приглашает вас на встречу: *" + c.slot + "*, " + v.area + ".\n\nВы придёте? 1 Да, 2 Нужно другое время";
      },
      confirmed: "Отлично, записали! Накануне пришлём напоминание.",
      reschedule: "Хорошо, передали владельцу. Он предложит другое время.",
      remind: function (v, c) {
        return "Напоминание: встреча в кафе «" + v.cafe + "» *" + c.slot + "*, " + v.area + ".\nОтветьте 1, если придёте, или 2, если не получается.";
      },
      remindYes: "Спасибо, ждём вас!",
      remindNo: "Спасибо, что предупредили. Передали владельцу.",
      hired: function (v, c) { return "Поздравляем, " + c.name + "! Вас приняли в «" + v.cafe + "». Через 7, 30 и 90 дней мы коротко спросим, как дела."; },
      checkin: function (v, c, d) { return "Здравствуйте, " + c.name + "! Прошло " + d + " дней работы в «" + v.cafe + "». Как дела? 1 Всё хорошо, 2 Думаю уйти, 3 Уже ушёл(ла)"; },
      checkinOk: "Рады слышать! Хорошей работы.",
      qReason: "Подскажите причину, это поможет кафе: 1 График или учёба, 2 Оплата, 3 Нагрузка, 4 Коллектив или руководитель, 5 Нашёл другую работу, 6 Другое",
      reasonThanks: "Спасибо за честный ответ. Мы передадим это владельцу без лишних подробностей.",
      qRate: "Последний вопрос: насколько удобно было откликнуться так, через WhatsApp? Оцените от 1 до 5.",
      rateThanks: "Спасибо!",
      rejected: function (v) { return "Спасибо, что пришли в «" + v.cafe + "». К сожалению, в этот раз владелец выбрал другого кандидата. Мы сохраним вашу анкету."; },
      closed: "Спасибо! Ваша анкета уже у владельца кафе. Мы напишем, когда будут новости.",
      noVacancy: "Здравствуйте! Сейчас открытых вакансий нет. Мы напишем, когда появятся.",
    },
    en: {
      welcome: function (v) {
        return "Hello! This is HireFlow, the hiring assistant of " + v.cafe + ". Thanks for your interest.\n\n" +
          "*" + v.role + "*, " + v.area + "\n" +
          "• Shifts: " + dayList(v.days, "en") + ", " + v.hours + " (" + v.shiftsPerWeek + " shifts a week)\n" +
          "• Pay: " + money(v.pay) + " per shift\n" +
          "• Workload: " + v.workload + "\n" +
          "• Start: " + v.start + "\n\n" +
          "Please answer 6 short questions. It takes 2 minutes.";
      },
      qDays: "1/6. Which days can you work? Send the numbers: 1 Mon, 2 Tue, 3 Wed, 4 Thu, 5 Fri, 6 Sat, 7 Sun. Example: 1 3 5 6",
      qPay: function (v) { return "2/6. Pay is " + money(v.pay) + " per shift. Does it suit you? 1 Yes, 2 No"; },
      qWork: function (v) { return "3/6. Workload: " + v.workload + ". Does it suit you? 1 Yes, 2 No"; },
      qHorizon: "4/6. How long do you plan to work with us? 1 Less than a month, 2 One to three months, 3 More than three months",
      qName: "5/6. What is your name?",
      qExp: "6/6. Your work experience in one line (or write \"none\"):",
      again: "Sorry, I did not get that. Please reply with one of the numbers.",
      againDays: "I could not find days in your reply. Send day numbers, for example: 2 4 6",
      matched: function (c) {
        return "Thank you, " + c.name + "! Your answers fit the conditions. The owner will review your answers and suggest a meeting time within a day. We will write here.";
      },
      mismatch: function (c, why) {
        return "Thank you, " + (c.name || "") + ". To be honest, this vacancy does not quite fit you (" + why + "). We will keep your answers and write if a vacancy with other conditions opens.";
      },
      whyDays: function (n) { return n + " shifts a week are needed on the listed days"; },
      whyPay: "pay", whyWork: "workload", whyHorizon: "the job needs at least one month",
      invite: function (v, c) {
        return "Good news, " + c.name + "! The owner of " + v.cafe + " invites you to a meeting: *" + c.slot + "*, " + v.area + ".\n\nWill you come? 1 Yes, 2 I need another time";
      },
      confirmed: "Great, you are booked. We will send a reminder the day before.",
      reschedule: "OK, we told the owner. They will suggest another time.",
      remind: function (v, c) {
        return "Reminder: meeting at " + v.cafe + " *" + c.slot + "*, " + v.area + ".\nReply 1 if you are coming or 2 if you cannot.";
      },
      remindYes: "Thank you, see you there!",
      remindNo: "Thanks for letting us know. We told the owner.",
      hired: function (v, c) { return "Congratulations, " + c.name + "! You are hired at " + v.cafe + ". On days 7, 30 and 90 we will briefly ask how it is going."; },
      checkin: function (v, c, d) { return "Hello, " + c.name + "! It has been " + d + " days at " + v.cafe + ". How is it going? 1 All good, 2 Thinking of leaving, 3 I have left"; },
      checkinOk: "Glad to hear it. Have a good shift!",
      qReason: "What is the main reason? It helps the café: 1 Schedule or studies, 2 Pay, 3 Workload, 4 Team or manager, 5 Found another job, 6 Other",
      reasonThanks: "Thank you for the honest answer. We will pass it to the owner without extra details.",
      qRate: "Last question: how convenient was it to apply this way, through WhatsApp? Rate from 1 to 5.",
      rateThanks: "Thank you!",
      rejected: function (v) { return "Thank you for coming to " + v.cafe + ". This time the owner chose another candidate. We will keep your answers."; },
      closed: "Thank you! The owner already has your answers. We will write when there is news.",
      noVacancy: "Hello! There are no open vacancies right now. We will write when one opens.",
    },
  };

  // ---------- matching ----------
  function evaluate(v, c) {
    var a = c.answers || {};
    var overlap = (a.days || []).filter(function (d) { return v.days.indexOf(d) >= 0; }).length;
    var m = {
      days: overlap >= v.shiftsPerWeek,
      overlap: overlap,
      pay: a.payOk === true,
      workload: a.workloadOk === true,
      horizon: (a.horizon || 0) >= 2,
    };
    m.score = [m.days, m.pay, m.workload, m.horizon].filter(Boolean).length;
    m.ok = m.score === 4;
    return m;
  }

  // ---------- state helpers ----------
  function emptyState() { return { vacancies: [], candidates: [], feedback: [], version: 1 }; }
  function findV(s, id) { return s.vacancies.filter(function (v) { return v.id === id; })[0]; }
  function findC(s, id) { return s.candidates.filter(function (c) { return c.id === id; })[0]; }
  function log(c, type, text, now) { (c.events = c.events || []).push({ t: now, type: type, text: text || "" }); }

  function say(out, c, text, now) {
    (c.messages = c.messages || []).push({ from: "bot", text: text, t: now });
    if (c.firstReplyMs == null && c.messages.length) {
      var firstIn = c.messages.filter(function (m) { return m.from === "cand"; })[0];
      if (firstIn) c.firstReplyMs = Math.max(0, now - firstIn.t);
    }
    out.push({ candidateId: c.id, channel: c.channel, phone: c.phone, text: text });
  }

  function vacancyFromText(s, text) {
    var m = String(text || "").toUpperCase().match(/HF-[A-Z0-9]{3,8}/);
    if (m) {
      var v = s.vacancies.filter(function (x) { return x.code === m[0]; })[0];
      if (v) return v;
    }
    var open = s.vacancies.filter(function (x) { return x.active !== false; });
    return open[open.length - 1] || null;
  }

  function nextCode(s) {
    var n = s.vacancies.length + 1, code;
    do { code = "HF-" + (100 + n++); } while (s.vacancies.some(function (v) { return v.code === code; }));
    return code;
  }

  // ---------- conversation ----------
  function handleText(s, v, c, text, now, out) {
    var L = v.lang === "en" ? "en" : "ru", t = T[L], a = c.answers = c.answers || {};
    switch (c.step) {
      case "days": {
        var d = parseDays(text);
        if (!d.length) return say(out, c, t.againDays, now);
        a.days = d; c.step = "pay"; return say(out, c, t.qPay(v), now);
      }
      case "pay": {
        var p = parseYesNo(text); if (p === null) return say(out, c, t.again, now);
        a.payOk = p; c.step = "workload"; return say(out, c, t.qWork(v), now);
      }
      case "workload": {
        var w = parseYesNo(text); if (w === null) return say(out, c, t.again, now);
        a.workloadOk = w; c.step = "horizon"; return say(out, c, t.qHorizon, now);
      }
      case "horizon": {
        var h = parseChoice(text, 3); if (!h) return say(out, c, t.again, now);
        a.horizon = h; c.step = "name"; return say(out, c, t.qName, now);
      }
      case "name": {
        c.name = String(text).trim().slice(0, 40) || "—"; c.step = "exp"; return say(out, c, t.qExp, now);
      }
      case "exp": {
        a.experience = String(text).trim().slice(0, 160);
        c.match = evaluate(v, c);
        if (c.match.ok) {
          c.status = "matched"; c.step = "wait"; log(c, "matched", "", now);
          return say(out, c, t.matched(c), now);
        }
        var why = [];
        if (!c.match.days) why.push(t.whyDays(v.shiftsPerWeek));
        if (!c.match.pay) why.push(t.whyPay);
        if (!c.match.workload) why.push(t.whyWork);
        if (!c.match.horizon) why.push(t.whyHorizon);
        c.status = "mismatch"; c.step = "wait"; log(c, "mismatch", why.join("; "), now);
        return say(out, c, t.mismatch(c, why.join("; ")), now);
      }
      case "invite": {
        var yi = parseYesNo(text); if (yi === null) return say(out, c, t.again, now);
        if (yi) { c.status = "confirmed"; c.step = "wait"; log(c, "confirmed", c.slot, now); return say(out, c, t.confirmed, now); }
        c.status = "matched"; c.step = "wait"; log(c, "reschedule", "", now); return say(out, c, t.reschedule, now);
      }
      case "remind": {
        var yr = parseYesNo(text); if (yr === null) return say(out, c, t.again, now);
        c.step = "wait";
        if (yr) { c.reconfirmed = true; log(c, "reconfirmed", "", now); return say(out, c, t.remindYes, now); }
        c.status = "matched"; c.reconfirmed = false; log(c, "cancelled", "", now); return say(out, c, t.remindNo, now);
      }
      case "checkin": {
        var low = String(text).toLowerCase();
        var ch = /(ушел|ушёл|ушла|уволил|left|quit)/.test(low) ? 3 : /(думаю|thinking)/.test(low) ? 2 : parseChoice(text, 3);
        if (!ch) return say(out, c, t.again, now);
        var key = "d" + c.checkinDay;
        c.checkins = c.checkins || {};
        if (ch === 1) {
          c.checkins[key] = { status: "ok", t: now, by: "employee" }; c.atRisk = false;
          c.step = c.rating ? "wait" : "rate";
          say(out, c, t.checkinOk, now);
          if (!c.rating) say(out, c, t.qRate, now);
          return;
        }
        c.checkins[key] = { status: ch === 2 ? "risk" : "left", t: now, by: "employee" };
        if (ch === 2) { c.atRisk = true; log(c, "risk", "day " + c.checkinDay, now); }
        c.step = "reason"; return say(out, c, t.qReason, now);
      }
      case "reason": {
        var r = parseChoice(text, 6); if (!r) return say(out, c, t.again, now);
        var k2 = "d" + c.checkinDay;
        c.checkins[k2].reason = r;
        if (c.checkins[k2].status === "left") { c.status = "left"; c.leftReason = r; log(c, "left", REASONS.en[r], now); }
        c.step = c.rating ? "wait" : "rate";
        say(out, c, t.reasonThanks, now);
        if (!c.rating) say(out, c, t.qRate, now);
        return;
      }
      case "rate": {
        var rt = parseChoice(text, 5); if (!rt) return say(out, c, t.again, now);
        c.rating = rt; c.step = "wait"; return say(out, c, t.rateThanks, now);
      }
      default:
        return say(out, c, t.closed, now);
    }
  }

  // ---------- engine ----------
  function apply(state, action) {
    var s = clone(state || emptyState()), out = [], now = action.now || Date.now();
    var v, c, L, t;
    switch (action.type) {
      case "createVacancy": {
        var d = action.data || {};
        v = {
          id: uid("v_"), code: nextCode(s), cafe: d.cafe || "Café", role: d.role || "Barista", area: d.area || "",
          days: (d.days || []).map(Number).sort(), shiftsPerWeek: +d.shiftsPerWeek || 3, hours: d.hours || "",
          pay: +d.pay || 0, workload: d.workload || "", start: d.start || "", lang: d.lang === "en" ? "en" : "ru",
          active: true, free: s.vacancies.length === 0, createdAt: now, example: !!d.example,
        };
        s.vacancies.push(v); s.lastCreated = v.id;
        break;
      }
      case "updateVacancy": {
        v = findV(s, action.id); if (!v) break;
        ["cafe", "role", "area", "hours", "workload", "start", "lang", "active"].forEach(function (k) {
          if (action.data[k] !== undefined) v[k] = action.data[k];
        });
        if (action.data.days) v.days = action.data.days.map(Number).sort();
        if (action.data.pay !== undefined) v.pay = +action.data.pay;
        if (action.data.shiftsPerWeek !== undefined) v.shiftsPerWeek = +action.data.shiftsPerWeek;
        break;
      }
      case "incoming": {
        c = action.candidateId ? findC(s, action.candidateId) : null;
        if (!c && action.phone) {
          var mine = s.candidates.filter(function (x) { return x.phone === action.phone; });
          c = mine[mine.length - 1] || null;
        }
        if (!c) {
          v = action.vacancyId ? findV(s, action.vacancyId) : vacancyFromText(s, action.text);
          if (!v) {
            out.push({ candidateId: null, channel: action.channel, phone: action.phone, text: T.ru.noVacancy });
            break;
          }
          c = {
            id: uid("c_"), vacancyId: v.id, channel: action.channel || "sim", phone: action.phone || "",
            name: action.profileName || "", step: "days", status: "screening", answers: {}, messages: [],
            events: [], checkins: {}, createdAt: now, example: !!action.example,
          };
          s.candidates.push(c);
          c.messages.push({ from: "cand", text: action.text, t: now });
          log(c, "applied", "", now);
          L = v.lang === "en" ? "en" : "ru";
          say(out, c, T[L].welcome(v), now);
          say(out, c, T[L].qDays, now);
          break;
        }
        v = findV(s, c.vacancyId);
        c.messages.push({ from: "cand", text: action.text, t: now });
        c.lastInAt = now;
        handleText(s, v, c, action.text, now, out);
        break;
      }
      case "invite": {
        c = findC(s, action.id); if (!c) break; v = findV(s, c.vacancyId); t = T[v.lang === "en" ? "en" : "ru"];
        c.slot = action.slot; c.status = "invited"; c.step = "invite"; log(c, "invited", c.slot, now);
        say(out, c, t.invite(v, c), now);
        break;
      }
      case "remind": {
        c = findC(s, action.id); if (!c) break; v = findV(s, c.vacancyId); t = T[v.lang === "en" ? "en" : "ru"];
        c.step = "remind"; c.reminded = true; log(c, "reminded", "", now);
        say(out, c, t.remind(v, c), now);
        break;
      }
      case "mark": {
        c = findC(s, action.id); if (!c) break; v = findV(s, c.vacancyId); t = T[v.lang === "en" ? "en" : "ru"];
        c.status = action.status; log(c, action.status, "", now);
        if (action.status === "hired") { c.hiredAt = now; say(out, c, t.hired(v, c), now); }
        if (action.status === "rejected") say(out, c, t.rejected(v), now);
        break;
      }
      case "checkin": {
        c = findC(s, action.id); if (!c) break; v = findV(s, c.vacancyId); t = T[v.lang === "en" ? "en" : "ru"];
        c.checkinDay = action.day; c.step = "checkin"; log(c, "checkin_sent", "day " + action.day, now);
        say(out, c, t.checkin(v, c, action.day), now);
        break;
      }
      case "ownerCheck": {
        c = findC(s, action.id); if (!c) break;
        c.checkins = c.checkins || {};
        c.checkins["d" + action.day] = { status: action.stayed ? "ok" : "left", reason: action.reason || null, t: now, by: "owner" };
        if (!action.stayed) { c.status = "left"; c.leftReason = action.reason || 6; log(c, "left", "", now); }
        break;
      }
      case "feedback": {
        s.feedback.push(Object.assign({ id: uid("f_"), t: now }, action.data || {}));
        break;
      }
      case "reset": {
        s = emptyState();
        if (action.seed) s = seed(now, action.lang);
        break;
      }
      case "deleteCandidate": {
        s.candidates = s.candidates.filter(function (x) { return x.id !== action.id; });
        break;
      }
    }
    s.updatedAt = now;
    return { state: s, outbound: out };
  }

  // ---------- metrics ----------
  function metrics(s, vacancyId) {
    var cs = s.candidates.filter(function (c) { return !vacancyId || c.vacancyId === vacancyId; });
    var count = function (f) { return cs.filter(f).length; };
    var invitedEver = function (c) { return (c.events || []).some(function (e) { return e.type === "invited"; }); };
    var came = count(function (c) { return ["came", "hired", "rejected", "left"].indexOf(c.status) >= 0 || (c.events || []).some(function (e) { return e.type === "came"; }); });
    var noshow = count(function (c) { return c.status === "noshow"; });
    var hires = cs.filter(function (c) { return !!c.hiredAt; });
    var stayed30 = hires.filter(function (c) { return c.checkins && c.checkins.d30 && c.checkins.d30.status !== "left"; });
    var decided30 = hires.filter(function (c) { return c.checkins && c.checkins.d30 || c.status === "left"; });
    var replies = cs.map(function (c) { return c.firstReplyMs; }).filter(function (x) { return x != null; });
    var reasons = {};
    cs.forEach(function (c) {
      Object.keys(c.checkins || {}).forEach(function (k) {
        var r = c.checkins[k].reason; if (r) reasons[r] = (reasons[r] || 0) + 1;
      });
    });
    var billable = stayed30.filter(function (c) { var v = findV(s, c.vacancyId); return v && !v.free; }).length;
    return {
      applied: cs.length,
      screened: count(function (c) { return c.status !== "screening"; }),
      matched: count(function (c) { return c.match && c.match.ok; }),
      mismatch: count(function (c) { return c.status === "mismatch"; }),
      invited: count(invitedEver),
      confirmed: count(function (c) { return (c.events || []).some(function (e) { return e.type === "confirmed"; }); }),
      came: came, noshow: noshow,
      showRate: came + noshow ? Math.round(100 * came / (came + noshow)) : null,
      hired: hires.length,
      stayed30: stayed30.length, decided30: decided30.length,
      retention30: decided30.length ? Math.round(100 * stayed30.length / decided30.length) : null,
      medianReplySec: replies.length ? Math.round(replies.sort(function (a, b) { return a - b; })[Math.floor(replies.length / 2)] / 1000) : null,
      reasons: reasons,
      billable: billable, owed: billable * PRICE,
      ratings: cs.map(function (c) { return c.rating; }).filter(Boolean),
    };
  }

  // ---------- example data (marked as examples) ----------
  function seed(now, lang) {
    var DAY = 86400000, base = now - 40 * DAY, en = lang === "en";
    var r = apply(emptyState(), { type: "createVacancy", now: base, data: en ? {
      cafe: "Example Coffee", role: "Barista", area: "Almaty, Samal-2", days: [1, 2, 3, 4, 5, 6, 7],
      shiftsPerWeek: 4, hours: "08:00–16:00", pay: 9000, workload: "up to 120 cups a shift, morning student rush",
      start: "from 1 November", lang: "en", example: true } : {
      cafe: "Example Coffee", role: "Бариста", area: "Алматы, мкр. Самал-2", days: [1, 2, 3, 4, 5, 6, 7],
      shiftsPerWeek: 4, hours: "08:00–16:00", pay: 9000, workload: "до 120 чашек за смену, утренний поток студентов",
      start: "с 1 ноября", lang: "ru", example: true } });
    var s = r.state, v = s.vacancies[0];
    var people = [
      { name: en ? "Aigerim" : "Айгерим", days: "1 2 4 6 7", pay: "1", work: "1", hz: "3", exp: en ? "barista, 8 months" : "бариста 8 месяцев", path: ["invite", "yes", "came", "hired", "d7ok", "d30ok"] },
      { name: en ? "Daniyar" : "Данияр", days: "3 4 5 6", pay: "1", work: "1", hz: "2", exp: en ? "waiter, 1 year" : "официант 1 год", path: ["invite", "yes", "remindyes", "came", "hired", "d7ok", "d30left"] },
      { name: en ? "Madina" : "Мадина", days: "1 3 5 6", pay: "1", work: "1", hz: "3", exp: en ? "none" : "нет", path: ["invite", "yes", "noshow"] },
      { name: en ? "Arman" : "Арман", days: "6 7", pay: "1", work: "1", hz: "2", exp: en ? "cashier, 3 months" : "кассир 3 месяца", path: [] },
      { name: en ? "Zhanna" : "Жанна", days: "1 2 3 5", pay: "2", work: "1", hz: "3", exp: en ? "barista, 2 years" : "бариста 2 года", path: [] },
      { name: en ? "Timur" : "Тимур", days: "2 3 4 5 6", pay: "1", work: "1", hz: "3", exp: en ? "barista, 4 months" : "бариста 4 месяца", path: [] },
    ];
    people.forEach(function (p, i) {
      var t0 = base + (i + 1) * 3600000;
      s = apply(s, { type: "incoming", channel: "sim", phone: "", text: (en ? "Hello! " : "Здравствуйте! ") + v.code, vacancyId: v.id, now: t0, example: true }).state;
      var c = s.candidates[s.candidates.length - 1];
      [p.days, p.pay, p.work, p.hz, p.name, p.exp].forEach(function (txt, k) {
        s = apply(s, { type: "incoming", candidateId: c.id, text: txt, now: t0 + (k + 1) * 40000 }).state;
      });
      var tt = t0 + 2 * DAY;
      p.path.forEach(function (step) {
        tt += DAY / 2;
        if (step === "invite") s = apply(s, { type: "invite", id: c.id, slot: en ? "Fri, 15:00" : "Пт, 15:00", now: tt }).state;
        if (step === "yes") s = apply(s, { type: "incoming", candidateId: c.id, text: "1", now: tt + 60000 }).state;
        if (step === "remindyes") {
          s = apply(s, { type: "remind", id: c.id, now: tt }).state;
          s = apply(s, { type: "incoming", candidateId: c.id, text: "1", now: tt + 60000 }).state;
        }
        if (step === "came" || step === "noshow" || step === "hired") s = apply(s, { type: "mark", id: c.id, status: step, now: tt }).state;
        if (step === "d7ok" || step === "d30ok") {
          var d = step === "d7ok" ? 7 : 30;
          s = apply(s, { type: "checkin", id: c.id, day: d, now: tt + d * DAY }).state;
          s = apply(s, { type: "incoming", candidateId: c.id, text: "1", now: tt + d * DAY + 300000 }).state;
          if (d === 7) s = apply(s, { type: "incoming", candidateId: c.id, text: "5", now: tt + d * DAY + 400000 }).state;
        }
        if (step === "d30left") {
          s = apply(s, { type: "checkin", id: c.id, day: 30, now: tt + 30 * DAY }).state;
          s = apply(s, { type: "incoming", candidateId: c.id, text: "3", now: tt + 30 * DAY + 300000 }).state;
          s = apply(s, { type: "incoming", candidateId: c.id, text: "1", now: tt + 30 * DAY + 400000 }).state;
        }
      });
    });
    return s;
  }

  var HF = {
    PRICE: PRICE, DAY_NAMES: DAY_NAMES, REASONS: REASONS, HORIZON: HORIZON,
    apply: apply, metrics: metrics, evaluate: evaluate, emptyState: emptyState, seed: seed,
    parseDays: parseDays, parseYesNo: parseYesNo, money: money, dayList: dayList,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = HF;
  else root.HF = HF;
})(typeof window !== "undefined" ? window : this);
