/* FlashcardAnything - vanilla JS, 100% offline.
 * No fetch, no external API. All parsing is deterministic and rule-based.
 */
"use strict";

/* ---------------- Constants & helpers ---------------- */

var STORAGE_KEY = "flashcardanything_decks";
var DRAFT_KEY = "flashcardanything_draft";
var THEME_KEY = "flashcardanything_theme";

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

var toastTimer = null;
function toast(msg) {
  var el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
}

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "id-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
}

function downloadFile(filename, content, mime) {
  var blob = new Blob([content], { type: mime || "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 500);
}

// Copy text to clipboard, with a fallback for older browsers / file:// contexts.
function copyText(text) {
  function done(ok) { toast(ok ? "Sample copied to clipboard." : "Copy failed. Select the sample manually."); }
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
  } else {
    fallback();
  }
  function fallback() {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      done(!!ok);
    } catch (e) {
      done(false);
    }
  }
}

function escapeHtml(s) {  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFilename(name) {
  return (name || "deck").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "deck";
}

/* ---------------- View switching (no reload) ---------------- */

var VIEWS = ["create", "study", "decks"];

function showView(name) {
  if (VIEWS.indexOf(name) === -1) name = "create";
  $all(".view").forEach(function (sec) { sec.classList.remove("active"); });
  $all(".nav-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-view") === name);
  });
  var target = $("#view-" + name);
  if (target) target.classList.add("active");
  if (name === "decks") renderDecks();
  if (name === "study") renderStudy();
}

/* ---------------- Theme (dark mode toggle) ---------------- */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("#theme-icon").innerHTML = theme === "dark" ? "&#9788;" : "&#9790;";
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage unavailable */ }
}

function initTheme() {
  var saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
  applyTheme(saved === "dark" ? "dark" : "light");
}

/* ---------------- Deterministic rule-based parsing (NO AI) ----------------
 * Format A: one card per line, split on a separator (-, :, |, tab, or custom).
 * Format B: alternating lines (line 1 = front, line 2 = back, line 3 = front...).
 * Auto-detect: if >= half of non-empty lines contain a separator -> Format A,
 * otherwise -> Format B. Same input always yields the same output.
 * ------------------------------------------------------------------------ */

function splitOnFirst(line, sep) {
  var idx = line.indexOf(sep);
  if (idx === -1) return null;
  var front = line.slice(0, idx).trim();
  var back = line.slice(idx + sep.length).trim();
  if (!front || !back) return null;
  return { front: front, back: back };
}

// Check whether a line contains any known separator (used for auto-detect).
function lineHasSeparator(line) {
  if (line.indexOf("\t") !== -1) {
    var parts = line.split("\t");
    if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) return true;
  }
  if (line.indexOf("|") !== -1 && splitOnFirst(line, "|")) return true;
  if (line.indexOf(" - ") !== -1 && splitOnFirst(line, " - ")) return true;
  if (line.indexOf(":") !== -1 && splitOnFirst(line, ":")) return true;
  return false;
}

// Split a single Format-A line. Priority: custom > tab > pipe > dash > colon.
function splitFormatALine(line, customDelim) {
  if (customDelim && splitOnFirst(line, customDelim)) return splitOnFirst(line, customDelim);
  if (line.indexOf("\t") !== -1) {
    var tabParts = line.split("\t").map(function (p) { return p.trim(); }).filter(Boolean);
    if (tabParts.length >= 2) return { front: tabParts[0], back: tabParts.slice(1).join("\t") };
  }
  if (line.indexOf("|") !== -1 && splitOnFirst(line, "|")) return splitOnFirst(line, "|");
  if (line.indexOf(" - ") !== -1 && splitOnFirst(line, " - ")) return splitOnFirst(line, " - ");
  if (line.indexOf(":") !== -1 && splitOnFirst(line, ":")) return splitOnFirst(line, ":");
  return null;
}

function getEffectiveCustomDelim() {
  var mode = $("#delimiter-select").value;
  if (mode === "custom") return $("#custom-delimiter").value;
  if (mode === "dash") return " - ";
  if (mode === "colon") return ":";
  if (mode === "pipe") return "|";
  if (mode === "tab") return "\t";
  return ""; // "auto" -> no forced delimiter
}

