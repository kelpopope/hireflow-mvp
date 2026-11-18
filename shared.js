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
    kk: ["", "Дс", "Сс", "Ср", "Бс", "Жм", "Сн", "Жс"],
  };
  var REASONS = {
    ru: ["", "График или учёба", "Оплата", "Нагрузка", "Коллектив или руководитель", "Нашёл другую работу", "Другое"],
    en: ["", "Schedule or studies", "Pay", "Workload", "Team or manager", "Found another job", "Other"],
    kk: ["", "Кесте немесе оқу", "Төлем", "Жүктеме", "Ұжым немесе басшы", "Басқа жұмыс тапты", "Басқа"],
  };
  var HORIZON = {
    ru: ["", "меньше месяца", "1–3 месяца", "больше 3 месяцев"],
    en: ["", "less than a month", "1–3 months", "more than 3 months"],
    kk: ["", "бір айдан аз", "1–3 ай", "3 айдан көп"],
  };
  var LANGS = ["kk", "ru", "en"];
  function langOf(c, v) { var l = (c && c.lang) || (v && v.lang); return LANGS.indexOf(l) >= 0 ? l : "ru"; }
  // First question for every new candidate, in all three languages.
  var ASK_LANG = "Тілді таңдаңыз / Выберите язык / Choose your language:\n1 Қазақша\n2 Русский\n3 English";
  var LANG_BUTTONS = [["1 Қазақша", "2 Русский", "3 English"]];
  function parseLang(text) {
    var t = String(text || "").trim().toLowerCase();
    if (/^(1|қаз|каз|kaz|kk|kz)/.test(t)) return "kk";
    if (/^(2|рус|ru)/.test(t)) return "ru";
    if (/^(3|eng|англ|en)/.test(t)) return "en";
    return null;
  }

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
    [1, /(дс|дүйс)/i], [2, /(сс|сейс)/i], [3, /сәрс/i], [4, /(бс|бейс)/i], [5, /(жм|жұма)/i], [6, /(сн|сенбі)/i], [7, /(жс|жекс)/i],
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
    if (/(любые|все дни|any|every day|all days|барлық күн|кез келген)/.test(t)) for (var k = 1; k <= 7; k++) set[k] = 1;
    return Object.keys(set).map(Number).sort();
  }
  function parseYesNo(text) {
    var t = String(text || "").trim().toLowerCase();
    if (/^(1|да|ага|подходит|ок|ok|yes|y|иә|ия)\b/.test(t)) return true;
    if (/^(2|нет|не подходит|no|n|жоқ|сай емес)/.test(t)) return false;
    if (/^(иә|ия|сай|да|ага|подходит|ок)/.test(t)) return true;
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
    kk: {
      welcome: function (v) {
        return "Сәлеметсіз бе! Бұл HireFlow, «" + v.cafe + "» кафесінің көмекшісі. Вакансияға қызығушылық танытқаныңызға рақмет.\n\n" +
          "*" + v.role + "*, " + v.area + "\n" +
          "• Ауысымдар: " + dayList(v.days, "kk") + ", " + v.hours + " (аптасына ауысым: " + v.shiftsPerWeek + ")\n" +
          "• Төлем: бір ауысымға " + money(v.pay) + "\n" +
          "• Жүктеме: " + v.workload + "\n" +
          "• Басталуы: " + v.start + "\n\n" +
          "6 қысқа сұраққа жауап беріңіз, бұл 2 минут алады.";
      },
      qDays: "1/6. Қай күндері жұмыс істей аласыз? Сандарды бос орын арқылы жазыңыз: 1 Дс, 2 Сс, 3 Ср, 4 Бс, 5 Жм, 6 Сн, 7 Жс. Мысалы: 1 3 5 6",
      qPay: function (v) { return "2/6. Бір ауысымға төлем " + money(v.pay) + ". Сізге сай ма? 1 Иә, 2 Жоқ"; },
      qWork: function (v) { return "3/6. Жүктеме: " + v.workload + ". Сізге сай ма? 1 Иә, 2 Жоқ"; },
      qHorizon: "4/6. Бізде қанша уақыт жұмыс істеуді жоспарлайсыз? 1 Бір айдан аз, 2 1 айдан 3 айға дейін, 3 3 айдан көп",
      qName: "5/6. Атыңыз кім?",
      qExp: "6/6. Жұмыс тәжірибеңізді бір жолмен жазыңыз (немесе «жоқ» деп жазыңыз):",
      again: "Жауапты түсінбедім. Нұсқалардың бірін санмен жазыңыз.",
      againDays: "Жауаптан күндерді таба алмадым. Күндердің сандарын жазыңыз, мысалы: 2 4 6",
      matched: function (c) {
        return "Рақмет, " + c.name + "! Жауаптарыңыз шарттарға сай. Кафе иесі сауалнаманы қарап, бір күн ішінде кездесу уақытын ұсынады. Біз осында жазамыз.";
      },
      mismatch: function (c, why) {
        return "Рақмет, " + (c.name || "") + "! Шынын айтсақ, бұл вакансия сізге толық сай емес (" + why + "). Сауалнаманы сақтаймыз және басқа шарттары бар вакансия шықса, жазамыз.";
      },
      whyDays: function (n) { return "көрсетілген күндері аптасына " + n + " ауысым қажет"; },
      whyPay: "төлем", whyWork: "жүктеме", whyHorizon: "кемінде бір ай жұмыс істеу керек",
      invite: function (v, c) {
        return "Жақсы жаңалық, " + c.name + "! «" + v.cafe + "» кафесінің иесі сізді кездесуге шақырады: *" + c.slot + "*, " + v.area + ".\n\nКелесіз бе? 1 Иә, 2 Басқа уақыт керек";
      },
      confirmed: "Тамаша, жазып қойдық! Алдыңғы күні еске саламыз.",
      reschedule: "Жақсы, иесіне жеткіздік. Ол басқа уақыт ұсынады.",
      remind: function (v, c) {
        return "Еске салу: «" + v.cafe + "» кафесінде кездесу *" + c.slot + "*, " + v.area + ".\nКелетін болсаңыз 1, келе алмасаңыз 2 деп жауап беріңіз.";
      },
      remindYes: "Рақмет, сізді күтеміз!",
      remindNo: "Ескерткеніңізге рақмет. Иесіне жеткіздік.",
      hired: function (v, c) { return "Құттықтаймыз, " + c.name + "! Сізді «" + v.cafe + "» кафесіне жұмысқа алды. 7, 30 және 90 күннен кейін жағдайыңызды қысқаша сұраймыз."; },
      checkin: function (v, c, d) { return "Сәлеметсіз бе, " + c.name + "! «" + v.cafe + "» кафесінде жұмыс істегеніңізге " + d + " күн болды. Жағдай қалай? 1 Бәрі жақсы, 2 Кетуді ойлап жүрмін, 3 Кеттім"; },
      checkinOk: "Естігенімізге қуаныштымыз! Жұмысыңыз сәтті болсын.",
      qReason: "Себебін айтыңызшы, бұл кафеге көмектеседі: 1 Кесте немесе оқу, 2 Төлем, 3 Жүктеме, 4 Ұжым немесе басшы, 5 Басқа жұмыс таптым, 6 Басқа",
      reasonThanks: "Шынайы жауабыңызға рақмет. Мұны иесіне артық мәліметсіз жеткіземіз.",
      qRate: "Соңғы сұрақ: WhatsApp арқылы осылай өтінім беру қаншалықты ыңғайлы болды? 1-ден 5-ке дейін бағалаңыз.",
      rateThanks: "Рақмет!",
      rejected: function (v) { return "«" + v.cafe + "» кафесіне келгеніңізге рақмет. Өкінішке қарай, бұл жолы иесі басқа кандидатты таңдады. Сауалнамаңызды сақтаймыз."; },
      closed: "Рақмет! Сауалнамаңыз кафе иесінде. Жаңалық болғанда жазамыз.",
      noVacancy: "Сәлеметсіз бе! Қазір ашық вакансиялар жоқ. Пайда болғанда жазамыз.",
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

  function say(out, c, text, now, buttons) {
    (c.messages = c.messages || []).push({ from: "bot", text: text, t: now });
    if (c.firstReplyMs == null && c.messages.length) {
      var firstIn = c.messages.filter(function (m) { return m.from === "cand"; })[0];
      if (firstIn) c.firstReplyMs = Math.max(0, now - firstIn.t);
    }
    out.push({ candidateId: c.id, channel: c.channel, phone: c.phone, text: text, buttons: buttons || buttonsFor(c) });
  }
  // Reply buttons for messengers that support them (Telegram); WhatsApp text still lists the numbers.
  function buttonsFor(c) {
    var L = langOf(c), B = {
      kk: { y: ["1 Иә", "2 Жоқ"], hz: ["1 < 1 ай", "2 1–3 ай", "3 > 3 ай"], ck: ["1 Бәрі жақсы", "2 Кетуді ойлап жүрмін", "3 Кеттім"] },
      ru: { y: ["1 Да", "2 Нет"], hz: ["1 < месяца", "2 1–3 мес.", "3 > 3 мес."], ck: ["1 Всё хорошо", "2 Думаю уйти", "3 Ушёл(ла)"] },
      en: { y: ["1 Yes", "2 No"], hz: ["1 < month", "2 1–3 months", "3 3+ months"], ck: ["1 All good", "2 Thinking of leaving", "3 I left"] },
    }[L];
    switch (c.step) {
      case "lang": return LANG_BUTTONS;
      case "pay": case "workload": case "invite": case "remind": return [B.y];
      case "horizon": return [B.hz];
      case "checkin": return [B.ck];
      case "reason": return [["1", "2", "3"], ["4", "5", "6"]];
      case "rate": return [["1", "2", "3", "4", "5"]];
    }
    return null;
  }

  function vacancyFromText(s, text) {
    var m = String(text || "").toUpperCase().match(/HF-[A-Z0-9]{3,8}/);
    if (m) {
      var v = s.vacancies.filter(function (x) { return x.code === m[0]; })[0];
      if (v) return v;
    }
    // Without a code, real candidates go to the newest real vacancy, never to an interview scenario.
    var open = s.vacancies.filter(function (x) { return x.active !== false && !x.scenario; });
    if (!open.length) open = s.vacancies.filter(function (x) { return x.active !== false; });
    return open[open.length - 1] || null;
  }

  function nextCode(s) {
    var n = s.vacancies.length + 1, code;
    do { code = "HF-" + (100 + n++); } while (s.vacancies.some(function (v) { return v.code === code; }));
    return code;
  }

  // ---------- conversation ----------
  function handleText(s, v, c, text, now, out) {
    var L = langOf(c, v), t = T[L], a = c.answers = c.answers || {};
    switch (c.step) {
      case "lang": {
        var lg = parseLang(text);
        if (!lg) return say(out, c, ASK_LANG, now);
        c.lang = lg; c.step = "days";
        say(out, c, T[lg].welcome(v), now);
        return say(out, c, T[lg].qDays, now);
      }
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
        var ch = /(ушел|ушёл|ушла|уволил|left|quit|кеттім|кетіп қалдым)/.test(low) ? 3 : /(думаю|thinking|ойлап)/.test(low) ? 2 : parseChoice(text, 3);
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
          pay: +d.pay || 0, workload: d.workload || "", start: d.start || "", lang: LANGS.indexOf(d.lang) >= 0 ? d.lang : "ru",
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
            out.push({ candidateId: null, channel: action.channel, phone: action.phone, text: T.kk.noVacancy + "\n\n" + T.ru.noVacancy + "\n\n" + T.en.noVacancy });
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
          // Example data and in-page tests can fix the language; real candidates choose it first.
          if (action.lang && LANGS.indexOf(action.lang) >= 0) {
            c.lang = action.lang;
            say(out, c, T[c.lang].welcome(v), now);
            say(out, c, T[c.lang].qDays, now);
          } else {
            c.step = "lang";
            say(out, c, ASK_LANG, now);
          }
          break;
        }
        v = findV(s, c.vacancyId);
        c.messages.push({ from: "cand", text: action.text, t: now });
        c.lastInAt = now;
        handleText(s, v, c, action.text, now, out);
        break;
      }
      case "invite": {
        c = findC(s, action.id); if (!c) break; v = findV(s, c.vacancyId); t = T[langOf(c, v)];
        c.slot = action.slot; c.status = "invited"; c.step = "invite"; log(c, "invited", c.slot, now);
        say(out, c, t.invite(v, c), now);
        break;
      }
      case "remind": {
        c = findC(s, action.id); if (!c) break; v = findV(s, c.vacancyId); t = T[langOf(c, v)];
        c.step = "remind"; c.reminded = true; log(c, "reminded", "", now);
        say(out, c, t.remind(v, c), now);
        break;
      }
      case "mark": {
        c = findC(s, action.id); if (!c) break; v = findV(s, c.vacancyId); t = T[langOf(c, v)];
        c.status = action.status; log(c, action.status, "", now);
        if (action.status === "hired") { c.hiredAt = now; say(out, c, t.hired(v, c), now); }
        if (action.status === "rejected") say(out, c, t.rejected(v), now);
        break;
      }
      case "checkin": {
        c = findC(s, action.id); if (!c) break; v = findV(s, c.vacancyId); t = T[langOf(c, v)];
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
      case "addScenarios": {
        // Adds the R1–R8 interview scenarios next to existing data; run again to refresh them.
        var keepV = s.vacancies.filter(function (x) { return !x.scenario; }).map(function (x) { return x.id; });
        s.vacancies = s.vacancies.filter(function (x) { return keepV.indexOf(x.id) >= 0; });
        s.candidates = s.candidates.filter(function (x) { return keepV.indexOf(x.vacancyId) >= 0; });
        if (!action.remove) s = scenarios(s, now, action.lang);
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
    var DAY = 86400000, base = now - 40 * DAY, en = lang === "en", kk = lang === "kk";
    var r = apply(emptyState(), { type: "createVacancy", now: base, data: en ? {
      cafe: "Example Coffee", role: "Barista", area: "Almaty, Samal-2", days: [1, 2, 3, 4, 5, 6, 7],
      shiftsPerWeek: 4, hours: "08:00–16:00", pay: 9000, workload: "up to 120 cups a shift, morning student rush",
      start: "from 1 November", lang: "en", example: true } : kk ? {
      cafe: "Example Coffee", role: "Бариста", area: "Алматы, Самал-2 ш/а", days: [1, 2, 3, 4, 5, 6, 7],
      shiftsPerWeek: 4, hours: "08:00–16:00", pay: 9000, workload: "ауысымына 120 шыныаяққа дейін, таңертең студенттер көп",
      start: "1 қарашадан", lang: "kk", example: true } : {
      cafe: "Example Coffee", role: "Бариста", area: "Алматы, мкр. Самал-2", days: [1, 2, 3, 4, 5, 6, 7],
      shiftsPerWeek: 4, hours: "08:00–16:00", pay: 9000, workload: "до 120 чашек за смену, утренний поток студентов",
      start: "с 1 ноября", lang: "ru", example: true } });
    var s = r.state, v = s.vacancies[0];
    var people = [
      { name: en ? "Aigerim" : "Айгерим", days: "1 2 4 6 7", pay: "1", work: "1", hz: "3", exp: en ? "barista, 8 months" : kk ? "бариста, 8 ай" : "бариста 8 месяцев", path: ["invite", "yes", "came", "hired", "d7ok", "d30ok"] },
      { name: en ? "Daniyar" : "Данияр", days: "3 4 5 6", pay: "1", work: "1", hz: "2", exp: en ? "waiter, 1 year" : "официант 1 год", path: ["invite", "yes", "remindyes", "came", "hired", "d7ok", "d30left"] },
      { name: en ? "Madina" : "Мадина", days: "1 3 5 6", pay: "1", work: "1", hz: "3", exp: en ? "none" : "нет", path: ["invite", "yes", "noshow"] },
      { name: en ? "Arman" : "Арман", days: "6 7", pay: "1", work: "1", hz: "2", exp: en ? "cashier, 3 months" : "кассир 3 месяца", path: [] },
      { name: en ? "Zhanna" : "Жанна", days: "1 2 3 5", pay: "2", work: "1", hz: "3", exp: en ? "barista, 2 years" : "бариста 2 года", path: [] },
      { name: en ? "Timur" : "Тимур", days: "2 3 4 5 6", pay: "1", work: "1", hz: "3", exp: en ? "barista, 4 months" : "бариста 4 месяца", path: [] },
    ];
    people.forEach(function (p, i) {
      var t0 = base + (i + 1) * 3600000;
      s = apply(s, { type: "incoming", channel: "sim", phone: "", text: (en ? "Hello! " : kk ? "Сәлеметсіз бе! " : "Здравствуйте! ") + v.code, vacancyId: v.id, now: t0, example: true, lang: v.lang }).state;
      var c = s.candidates[s.candidates.length - 1];
      [p.days, p.pay, p.work, p.hz, p.name, p.exp].forEach(function (txt, k) {
        s = apply(s, { type: "incoming", candidateId: c.id, text: txt, now: t0 + (k + 1) * 40000 }).state;
      });
      var tt = t0 + 2 * DAY;
      p.path.forEach(function (step) {
        tt += DAY / 2;
        if (step === "invite") s = apply(s, { type: "invite", id: c.id, slot: en ? "Fri, 15:00" : kk ? "Жм, 15:00" : "Пт, 15:00", now: tt }).state;
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

  // ---------- scenario walkthroughs built from the eight customer interviews (Assignment 3) ----------
  // These are simulations, not user tests: each café profile and problem comes from one interview (R1–R8);
  // the candidates, answers and outcomes are invented to show how that owner would use the bot.
  var SCEN = [
    { r: "R1", cafe: { ru: "Кофейня у ЖК (R1)", kk: "ТҮК жанындағы кофехана (R1)", en: "Housing-estate coffee shop (R1)" },
      role: { ru: "Бариста", kk: "Бариста", en: "Barista" }, area: { ru: "Алматы, жилой комплекс", kk: "Алматы, тұрғын үй кешені", en: "Almaty, housing estate" },
      days: [1, 2, 3, 4, 5, 6, 7], spw: 3, hours: "07:30–15:30", pay: 8500,
      work: { ru: "утренний поток жителей, касса и бар", kk: "таңертеңгі тұрғындар ағыны, касса және бар", en: "morning rush of residents, till and bar" },
      people: [
        { name: "Айдана", lang: "kk", a: ["1 2 3 6", "1", "1", "3", "Айдана", "бариста, 5 ай"], path: ["invite", "yes", "remindyes", "came", "hired", "d7ok"] },
        { name: "Ерлан", lang: "ru", a: ["2 4 6", "1", "1", "2", "Ерлан", "официант 1 год"], path: ["invite", "yes"] },
      ] },
    { r: "R2", cafe: { ru: "Кофе с собой (R2)", kk: "Алып кететін кофе (R2)", en: "Takeaway coffee point (R2)" },
      role: { ru: "Бариста-кассир", kk: "Бариста-кассир", en: "Barista-cashier" }, area: { ru: "Алматы, остановка у БЦ", kk: "Алматы, БО жанындағы аялдама", en: "Almaty, bus stop by an office centre" },
      days: [1, 2, 3, 4, 5], spw: 5, hours: "07:00–14:00", pay: 8000,
      work: { ru: "один на точке: бар и касса с первого дня", kk: "нүктеде жалғыз: бірінші күннен бар және касса", en: "alone at the point: bar and till from day one" },
      people: [
        { name: "Дана", lang: "ru", a: ["1 2 3 4 5", "1", "1", "3", "Дана", "бариста 1 год, касса"], path: ["invite", "yes", "came", "hired", "d7ok", "d30ok"] },
      ] },
    { r: "R3", cafe: { ru: "Кофейня у университета (R3)", kk: "Университет жанындағы кофехана (R3)", en: "Coffee shop by a university (R3)" },
      role: { ru: "Бариста (студент)", kk: "Бариста (студент)", en: "Barista (student)" }, area: { ru: "Алматы, рядом с кампусом", kk: "Алматы, кампус жанында", en: "Almaty, next to the campus" },
      days: [1, 2, 3, 4, 5, 6], spw: 3, hours: "15:00–22:00", pay: 7500,
      work: { ru: "вечерние смены, поток студентов после пар", kk: "кешкі ауысым, сабақтан кейін студенттер ағыны", en: "evening shifts, students after classes" },
      people: [
        { name: "Әлинұр", lang: "kk", a: ["1 3 5 6", "1", "1", "3", "Әлинұр", "жоқ"], path: ["invite", "yes", "remindyes", "came", "hired", "d7ok"] },
        { name: "Камила", lang: "ru", a: ["2 4 6", "1", "1", "2", "Камила", "нет"], path: ["invite", "yes", "remindno"] },
        { name: "Nurbek", lang: "en", a: ["1 2 3", "1", "1", "2", "Nurbek", "none"], path: ["invite", "yes", "noshow"] },
        { name: "Томирис", lang: "ru", a: ["6 7", "1", "1", "1", "Томирис", "нет"], path: [] },
      ] },
    { r: "R4", cafe: { ru: "Кофейня с кухней (R4)", kk: "Асханасы бар кофехана (R4)", en: "Coffee shop with a kitchen (R4)" },
      role: { ru: "Повар", kk: "Аспаз", en: "Cook" }, area: { ru: "Алматы, центр", kk: "Алматы, орталық", en: "Almaty, centre" },
      days: [3, 4, 5, 6, 7], spw: 4, hours: "10:00–22:00", pay: 12000,
      work: { ru: "выходные обязательно, до 150 блюд в субботу", kk: "демалыс күндері міндетті, сенбіде 150 тағамға дейін", en: "weekends required, up to 150 dishes on Saturday" },
      people: [
        { name: "Бауыржан", lang: "kk", a: ["3 4 5 6 7", "1", "1", "3", "Бауыржан", "аспаз, 2 жыл"], path: ["invite", "yes", "came", "hired", "d7ok", "d30ok"] },
        { name: "Сергей", lang: "ru", a: ["3 4 5", "1", "2", "2", "Сергей", "повар 3 года"], path: [] },
      ] },
    { r: "R5", cafe: { ru: "Новая кофейня (R5)", kk: "Жаңа кофехана (R5)", en: "New coffee shop (R5)" },
      role: { ru: "Бариста", kk: "Бариста", en: "Barista" }, area: { ru: "Астана, левый берег", kk: "Астана, сол жағалау", en: "Astana, left bank" },
      days: [1, 2, 3, 4, 5, 6, 7], spw: 4, hours: "09:00–18:00", pay: 9000,
      work: { ru: "бар, касса, уборка зала", kk: "бар, касса, залды тазалау", en: "bar, till, cleaning the hall" },
      people: [
        { name: "Мадина", lang: "ru", a: ["1 2 4 5 6", "1", "1", "3", "Мадина", "бариста 3 месяца"], path: ["invite", "yes", "came", "hired", "d7risk:1"] },
      ] },
    { r: "R6", cafe: { ru: "Сеть из двух кофеен (R6)", kk: "Екі кофехана желісі (R6)", en: "Two coffee shops (R6)" },
      role: { ru: "Бариста на две точки", kk: "Екі нүктеге бариста", en: "Barista for two locations" }, area: { ru: "Алматы, две точки", kk: "Алматы, екі нүкте", en: "Almaty, two locations" },
      days: [1, 2, 3, 4, 5, 6, 7], spw: 5, hours: "08:00–20:00", pay: 9500,
      work: { ru: "смены на двух точках, 5 смен в неделю", kk: "екі нүктеде ауысым, аптасына 5 ауысым", en: "shifts at both locations, 5 a week" },
      people: [
        { name: "Арсен", lang: "ru", a: ["1 2 3 4 5", "1", "1", "3", "Арсен", "бариста 1 год"], path: ["invite", "yes", "came", "hired", "d7ok", "d30left:1"] },
        { name: "Жансая", lang: "kk", a: ["1 2 3 4 5 6", "1", "1", "3", "Жансая", "бариста, 7 ай"], path: ["invite", "yes", "remindyes", "came", "hired"] },
      ] },
    { r: "R7", cafe: { ru: "Семейная пекарня (R7)", kk: "Отбасылық наубайхана (R7)", en: "Family bakery café (R7)" },
      role: { ru: "Продавец-кассир", kk: "Сатушы-кассир", en: "Sales assistant" }, area: { ru: "Алматы, микрорайон", kk: "Алматы, шағын аудан", en: "Almaty, residential district" },
      days: [6, 7], spw: 2, hours: "08:00–14:00", pay: 7000,
      work: { ru: "только выходные утром", kk: "тек демалыс күндері таңертең", en: "weekend mornings only" },
      people: [
        { name: "Гүлназ", lang: "kk", a: ["1 2 3", "1", "1", "3", "Гүлназ", "сатушы, 1 жыл"], path: [] },
        { name: "Ольга", lang: "ru", a: ["6 7", "1", "1", "3", "Ольга", "продавец 2 года"], path: ["invite", "yes", "came", "hired"] },
      ] },
    { r: "R8", cafe: { ru: "Кафе с заготовками, Астана (R8)", kk: "Жартылай фабрикаты бар кафе, Астана (R8)", en: "Café with its own kitchen, Astana (R8)" },
      role: { ru: "Администратор", kk: "Әкімші", en: "Administrator" }, area: { ru: "Астана, правый берег", kk: "Астана, оң жағалау", en: "Astana, right bank" },
      days: [1, 2, 3, 4, 5, 6], spw: 5, hours: "09:00–19:00", pay: 10000,
      work: { ru: "зал, касса, приём заказов, без работы на кухне", kk: "зал, касса, тапсырыс қабылдау, асханада жұмыссыз", en: "hall, till, orders, no kitchen work" },
      people: [
        { name: "Әсел", lang: "kk", a: ["1 2 3 4 5", "1", "1", "3", "Әсел", "әкімші, 1 жыл"], path: ["invite", "yes", "came", "hired", "d7ok", "d30ok", "d90left:3"] },
      ] },
  ];
  function scenarios(state, now, lang) {
    var DAY = 86400000, L = LANGS.indexOf(lang) >= 0 ? lang : "ru", s = state;
    var slot = { ru: "Пт, 15:00", kk: "Жм, 15:00", en: "Fri, 15:00" }[L];
    SCEN.forEach(function (sc, si) {
      var base = now - (160 - si * 4) * DAY;
      s = apply(s, { type: "createVacancy", now: base, data: {
        cafe: sc.cafe[L], role: sc.role[L], area: sc.area[L], days: sc.days, shiftsPerWeek: sc.spw, hours: sc.hours,
        pay: sc.pay, workload: sc.work[L], start: { ru: "сразу", kk: "бірден", en: "now" }[L], lang: L, example: true } }).state;
      var v = s.vacancies[s.vacancies.length - 1];
      v.scenario = sc.r; v.free = false;
      sc.people.forEach(function (p, i) {
        var t0 = base + (i + 1) * 5 * 3600000;
        s = apply(s, { type: "incoming", channel: "sim", phone: "", text: v.code, vacancyId: v.id, now: t0, example: true }).state;
        var c = s.candidates[s.candidates.length - 1];
        var langNum = { kk: "1", ru: "2", en: "3" }[p.lang];
        [langNum].concat(p.a).forEach(function (txt, k) {
          s = apply(s, { type: "incoming", candidateId: c.id, text: txt, now: t0 + (k + 1) * 45000 }).state;
        });
        var tt = t0 + DAY;
        p.path.forEach(function (step) {
          tt += DAY / 2;
          var said = function (txt, at) { s = apply(s, { type: "incoming", candidateId: c.id, text: txt, now: at }).state; };
          if (step === "invite") s = apply(s, { type: "invite", id: c.id, slot: slot, now: tt }).state;
          if (step === "yes") said("1", tt + 600000);
          if (step === "remindyes" || step === "remindno") {
            s = apply(s, { type: "remind", id: c.id, now: tt }).state;
            said(step === "remindyes" ? "1" : "2", tt + 900000);
          }
          if (step === "came" || step === "noshow" || step === "hired") s = apply(s, { type: "mark", id: c.id, status: step, now: tt }).state;
          var m = /^d(7|30|90)(ok|risk|left)(?::(\d))?$/.exec(step);
          if (m) {
            var d = +m[1], at = tt + d * DAY;
            s = apply(s, { type: "checkin", id: c.id, day: d, now: at }).state;
            said(m[2] === "ok" ? "1" : m[2] === "risk" ? "2" : "3", at + 1800000);
            if (m[3]) said(m[3], at + 1900000);
            var cc = findC(s, c.id); if (cc && cc.step === "rate") said(String(4 + (i % 2)), at + 2000000);
          }
        });
      });
    });
    return s;
  }

  var HF = {
    PRICE: PRICE, DAY_NAMES: DAY_NAMES, REASONS: REASONS, HORIZON: HORIZON,
    LANGS: LANGS, apply: apply, metrics: metrics, evaluate: evaluate, emptyState: emptyState, seed: seed,
    parseDays: parseDays, parseYesNo: parseYesNo, money: money, dayList: dayList,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = HF;
  else root.HF = HF;
})(typeof window !== "undefined" ? window : this);