function parseInput(rawText) {
  var customDelim = getEffectiveCustomDelim();
  var forced = !!customDelim; // user picked an explicit separator
  var allLines = String(rawText || "").split(/\r?\n/);
  // Trim whitespace, drop empty lines (deterministic).
  var lines = allLines.map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });

  var result = { cards: [], format: "none", warnings: [], totalLines: lines.length };

  if (lines.length === 0) {
    result.warnings.push("Nothing to parse. Paste some text first.");
    return result;
  }

  // Auto-detect format by counting separator lines.
  var sepCount = lines.filter(lineHasSeparator).length;
  var useFormatA = forced ? true : sepCount / lines.length >= 0.5;
  result.format = useFormatA ? "A" : "B";

  if (useFormatA) {
    var skipped = 0;
    lines.forEach(function (line) {
      var card = splitFormatALine(line, customDelim);
      if (card) {
        result.cards.push(card);
      } else {
        skipped++;
      }
    });
    if (skipped > 0) {
      result.warnings.push(skipped + " line(s) had no separator and were skipped.");
    }
  } else {
    // Format B: pair lines (front, back). Odd orphan line is ignored.
    for (var i = 0; i < lines.length; i += 2) {
      if (i + 1 < lines.length) {
        result.cards.push({ front: lines[i], back: lines[i + 1] });
      }
    }
    if (lines.length % 2 === 1) {
      result.warnings.push('Last line "' + lines[lines.length - 1] + '" has no pair and was ignored.');
    }
  }

  if (result.cards.length === 0) {
    result.warnings.push("No valid cards found. Check the format examples.");
  }
  return result;
}

/* ---------------- Create view ---------------- */

var lastGenerated = []; // most recent parse result, used for study + save

function handleGenerate(goToStudy) {
  var text = $("#input-text").value;
  var parsed = parseInput(text);
  lastGenerated = parsed.cards;

  var info = $("#parse-info");
  info.hidden = false;
  info.classList.toggle("warn", parsed.warnings.length > 0);

  if (parsed.cards.length === 0) {
    info.textContent = "No cards found. " + parsed.warnings.join(" ");
    $("#preview-panel").hidden = true;
    return;
  }

  var label = parsed.format === "A" ? "Format A (one card per line)" : "Format B (alternating lines)";
  info.textContent = "Detected " + label + ", " + parsed.cards.length + " card(s) ready." +
    (parsed.warnings.length ? " Note: " + parsed.warnings.join(" ") : "");

  // Render preview list.
  $("#preview-count").textContent = parsed.cards.length;
  $("#preview-list").innerHTML = parsed.cards.map(function (c) {
    return "<li><span class=\"p-front\">" + escapeHtml(c.front) +
      "</span><span class=\"p-sep\">&rarr;</span><span>" + escapeHtml(c.back) + "</span></li>";
  }).join("");
  $("#preview-panel").hidden = false;

  // Start a study session with these cards.
  startSession(parsed.cards.slice());

  if (goToStudy !== false) {
    showView("study");
    toast(parsed.cards.length + " flashcards ready!");
  }
}

/* ---------------- Study session ---------------- */

var session = {
  cards: [],   // [{front, back}]
  index: 0,
  flipped: false,
  results: [], // parallel array: null | "knew" | "missed"
  finished: false
};

function shuffleArray(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

function startSession(cards) {
  session.cards = cards || [];
  session.index = 0;
  session.flipped = false;
  session.finished = false;
  session.results = session.cards.map(function () { return null; });
  $("#study-summary").hidden = true;
  renderStudy();
}

function currentCard() { return session.cards[session.index]; }

function renderStudy() {
  var hasCards = session.cards.length > 0;
  $("#study-empty").hidden = hasCards;
  $("#study-main").hidden = !hasCards;
  if (!hasCards) return;

  // Clamp index.
  if (session.index < 0) session.index = 0;
  if (session.index >= session.cards.length) session.index = session.cards.length - 1;

  var card = currentCard();
  $("#card-front").textContent = card.front;
  $("#card-back").textContent = card.back;
  $("#flashcard").classList.toggle("flipped", session.flipped);
  $("#flashcard").setAttribute("aria-label",
    "Flashcard " + (session.index + 1) + " of " + session.cards.length +
    ". Front: " + card.front + (session.flipped ? ". Back: " + card.back : ""));

  $("#position-indicator").textContent = (session.index + 1) + " / " + session.cards.length;
  var pct = session.cards.length ? ((session.index + 1) / session.cards.length) * 100 : 0;
  $("#progress-fill").style.width = pct + "%";

  var knew = session.results.filter(function (r) { return r === "knew"; }).length;
  var missed = session.results.filter(function (r) { return r === "missed"; }).length;
  $("#score-live").innerHTML = "&#10003; " + knew + " &nbsp;&#10007; " + missed;

  // Summary visibility: show when every card has been graded.
  var allGraded = session.results.length > 0 && session.results.every(function (r) { return r !== null; });
  if (allGraded && !session.finished) {
    session.finished = true;
  }
  if (session.finished) {
    $("#study-summary").hidden = false;
    var total = session.cards.length;
    $("#summary-text").textContent = "You got " + knew + " of " + total + " right. " +
      (knew === total ? "Perfect!" : missed > 0 ? "Nice!" : "Keep going!");
    $("#btn-review-missed").disabled = missed === 0;
  } else {
    $("#study-summary").hidden = true;
  }

  $("#btn-prev").disabled = session.index === 0;
  $("#btn-next").disabled = session.index === session.cards.length - 1;
}

function flipCard() {
  if (!session.cards.length) return;
  session.flipped = !session.flipped;
  renderStudy();
}

function goTo(delta) {
  if (!session.cards.length) return;
  var next = session.index + delta;
  if (next < 0 || next >= session.cards.length) return;
  session.index = next;
  session.flipped = false;
  $("#study-summary").hidden = !session.finished;
  renderStudy();
}

function gradeCurrent(mark) {
  if (!session.cards.length) return;
  session.results[session.index] = mark;
  session.flipped = false;
  // Auto-advance: if not on the last card, move next; else finish.
  if (session.index < session.cards.length - 1) {
    session.index++;
  } else {
    session.finished = true;
  }
  renderStudy();
}

/* ---------------- localStorage: saved decks ---------------- */

function loadDecks() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    var data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function saveDecks(decks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
    return true;
  } catch (e) {
    toast("Could not save. Storage is full or unavailable.");
    return false;
  }
}

function isValidDeck(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (!Array.isArray(obj.cards) || obj.cards.length === 0) return false;
  return obj.cards.every(function (c) {
    return c && typeof c.front === "string" && typeof c.back === "string" &&
      c.front.trim() && c.back.trim();
  });
}

function normalizeDeck(obj) {
  return {
    id: (typeof obj.id === "string" && obj.id) ? obj.id : makeId(),
    title: (typeof obj.title === "string" && obj.title.trim()) ? obj.title.trim().slice(0, 80) : "Untitled deck",
    cards: obj.cards.map(function (c) { return { front: String(c.front).trim(), back: String(c.back).trim() }; }),
    createdAt: typeof obj.createdAt === "number" ? obj.createdAt : Date.now()
  };
}

function handleSaveDeck() {
  if (!lastGenerated.length) {
    toast("Generate flashcards first.");
    return;
  }
  var title = $("#deck-title").value.trim() || "Untitled deck";
  var decks = loadDecks();
  decks.unshift({ id: makeId(), title: title.slice(0, 80), cards: lastGenerated.slice(), createdAt: Date.now() });
  if (saveDecks(decks)) {
    $("#deck-title").value = "";
    toast('Deck "' + title + '" saved.');
  }
}

function renderDecks() {
  var decks = loadDecks();
  var list = $("#decks-list");
  $("#decks-empty").style.display = decks.length ? "none" : "";
  list.innerHTML = "";

  decks.forEach(function (deck) {
    var li = document.createElement("li");
    li.className = "deck-item";
    var date = deck.createdAt ? new Date(deck.createdAt).toLocaleDateString() : "";
    li.innerHTML =
      "<h3>" + escapeHtml(deck.title) + "</h3>" +
      '<p class="deck-meta">' + deck.cards.length + " card(s)" + (date ? " &middot; " + escapeHtml(date) : "") + "</p>" +
      '<div class="deck-actions"></div>';

    var actions = li.querySelector(".deck-actions");

    var openBtn = document.createElement("button");
    openBtn.className = "btn btn-primary btn-small";
    openBtn.type = "button";
    openBtn.textContent = "Study";
    openBtn.addEventListener("click", function () {
      lastGenerated = deck.cards.slice();
      startSession(deck.cards.slice());
      showView("study");
    });

    var exportBtn = document.createElement("button");
    exportBtn.className = "btn btn-ghost btn-small";
    exportBtn.type = "button";
    exportBtn.textContent = "Export JSON";
    exportBtn.addEventListener("click", function () {
      downloadFile(safeFilename(deck.title) + ".json", JSON.stringify(deck, null, 2));
      toast("Deck exported.");
    });

    var txtBtn = document.createElement("button");
    txtBtn.className = "btn btn-ghost btn-small";
    txtBtn.type = "button";
    txtBtn.textContent = "Export TXT";
    txtBtn.addEventListener("click", function () {
      var txt = deck.cards.map(function (c) { return c.front + " - " + c.back; }).join("\n");
      downloadFile(safeFilename(deck.title) + ".txt", txt, "text/plain");
      toast("Deck exported as text.");
    });

    var delBtn = document.createElement("button");
    delBtn.className = "btn btn-ghost btn-small";
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", function () {
      var remaining = loadDecks().filter(function (d) { return d.id !== deck.id; });
      saveDecks(remaining);
      renderDecks();
      toast("Deck deleted.");
    });

    actions.appendChild(openBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(txtBtn);
    actions.appendChild(delBtn);
    list.appendChild(li);
  });
}

function importParsedDecks(parsed) {
  var candidates = Array.isArray(parsed) ? parsed : [parsed];
  var decks = loadDecks();
  var imported = 0;
  var existingIds = {};
  decks.forEach(function (d) { existingIds[d.id] = true; });

  candidates.forEach(function (c) {
    if (isValidDeck(c)) {
      var deck = normalizeDeck(c);
      if (existingIds[deck.id]) deck.id = makeId(); // avoid id collision
      existingIds[deck.id] = true;
      decks.unshift(deck);
      imported++;
    }
  });

  if (imported > 0) {
    saveDecks(decks);
  }
  return imported;
}

function handleImportFile(file) {
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var parsed = JSON.parse(String(reader.result));
      var imported = importParsedDecks(parsed);
      if (imported > 0) {
        renderDecks();
        toast("Imported " + imported + " deck(s).");
      } else {
        toast("No valid decks found in that file.");
      }
    } catch (e) {
      toast("Import failed. Invalid JSON file.");
    }
    $("#import-file").value = "";
  };
  reader.readAsText(file);
}

/* ---------------- Paste JSON modal ---------------- */

function openPasteModal() {
  var modal = $("#paste-modal");
  if (!modal) return;
  modal.hidden = false;
  var err = $("#paste-json-error");
  if (err) err.hidden = true;
  var ta = $("#paste-json-text");
  if (ta) ta.focus();
}

function closePasteModal() {
  var modal = $("#paste-modal");
  if (!modal) return;
  modal.hidden = true;
}

function handlePasteImport() {
  var ta = $("#paste-json-text");
  var errBox = $("#paste-json-error");
  function showError(msg) {
    if (errBox) {
      errBox.hidden = false;
      errBox.textContent = msg;
    } else {
      toast(msg);
    }
  }
  var text = ta ? ta.value.trim() : "";
  if (!text) {
    showError("Paste JSON first. Tip: click Fill sample to see the format.");
    return;
  }
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    showError("Invalid JSON: " + (e && e.message ? e.message : "could not be parsed."));
    return;
  }
  var imported = importParsedDecks(parsed);
  if (imported > 0) {
    renderDecks();
    ta.value = "";
    if (errBox) errBox.hidden = true;
    closePasteModal();
    toast("Imported " + imported + " deck(s).");
  } else {
    showError("No valid decks found. Each deck needs a cards array like { \"front\": \"Hola\", \"back\": \"Hello\" }.");
  }
}

/* ---------------- Events & init ---------------- */

function init() {
  initTheme();

  // Nav + logo.
  $all("[data-view]").forEach(function (btn) {
    btn.addEventListener("click", function () { showView(btn.getAttribute("data-view")); });
  });
  $("#logo-link").addEventListener("click", function (e) {
    e.preventDefault();
    showView("create");
  });

  $("#theme-toggle").addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });

  // Create view.
  $("#delimiter-select").addEventListener("change", function () {
    $("#custom-delimiter").hidden = $("#delimiter-select").value !== "custom";
  });
  $("#btn-generate").addEventListener("click", function () { handleGenerate(true); });
  $("#btn-clear").addEventListener("click", function () {
    $("#input-text").value = "";
    $("#preview-panel").hidden = true;
    $("#parse-info").hidden = true;
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
    $("#input-text").focus();
  });
  $("#btn-save").addEventListener("click", handleSaveDeck);

  // Auto-save draft input (restored on load).
  try {
    var draft = localStorage.getItem(DRAFT_KEY);
    if (draft) $("#input-text").value = draft;
  } catch (e) { /* ignore */ }
  $("#input-text").addEventListener("input", function () {
    try { localStorage.setItem(DRAFT_KEY, $("#input-text").value); } catch (e) { /* ignore */ }
  });

  // Study view.
  $("#flashcard").addEventListener("click", flipCard);
  $("#flashcard").addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flipCard(); }
  });
  $("#btn-flip").addEventListener("click", flipCard);
  $("#btn-prev").addEventListener("click", function () { goTo(-1); });
  $("#btn-next").addEventListener("click", function () { goTo(1); });
  $("#btn-shuffle").addEventListener("click", function () {
    if (!session.cards.length) return;
    shuffleArray(session.cards);
    session.index = 0;
    session.flipped = false;
    session.finished = false;
    session.results = session.cards.map(function () { return null; });
    $("#study-summary").hidden = true;
    renderStudy();
    toast("Cards shuffled.");
  });
  $("#btn-knew").addEventListener("click", function () { gradeCurrent("knew"); });
  $("#btn-missed").addEventListener("click", function () { gradeCurrent("missed"); });
  $("#btn-restart").addEventListener("click", function () {
    startSession(session.cards.slice());
  });
  $("#btn-summary-restart").addEventListener("click", function () {
    startSession(session.cards.slice());
  });
  $("#btn-review-missed").addEventListener("click", function () {
    var missed = session.cards.filter(function (_, i) { return session.results[i] === "missed"; });
    if (!missed.length) { toast("No missed cards. Well done!"); return; }
    startSession(missed);
    toast("Reviewing " + missed.length + " missed card(s).");
  });
  $("#btn-print").addEventListener("click", function () { window.print(); });
  $("#btn-clear-study").addEventListener("click", function () {
    if (!session.cards.length) return;
    startSession([]); // back to the empty state
    toast("Study session cleared.");
  });

  // Decks view.
  $("#btn-import").addEventListener("click", function () { $("#import-file").click(); });
  $("#import-file").addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) handleImportFile(e.target.files[0]);
  });
  $("#btn-paste-json").addEventListener("click", openPasteModal);
  $("#btn-paste-cancel").addEventListener("click", closePasteModal);
  $("#btn-paste-import").addEventListener("click", handlePasteImport);
  $("#btn-paste-sample").addEventListener("click", function () {
    var sample = $("#sample-json") ? $("#sample-json").textContent.trim() : "";
    $("#paste-json-text").value = sample;
    $("#paste-json-error").hidden = true;
    $("#paste-json-text").focus();
  });
  var pasteOverlay = document.querySelector("[data-close-paste]");
  if (pasteOverlay) pasteOverlay.addEventListener("click", closePasteModal);
  $("#btn-export-all").addEventListener("click", function () {
    var decks = loadDecks();
    if (!decks.length) { toast("No decks to export."); return; }
    downloadFile("flashcardanything-decks.json", JSON.stringify(decks, null, 2));
    toast("All decks exported.");
  });

  // Sample import JSON (mirrors the <pre> shown in My Decks).
  $("#btn-download-sample").addEventListener("click", function () {
    downloadFile("sample-deck.json", $("#sample-json").textContent.trim() + "\n");
    toast("Sample JSON downloaded.");
  });
  $("#btn-copy-sample").addEventListener("click", function () {
    var text = $("#sample-json").textContent.trim();
    copyText(text);
  });

  // Keyboard shortcuts: Space = flip, arrows = navigate (only in study view,
  // and never while typing in a text field).
  document.addEventListener("keydown", function (e) {
    var pasteModal = $("#paste-modal");
    if (pasteModal && !pasteModal.hidden && e.key === "Escape") {
      closePasteModal();
      return;
    }
    var studyActive = $("#view-study").classList.contains("active");
    if (!studyActive || !session.cards.length) return;
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (e.key === " ") { e.preventDefault(); flipCard(); }
    else if (e.key === "ArrowRight") { goTo(1); }
    else if (e.key === "ArrowLeft") { goTo(-1); }
  });

  showView("create");
}

document.addEventListener("DOMContentLoaded", init);
