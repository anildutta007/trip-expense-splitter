/**
 * Trip Split Expense — Frontend Application Logic
 * Supports:
 * 1. Creating trips with Name & Everyone's Names, listed on the home page
 * 2. Opening any trip directly from the home page
 * 3. Adding, removing, or updating/renaming people in the group after the trip is created
 * 4. 20-second "Yeh Dosti Hum Nahi Todenge" (Sholay) music player
 * 5. Adding an expense by hand (who paid, amount, category, tick who shared, optional bill photo via Camera Snapshot or File Upload)
 * 6. AI Receipt Scanning via Camera Snapshot or uploading 1 or more photos/PDFs (reads total, description, category, date; splits between everyone)
 * 7. Who pays whom (strictly fewest payments to settle up, "Mark paid" -> moves to payments list, "Undo" there)
 * 8. Exporting all expenses as a CSV spreadsheet
 */

const STORAGE_KEY_TRIPS = "tripsplit_ai_trips_v1";
const STORAGE_KEY_ACTIVE_TRIP = "tripsplit_active_trip_id_v1";
const STORAGE_KEY_DRAFT_TRIP = "tripsplit_draft_trip_v1";
const STORAGE_KEY_GEMINI = "tripsplit_ai_gemini_key";
const IDB_NAME = "DostiPakkiExpenseDB";
const IDB_STORE = "trips_kv";

const CATEGORY_META = {
  "Food & Drink": { icon: "ph-fork-knife", badge: "bg-orange-50 text-orange-700 border-orange-200" },
  "Transport": { icon: "ph-car-profile", badge: "bg-blue-50 text-blue-700 border-blue-200" },
  "Accommodation": { icon: "ph-bed", badge: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  "Groceries": { icon: "ph-shopping-cart", badge: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  "Activities": { icon: "ph-ticket", badge: "bg-purple-50 text-purple-700 border-purple-200" },
  "Shopping": { icon: "ph-shopping-bag", badge: "bg-pink-50 text-pink-700 border-pink-200" },
  "Other": { icon: "ph-receipt", badge: "bg-slate-100 text-slate-700 border-slate-200" }
};

// Application State
let allTripsMap = {};          // { [tripId]: TripObject }
let draftMembers = ["Alice", "Bob", "Charlie"]; // Initial starter chips in Create Trip form
let activeTrip = null;         // Currently open trip
let manualPhotoDataUrl = null; // Optional bill photo attached to manual expense
let manualPhotoName = null;
let selectedScanFiles = [];    // Files/snapshots queued for AI receipt scanning

// Camera Snapshot State
let cameraStream = null;
let cameraTargetMode = "manual"; // 'manual' | 'scan'
let cameraFacingMode = "environment";

// "Yeh Dosti Hum Nahi Todenge" (Sholay) 20-Second Music State
const YEH_DOSTI_DURATION_SEC = 20;
const YEH_DOSTI_STREAM_URLS = [
  "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/53/6c/7c/536c7c03-29d3-efe2-41d0-3fc76b0af180/mzaf_157281235695885810.plus.aac.p.m4a",
  "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview221/v4/72/72/37/727237d8-c4f1-7130-6706-bea8d88b8664/mzaf_7999694924097754293.plus.aac.p.m4a"
];
let yehDostiAudio = null;
let yehDostiSynthCtx = null;
let yehDostiInterval = null;
let yehDostiStopTimeout = null;
let isYehDostiPlaying = false;
let yehDostiStartTimeMs = 0;

let yehDostiAutoUnlockBound = false;

// ----------------- Initialization -----------------

document.addEventListener("DOMContentLoaded", async () => {
  initDefaultDateInputs();
  restoreDraftTripState();
  bindDraftFormPersistence();
  renderDraftMembers();
  await loadAllTrips();

  // Restore last open trip if the user closed the app while inside a trip
  try {
    const lastActiveId = localStorage.getItem(STORAGE_KEY_ACTIVE_TRIP);
    if (lastActiveId && allTripsMap[lastActiveId]) {
      await openTrip(lastActiveId);
    }
  } catch (_) {}

  // Flush state before tab/window closes or hides
  window.addEventListener("beforeunload", () => {
    saveDraftTripState();
    if (activeTrip && activeTrip.id) {
      allTripsMap[activeTrip.id] = activeTrip;
    }
    saveLocalTripsMap(allTripsMap);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveDraftTripState();
      if (activeTrip && activeTrip.id) {
        allTripsMap[activeTrip.id] = activeTrip;
      }
      saveLocalTripsMap(allTripsMap);
    }
  });

  // Play "Yeh Dosti Hum Nahi Todenge" (20s) by default when visiting the website
  autoPlayYehDostiOnVisit();
});

function initDefaultDateInputs() {
  const today = new Date().toISOString().split("T")[0];
  const dateInput = document.getElementById("manualDate");
  if (dateInput) dateInput.value = today;
}

// ----------------- "YEH DOSTI HUM NAHI TODENGE" (SHOLAY) 20s MUSIC PLAYER -----------------

function autoPlayYehDostiOnVisit() {
  playYehDostiMusic(true);
}

function bindFirstInteractionUnlock() {
  if (yehDostiAutoUnlockBound) return;
  yehDostiAutoUnlockBound = true;

  const bar = document.getElementById("yehDostiPlayerBar");
  const timer = document.getElementById("yehDostiTimerLabel");
  if (bar) bar.classList.remove("hidden");
  if (timer) timer.textContent = "Tap to Play (20s)";

  const unlockHandler = () => {
    if (!yehDostiAutoUnlockBound) return;
    yehDostiAutoUnlockBound = false;
    ["pointerdown", "click", "touchstart", "keydown"].forEach(evt =>
      document.removeEventListener(evt, unlockHandler, true)
    );
    playYehDostiMusic(false);
  };

  ["pointerdown", "click", "touchstart", "keydown"].forEach(evt =>
    document.addEventListener(evt, unlockHandler, { capture: true, once: true })
  );
}

function toggleYehDostiMusic() {
  if (isYehDostiPlaying) {
    stopYehDostiMusic();
  } else {
    playYehDostiMusic(false);
  }
}

async function playYehDostiMusic(isAutoAttempt = false) {
  stopYehDostiMusic();

  let startedStream = false;
  let blockedByAutoplayPolicy = false;

  for (const url of YEH_DOSTI_STREAM_URLS) {
    try {
      yehDostiAudio = new Audio(url);
      yehDostiAudio.volume = 0.85;
      yehDostiAudio.currentTime = 0;
      await yehDostiAudio.play();
      startedStream = true;
      break;
    } catch (err) {
      if (err && (err.name === "NotAllowedError" || String(err).includes("NotAllowedError") || String(err).includes("interact"))) {
        blockedByAutoplayPolicy = true;
        break;
      }
    }
  }

  // If browser blocked unmuted autoplay on initial cold page load, arm instant playback on first click/tap anywhere
  if (!startedStream && blockedByAutoplayPolicy && isAutoAttempt) {
    bindFirstInteractionUnlock();
    return;
  }

  isYehDostiPlaying = true;
  yehDostiStartTimeMs = Date.now();
  updateYehDostiUi(true, YEH_DOSTI_DURATION_SEC, 0);

  // Fallback to Web Audio API synthesizer playing the "Yeh Dosti Hum Nahi Todenge" melody if offline
  if (!startedStream) {
    startYehDostiSynthMelody(YEH_DOSTI_DURATION_SEC);
  }

  // Update 20-second progress bar & countdown every 200ms
  yehDostiInterval = setInterval(() => {
    const elapsedSec = (Date.now() - yehDostiStartTimeMs) / 1000;
    const remainingSec = Math.max(0, Math.ceil(YEH_DOSTI_DURATION_SEC - elapsedSec));
    const pct = Math.min(100, (elapsedSec / YEH_DOSTI_DURATION_SEC) * 100);
    updateYehDostiUi(true, remainingSec, pct);

    if (elapsedSec >= YEH_DOSTI_DURATION_SEC) {
      stopYehDostiMusic();
    }
  }, 200);

  // Strict 20-second stop timer
  yehDostiStopTimeout = setTimeout(() => {
    stopYehDostiMusic();
  }, YEH_DOSTI_DURATION_SEC * 1000);
}

function stopYehDostiMusic() {
  isYehDostiPlaying = false;
  yehDostiAutoUnlockBound = false;
  if (yehDostiInterval) {
    clearInterval(yehDostiInterval);
    yehDostiInterval = null;
  }
  if (yehDostiStopTimeout) {
    clearTimeout(yehDostiStopTimeout);
    yehDostiStopTimeout = null;
  }
  if (yehDostiAudio) {
    try {
      yehDostiAudio.pause();
      yehDostiAudio.currentTime = 0;
    } catch (_) {}
    yehDostiAudio = null;
  }
  if (yehDostiSynthCtx) {
    try {
      yehDostiSynthCtx.close();
    } catch (_) {}
    yehDostiSynthCtx = null;
  }
  updateYehDostiUi(false, YEH_DOSTI_DURATION_SEC, 0);
}

function updateYehDostiUi(playing, remainingSec, pct) {
  const bar = document.getElementById("yehDostiPlayerBar");
  const progress = document.getElementById("yehDostiProgressBar");
  const timer = document.getElementById("yehDostiTimerLabel");
  const btnIcon = document.getElementById("yehDostiHeaderIcon");
  const btnText = document.getElementById("yehDostiHeaderText");
  const btn = document.getElementById("yehDostiHeaderBtn");

  if (playing) {
    if (bar) bar.classList.remove("hidden");
    if (progress) progress.style.width = `${pct}%`;
    if (timer) timer.textContent = `${remainingSec}s`;
    if (btnIcon) btnIcon.className = "ph-bold ph-stop-circle text-rose-600 text-sm animate-spin";
    if (btnText) btnText.textContent = `Playing (${remainingSec}s)`;
    if (btn) btn.className = "text-xs font-bold flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-amber-100 text-amber-950 border border-amber-400 transition shadow-xs cursor-pointer";
  } else {
    if (bar) bar.classList.add("hidden");
    if (progress) progress.style.width = "0%";
    if (timer) timer.textContent = "20s";
    if (btnIcon) btnIcon.className = "ph-bold ph-music-notes text-amber-600 text-sm";
    if (btnText) btnText.textContent = "Yeh Dosti (20s)";
    if (btn) btn.className = "text-xs font-bold flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 transition shadow-xs cursor-pointer";
  }
}

function startYehDostiSynthMelody(durationSec) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    yehDostiSynthCtx = new AudioCtx();
    const ctx = yehDostiSynthCtx;

    // Iconic "Yeh Dosti Hum Nahi Todenge" melody phrases in C major (frequencies in Hz)
    const N = {
      C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
      C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, R: 0
    };

    // Sequence of [noteFreq, durationSeconds] representing:
    // "Yeh dosti... hum nahi todenge... todenge dum magar... tera saath na chhodenge!"
    const phrase = [
      // "Yeh do-sti..."
      [N.G4, 0.45], [N.A4, 0.45], [N.G4, 0.90], [N.R, 0.20],
      // "hum na-hi to-den-ge..."
      [N.E4, 0.35], [N.G4, 0.35], [N.A4, 0.40], [N.C5, 0.45], [N.B4, 0.40], [N.A4, 0.75], [N.R, 0.25],
      // "to-den-ge dum ma-gar..."
      [N.A4, 0.35], [N.B4, 0.35], [N.C5, 0.45], [N.D5, 0.45], [N.B4, 0.45], [N.G4, 0.70], [N.R, 0.20],
      // "te-ra saath na chho-den-ge!"
      [N.E4, 0.35], [N.G4, 0.35], [N.A4, 0.45], [N.G4, 0.40], [N.F4, 0.35], [N.E4, 0.40], [N.D4, 0.40], [N.C4, 0.85], [N.R, 0.35]
    ];

    let cursor = ctx.currentTime + 0.05;
    const endTime = cursor + durationSec;

    while (cursor < endTime) {
      for (const [freq, dur] of phrase) {
        if (cursor >= endTime) break;
        if (freq > 0) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(freq, cursor);

          gain.gain.setValueAtTime(0.001, cursor);
          gain.gain.exponentialRampToValueAtTime(0.22, cursor + 0.04);
          gain.gain.exponentialRampToValueAtTime(0.001, cursor + dur - 0.02);

          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(cursor);
          osc.stop(cursor + dur);
        }
        cursor += dur;
      }
    }
  } catch (_) {}
}

// ----------------- LOCAL, INDEXEDDB & SERVER STORAGE -----------------

function openTripsIdb() {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    try {
      const req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

async function readTripsFromIdb() {
  const db = await openTripsIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const getReq = store.get(STORAGE_KEY_TRIPS);
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

async function writeTripsToIdb(map) {
  const db = await openTripsIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.put(map, STORAGE_KEY_TRIPS);
  } catch (_) {}
}

function createDefaultSampleTripsMap() {
  const today = new Date().toISOString().split("T")[0];
  const seedIso = "2025-01-01T00:00:00.000Z";
  return {
    "trip-sample-cotswolds": {
      id: "trip-sample-cotswolds",
      name: "Cotswolds Weekend Getaway",
      currency: "£",
      members: ["Anil", "Priya", "Sam", "Maya"],
      expenses: [
        {
          id: "exp-sample-1",
          paid_by: "Anil",
          amount: 180.00,
          description: "Countryside Cottage Deposit",
          category: "Accommodation",
          date: today,
          shared_by: ["Anil", "Priya", "Sam", "Maya"],
          source: "manual",
          receipt_name: null,
          receipt_data_url: null,
          created_at: seedIso
        },
        {
          id: "exp-sample-2",
          paid_by: "Priya",
          amount: 64.80,
          description: "The Swan Country Pub Dinner",
          category: "Food & Drink",
          date: today,
          shared_by: ["Anil", "Priya", "Sam", "Maya"],
          source: "manual",
          receipt_name: "swan_pub_receipt.jpg",
          receipt_data_url: null,
          created_at: seedIso
        },
        {
          id: "exp-sample-3",
          paid_by: "Sam",
          amount: 42.00,
          description: "Fuel & Parking",
          category: "Transport",
          date: today,
          shared_by: ["Anil", "Priya", "Sam"],
          source: "manual",
          receipt_name: null,
          receipt_data_url: null,
          created_at: seedIso
        }
      ],
      payments: [],
      user_modified: false,
      created_at: seedIso,
      updated_at: seedIso
    }
  };
}

function getLocalTripsMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TRIPS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn("Could not read localStorage trips:", e);
  }
  return null;
}

function saveLocalTripsMap(map) {
  if (!map || typeof map !== "object") return;
  // Save full map (including high-res receipt photos) to IndexedDB
  writeTripsToIdb(map);

  // Save to localStorage with automatic fallback if photos exceed 5MB quota
  try {
    localStorage.setItem(STORAGE_KEY_TRIPS, JSON.stringify(map));
  } catch (e) {
    console.warn("localStorage quota exceeded, saving photo-trimmed copy to localStorage:", e);
    try {
      const lightMap = {};
      for (const [tid, t] of Object.entries(map)) {
        lightMap[tid] = {
          ...t,
          expenses: Array.isArray(t.expenses)
            ? t.expenses.map(exp => ({ ...exp, receipt_data_url: null }))
            : []
        };
      }
      localStorage.setItem(STORAGE_KEY_TRIPS, JSON.stringify(lightMap));
    } catch (e2) {
      console.warn("localStorage fallback write failed:", e2);
    }
  }
}

function chooseNewerTrip(localTrip, serverTrip) {
  if (!localTrip) return serverTrip;
  if (!serverTrip) return localTrip;

  // Never let an unmodified server seed trip overwrite a user-modified local trip
  if (localTrip.user_modified && !serverTrip.user_modified) {
    return localTrip;
  }
  if (serverTrip.user_modified && !localTrip.user_modified) {
    return serverTrip;
  }

  const localTime = Date.parse(localTrip.updated_at || "") || 0;
  const serverTime = Date.parse(serverTrip.updated_at || "") || 0;

  if (localTime >= serverTime) {
    return localTrip;
  }
  return serverTrip;
}

async function loadAllTrips() {
  const lsMap = getLocalTripsMap();
  const idbMap = await readTripsFromIdb();

  // Merge localStorage and IndexedDB maps, picking the newer version of each trip
  const mergedLocal = {};
  if (lsMap && typeof lsMap === "object") {
    for (const [tid, t] of Object.entries(lsMap)) {
      mergedLocal[tid] = t;
    }
  }
  if (idbMap && typeof idbMap === "object") {
    for (const [tid, t] of Object.entries(idbMap)) {
      mergedLocal[tid] = chooseNewerTrip(mergedLocal[tid], t);
    }
  }

  allTripsMap = Object.keys(mergedLocal).length > 0 ? mergedLocal : createDefaultSampleTripsMap();

  try {
    const res = await fetch("/api/trips");
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.trips)) {
        const serverIds = new Set();
        for (const sTrip of data.trips) {
          serverIds.add(sTrip.id);
          const fullServerTrip = {
            id: sTrip.id,
            name: sTrip.name,
            currency: sTrip.currency || "£",
            members: Array.isArray(sTrip.members) ? sTrip.members : [],
            expenses: Array.isArray(sTrip.expenses) ? sTrip.expenses : [],
            payments: Array.isArray(sTrip.payments) ? sTrip.payments : [],
            expense_count_hint: sTrip.expense_count,
            total_spent_hint: sTrip.total_spent,
            user_modified: Boolean(sTrip.user_modified),
            created_at: sTrip.created_at,
            updated_at: sTrip.updated_at
          };

          const existingLocal = allTripsMap[sTrip.id];
          const chosen = chooseNewerTrip(existingLocal, fullServerTrip);
          allTripsMap[sTrip.id] = chosen;

          // If our local version is newer than the server's, push it back to the server
          if (existingLocal && chosen === existingLocal && existingLocal.user_modified) {
            fetch(`/api/trips/${encodeURIComponent(sTrip.id)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trip: existingLocal })
            }).catch(() => {});
          }
        }

        // Push any locally created trips that the server doesn't know about yet
        for (const [tid, lTrip] of Object.entries(allTripsMap)) {
          if (!serverIds.has(tid)) {
            fetch(`/api/trips/${encodeURIComponent(tid)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ trip: lTrip })
            }).catch(() => {});
          }
        }
      }
    }
  } catch (_) {}

  saveLocalTripsMap(allTripsMap);
  renderHomeTripsList();
}

async function syncTripToServer(tripObj) {
  tripObj.updated_at = new Date().toISOString();
  tripObj.user_modified = true;
  allTripsMap[tripObj.id] = tripObj;
  saveLocalTripsMap(allTripsMap);
  try {
    await fetch(`/api/trips/${encodeURIComponent(tripObj.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trip: tripObj })
    });
  } catch (_) {}
}

// ----------------- DRAFT TRIP FORM PERSISTENCE -----------------

function saveDraftTripState() {
  try {
    const nameInput = document.getElementById("tripNameInput");
    const currencyInput = document.getElementById("tripCurrencyInput");
    const memberInput = document.getElementById("memberNameInput");
    const draftPayload = {
      name: nameInput ? nameInput.value : "",
      currency: currencyInput ? currencyInput.value : "£",
      pendingMemberText: memberInput ? memberInput.value : "",
      members: Array.isArray(draftMembers) ? draftMembers : []
    };
    localStorage.setItem(STORAGE_KEY_DRAFT_TRIP, JSON.stringify(draftPayload));
  } catch (_) {}
}

function restoreDraftTripState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_DRAFT_TRIP);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    const nameInput = document.getElementById("tripNameInput");
    const currencyInput = document.getElementById("tripCurrencyInput");
    const memberInput = document.getElementById("memberNameInput");

    if (nameInput && typeof parsed.name === "string") {
      nameInput.value = parsed.name;
    }
    if (currencyInput && typeof parsed.currency === "string" && parsed.currency) {
      currencyInput.value = parsed.currency;
    }
    if (memberInput && typeof parsed.pendingMemberText === "string") {
      memberInput.value = parsed.pendingMemberText;
    }
    if (Array.isArray(parsed.members)) {
      draftMembers = parsed.members;
    }
  } catch (_) {}
}

function bindDraftFormPersistence() {
  ["tripNameInput", "tripCurrencyInput", "memberNameInput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", saveDraftTripState);
      el.addEventListener("change", saveDraftTripState);
    }
  });
}

// ----------------- 1. CREATE A TRIP & HOME PAGE LIST -----------------

function handleMemberInputKeydown(event) {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    addDraftMemberFromInput();
  }
}

function addDraftMemberFromInput() {
  const input = document.getElementById("memberNameInput");
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;

  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  let added = 0;
  for (const part of parts) {
    const exists = draftMembers.some(m => m.toLowerCase() === part.toLowerCase());
    if (!exists) {
      draftMembers.push(part);
      added++;
    }
  }
  input.value = "";
  saveDraftTripState();
  if (added > 0) {
    renderDraftMembers();
  }
}

function removeDraftMember(index) {
  draftMembers.splice(index, 1);
  saveDraftTripState();
  renderDraftMembers();
}

function renderDraftMembers() {
  const container = document.getElementById("draftMembersList");
  if (!container) return;

  if (draftMembers.length === 0) {
    container.innerHTML = `<span class="text-xs text-slate-400 italic">No names added yet — type everyone's names above.</span>`;
    return;
  }

  container.innerHTML = draftMembers.map((name, idx) => `
    <span class="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">
      <i class="ph-bold ph-user text-indigo-600"></i>
      <span>${escapeHtml(name)}</span>
      <button type="button" onclick="removeDraftMember(${idx})" class="text-indigo-500 hover:text-rose-600 ml-1 cursor-pointer" title="Remove ${escapeHtml(name)}">
        <i class="ph-bold ph-x"></i>
      </button>
    </span>
  `).join("");
}

async function handleCreateTrip(event) {
  event.preventDefault();

  addDraftMemberFromInput();

  const nameInput = document.getElementById("tripNameInput");
  const currencyInput = document.getElementById("tripCurrencyInput");

  const tripName = (nameInput.value || "").trim();
  if (!tripName) {
    showToast("Please enter a name for the trip.", "error");
    return;
  }

  if (draftMembers.length === 0) {
    showToast("Please add at least one person's name to the trip.", "error");
    return;
  }

  const currencyValue = (currencyInput.value || "£").trim() || "£";
  const newTripId = "trip-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  const nowIso = new Date().toISOString();

  let createdTrip = {
    id: newTripId,
    name: tripName,
    currency: currencyValue,
    members: [...draftMembers],
    expenses: [],
    payments: [],
    user_modified: true,
    created_at: nowIso,
    updated_at: nowIso
  };

  try {
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: newTripId,
        name: tripName,
        members: draftMembers,
        currency: currencyValue
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.trip) {
        createdTrip = { ...data.trip, user_modified: true };
      }
    }
  } catch (_) {}

  allTripsMap[createdTrip.id] = createdTrip;
  saveLocalTripsMap(allTripsMap);

  nameInput.value = "";
  draftMembers = [];
  saveDraftTripState();
  renderDraftMembers();
  renderHomeTripsList();

  // Open the newly created trip immediately and play 20s "Yeh Dosti" song!
  await openTrip(createdTrip.id);
  playYehDostiMusic();
  showToast(`Trip "${createdTrip.name}" created & saved! Playing "Yeh Dosti" (20s)!`, "success");
}

function renderHomeTripsList() {
  const container = document.getElementById("tripsListContainer");
  const badge = document.getElementById("homeTripsCountBadge");
  if (!container) return;

  const tripsList = Object.values(allTripsMap).sort((a, b) => {
    return (b.updated_at || "").localeCompare(a.updated_at || "");
  });

  if (badge) badge.textContent = String(tripsList.length);

  if (tripsList.length === 0) {
    container.innerHTML = `
      <div class="col-span-full bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-2">
        <div class="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-2xl mx-auto">
          <i class="ph-bold ph-suitcase-rolling"></i>
        </div>
        <h3 class="text-sm font-bold text-slate-800">No trips created yet</h3>
        <p class="text-xs text-slate-500">Use the "Create a Trip" form on the left to start your first group trip.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = tripsList.map(trip => {
    const expenses = Array.isArray(trip.expenses) ? trip.expenses : [];
    const expCount = expenses.length || trip.expense_count_hint || 0;
    const totalSpent = expenses.length > 0
      ? expenses.reduce((acc, e) => acc + (Number(e.amount) || 0), 0)
      : (Number(trip.total_spent_hint) || 0);
    const cur = trip.currency || "£";
    const members = Array.isArray(trip.members) ? trip.members : [];

    return `
      <div
        onclick="openTrip('${escapeAttr(trip.id)}')"
        class="group bg-white hover:bg-indigo-50/30 rounded-2xl border border-slate-200 hover:border-indigo-400 p-5 card-shadow transition cursor-pointer flex flex-col justify-between space-y-4"
      >
        <div class="space-y-2.5">
          <div class="flex items-start justify-between gap-2">
            <h3 class="text-base font-extrabold text-slate-900 group-hover:text-indigo-700 transition">
              ${escapeHtml(trip.name)}
            </h3>
            <span class="inline-flex items-center space-x-1 text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 shrink-0">
              <i class="ph-bold ph-users"></i>
              <span>${members.length}</span>
            </span>
          </div>

          <div class="flex flex-wrap gap-1.5">
            ${members.map(m => `
              <span class="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                ${escapeHtml(m)}
              </span>
            `).join("")}
          </div>
        </div>

        <div class="pt-3 border-t border-slate-100 flex items-center justify-between">
          <div class="text-xs text-slate-500">
            <span class="font-bold text-slate-800">${cur}${totalSpent.toFixed(2)}</span>
            <span> across ${expCount} expense${expCount === 1 ? "" : "s"}</span>
          </div>
          <span class="inline-flex items-center space-x-1 text-xs font-bold text-indigo-600 group-hover:translate-x-0.5 transition">
            <span>Open Trip</span>
            <i class="ph-bold ph-arrow-right"></i>
          </span>
        </div>
      </div>
    `;
  }).join("");
}

// ----------------- 2. OPEN A TRIP DIRECTLY -----------------

async function openTrip(tripId) {
  let localTrip = allTripsMap[tripId];

  try {
    const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.trip) {
        const chosen = chooseNewerTrip(localTrip, data.trip);
        allTripsMap[tripId] = chosen;
        saveLocalTripsMap(allTripsMap);

        if (localTrip && chosen === localTrip && localTrip.user_modified) {
          fetch(`/api/trips/${encodeURIComponent(tripId)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trip: localTrip })
          }).catch(() => {});
        }
      }
    }
  } catch (_) {}

  const tripObj = allTripsMap[tripId];
  if (!tripObj) return;

  activeTrip = tripObj;
  try {
    localStorage.setItem(STORAGE_KEY_ACTIVE_TRIP, tripId);
  } catch (_) {}

  document.getElementById("homeView").classList.add("hidden");
  document.getElementById("tripView").classList.remove("hidden");
  document.getElementById("headerBackHomeBtn").classList.remove("hidden");
  document.getElementById("headerExportCsvBtn").classList.remove("hidden");

  populateTripMemberControls();
  renderActiveTripDashboard();
}

function goHome() {
  activeTrip = null;
  try {
    localStorage.removeItem(STORAGE_KEY_ACTIVE_TRIP);
  } catch (_) {}
  document.getElementById("tripView").classList.add("hidden");
  document.getElementById("homeView").classList.remove("hidden");
  document.getElementById("headerBackHomeBtn").classList.add("hidden");
  document.getElementById("headerExportCsvBtn").classList.add("hidden");
  renderHomeTripsList();
}

// ----------------- 3. ADD / REMOVE / UPDATE PEOPLE IN GROUP AFTER TRIP CREATED -----------------

function openManageMembersModal() {
  if (!activeTrip) return;
  const input = document.getElementById("newTripMemberInput");
  if (input) input.value = "";
  renderManageMembersList();
  document.getElementById("manageMembersModal").classList.remove("hidden");
}

function closeManageMembersModal() {
  document.getElementById("manageMembersModal").classList.add("hidden");
}

function renderManageMembersList() {
  if (!activeTrip) return;
  const container = document.getElementById("manageMembersListContainer");
  if (!container) return;

  const members = Array.isArray(activeTrip.members) ? activeTrip.members : [];

  container.innerHTML = members.map((memberName, idx) => `
    <div class="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200">
      <div class="flex items-center space-x-2 flex-1">
        <i class="ph-bold ph-user text-indigo-600 text-sm shrink-0"></i>
        <input
          id="editMemberInput_${idx}"
          type="text"
          value="${escapeAttr(memberName)}"
          onkeydown="if(event.key==='Enter'){event.preventDefault(); saveRenamedMember(${idx});}"
          class="w-full px-2.5 py-1.5 rounded-lg bg-white border border-slate-300 text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
      </div>

      <div class="flex items-center space-x-1.5 shrink-0">
        <button
          type="button"
          onclick="saveRenamedMember(${idx})"
          class="px-2.5 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-bold text-[11px] transition cursor-pointer"
          title="Save updated name"
        >
          Update
        </button>
        <button
          type="button"
          onclick="removeMemberFromActiveTrip(${idx})"
          class="px-2.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 font-bold text-[11px] transition flex items-center space-x-1 cursor-pointer"
          title="Remove person from group"
        >
          <i class="ph-bold ph-trash"></i>
          <span>Remove</span>
        </button>
      </div>
    </div>
  `).join("");
}

async function handleAddMemberToActiveTrip(event) {
  event.preventDefault();
  if (!activeTrip) return;

  const input = document.getElementById("newTripMemberInput");
  if (!input) return;
  const raw = (input.value || "").trim();
  if (!raw) return;

  if (!Array.isArray(activeTrip.members)) activeTrip.members = [];

  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  const addedNames = [];

  for (const part of parts) {
    const exists = activeTrip.members.some(m => m.toLowerCase() === part.toLowerCase());
    if (!exists) {
      activeTrip.members.push(part);
      addedNames.push(part);
    }
  }

  if (addedNames.length === 0) {
    showToast("That person is already in the group.", "error");
    return;
  }

  input.value = "";
  await syncTripToServer(activeTrip);
  renderManageMembersList();
  populateTripMemberControls();
  renderActiveTripDashboard();

  showToast(`Added ${addedNames.join(", ")} to "${activeTrip.name}"!`, "success");
}

async function saveRenamedMember(index) {
  if (!activeTrip || !Array.isArray(activeTrip.members)) return;
  const oldName = activeTrip.members[index];
  if (!oldName) return;

  const input = document.getElementById(`editMemberInput_${index}`);
  if (!input) return;
  const newName = (input.value || "").trim();

  if (!newName) {
    showToast("Name cannot be empty.", "error");
    input.value = oldName;
    return;
  }

  if (newName === oldName) {
    showToast(`Name "${newName}" is unchanged.`, "info");
    return;
  }

  const duplicate = activeTrip.members.some((m, idx) => idx !== index && m.toLowerCase() === newName.toLowerCase());
  if (duplicate) {
    showToast(`"${newName}" is already in this trip.`, "error");
    input.value = oldName;
    return;
  }

  // 1. Update in members array
  activeTrip.members[index] = newName;

  // 2. Cascade rename across all expenses (paid_by and shared_by)
  if (Array.isArray(activeTrip.expenses)) {
    for (const exp of activeTrip.expenses) {
      if (exp.paid_by === oldName) {
        exp.paid_by = newName;
      }
      if (Array.isArray(exp.shared_by)) {
        exp.shared_by = exp.shared_by.map(m => (m === oldName ? newName : m));
      }
    }
  }

  // 3. Cascade rename across all recorded payments (from and to)
  if (Array.isArray(activeTrip.payments)) {
    for (const pay of activeTrip.payments) {
      if (pay.from === oldName) pay.from = newName;
      if (pay.to === oldName) pay.to = newName;
    }
  }

  await syncTripToServer(activeTrip);
  renderManageMembersList();
  populateTripMemberControls();
  renderActiveTripDashboard();

  showToast(`Updated "${oldName}" to "${newName}" across the trip and all expenses!`, "success");
}

async function removeMemberFromActiveTrip(index) {
  if (!activeTrip || !Array.isArray(activeTrip.members)) return;
  if (activeTrip.members.length <= 1) {
    showToast("A trip must have at least one person in the group.", "error");
    return;
  }

  const targetName = activeTrip.members[index];
  if (!targetName) return;

  // Remove from members list
  activeTrip.members.splice(index, 1);
  const remainingMembers = [...activeTrip.members];

  // Cleanly update expenses so balances remain 100% consistent
  if (Array.isArray(activeTrip.expenses)) {
    // Remove expenses paid by the removed member OR remove them from shared_by
    activeTrip.expenses = activeTrip.expenses.filter(exp => exp.paid_by !== targetName);
    for (const exp of activeTrip.expenses) {
      if (Array.isArray(exp.shared_by)) {
        exp.shared_by = exp.shared_by.filter(m => m !== targetName);
        if (exp.shared_by.length === 0) {
          exp.shared_by = [...remainingMembers];
        }
      }
    }
  }

  // Remove any recorded payments involving the removed person
  if (Array.isArray(activeTrip.payments)) {
    activeTrip.payments = activeTrip.payments.filter(
      p => p.from !== targetName && p.to !== targetName
    );
  }

  await syncTripToServer(activeTrip);
  renderManageMembersList();
  populateTripMemberControls();
  renderActiveTripDashboard();

  showToast(`Removed "${targetName}" from the group and recalculated splits.`, "info");
}

// ----------------- 4. CAMERA SNAPSHOT MODAL (FOR MANUAL BILL OR AI SCAN) -----------------

async function openCameraModal(targetMode = "manual") {
  cameraTargetMode = targetMode;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    triggerFallbackCameraInput(targetMode);
    return;
  }

  const modal = document.getElementById("cameraModal");
  const errEl = document.getElementById("cameraErrorMsg");
  if (errEl) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
  }
  if (modal) modal.classList.remove("hidden");

  await startCameraStream();
}

async function startCameraStream() {
  stopCameraStream();
  const video = document.getElementById("cameraVideoStream");

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: cameraFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 960 }
      },
      audio: false
    });
    if (video) {
      video.srcObject = cameraStream;
      video.classList.remove("hidden");
      await video.play();
    }
  } catch (err) {
    console.warn("Webcam stream unavailable, falling back to file/camera input:", err);
    closeCameraModal();
    triggerFallbackCameraInput(cameraTargetMode);
  }
}

function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  const video = document.getElementById("cameraVideoStream");
  if (video) video.srcObject = null;
}

function closeCameraModal() {
  stopCameraStream();
  const modal = document.getElementById("cameraModal");
  if (modal) modal.classList.add("hidden");
}

async function switchCameraFacingMode() {
  cameraFacingMode = cameraFacingMode === "environment" ? "user" : "environment";
  await startCameraStream();
}

function triggerFallbackCameraInput(targetMode) {
  const inputId = targetMode === "scan" ? "scanCameraFallbackInput" : "manualCameraFallbackInput";
  const input = document.getElementById(inputId);
  if (input) input.click();
}

async function captureBillSnapshot() {
  const video = document.getElementById("cameraVideoStream");
  if (!video || !video.videoWidth) {
    closeCameraModal();
    triggerFallbackCameraInput(cameraTargetMode);
    return;
  }

  const maxDim = 1100;
  let width = video.videoWidth;
  let height = video.videoHeight;
  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.round((height * maxDim) / width);
      width = maxDim;
    } else {
      width = Math.round((width * maxDim) / height);
      height = maxDim;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, width, height);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `bill_snapshot_${stamp}.jpg`;

  closeCameraModal();

  if (cameraTargetMode === "manual") {
    manualPhotoDataUrl = dataUrl;
    manualPhotoName = filename;
    document.getElementById("manualPhotoPreviewImg").src = manualPhotoDataUrl;
    document.getElementById("manualPhotoPreviewName").textContent = filename;
    document.getElementById("manualPhotoPreviewBox").classList.remove("hidden");
    document.getElementById("manualBillPhotoLabel").textContent = "Change Photo";
    showToast("Bill snapshot captured and attached!", "success");
  } else {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const fileObj = new File([blob], filename, { type: "image/jpeg" });
    selectedScanFiles.push(fileObj);
    renderScanFilesQueue();
    showToast("Bill snapshot captured! Click 'Scan & Split Between Everyone' or take another snapshot.", "success");
  }
}

// ----------------- 5. ADD AN EXPENSE BY HAND -----------------

function switchExpenseTab(mode) {
  const manualForm = document.getElementById("manualExpenseForm");
  const scanForm = document.getElementById("scanReceiptsForm");
  const btnManual = document.getElementById("tabBtnManual");
  const btnScan = document.getElementById("tabBtnScan");

  if (mode === "scan") {
    manualForm.classList.add("hidden");
    scanForm.classList.remove("hidden");
    btnScan.className = "py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center space-x-2 transition bg-white text-violet-700 shadow-xs border border-slate-200 cursor-pointer";
    btnManual.className = "py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center space-x-2 transition text-slate-600 hover:text-slate-900 cursor-pointer";
  } else {
    scanForm.classList.add("hidden");
    manualForm.classList.remove("hidden");
    btnManual.className = "py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center space-x-2 transition bg-white text-indigo-700 shadow-xs border border-slate-200 cursor-pointer";
    btnScan.className = "py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center space-x-2 transition text-slate-600 hover:text-slate-900 cursor-pointer";
  }
}

function populateTripMemberControls() {
  if (!activeTrip) return;
  const members = activeTrip.members || [];
  const cur = activeTrip.currency || "£";

  document.querySelectorAll(".currencySymbolLabel").forEach(el => {
    el.textContent = cur;
  });

  const manualPaidBy = document.getElementById("manualPaidBy");
  const scanPaidBy = document.getElementById("scanPaidBy");

  const optionsHtml = members.map(m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join("");
  if (manualPaidBy) manualPaidBy.innerHTML = optionsHtml;
  if (scanPaidBy) scanPaidBy.innerHTML = optionsHtml;

  const checkboxesContainer = document.getElementById("manualSharedCheckboxes");
  if (checkboxesContainer) {
    checkboxesContainer.innerHTML = members.map(m => `
      <label class="flex items-center space-x-2.5 p-2 rounded-lg bg-white border border-slate-200 hover:border-indigo-300 cursor-pointer transition select-none">
        <input
          type="checkbox"
          name="manualSharedMember"
          value="${escapeAttr(m)}"
          checked
          onchange="updateManualSplitPreview()"
          class="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
        >
        <span class="text-xs font-bold text-slate-800 truncate">${escapeHtml(m)}</span>
      </label>
    `).join("");
  }

  updateManualSplitPreview();
}

function toggleAllManualShared(checked) {
  document.querySelectorAll('input[name="manualSharedMember"]').forEach(cb => {
    cb.checked = checked;
  });
  updateManualSplitPreview();
}

function getCheckedManualSharedMembers() {
  const checked = [];
  document.querySelectorAll('input[name="manualSharedMember"]:checked').forEach(cb => {
    checked.push(cb.value);
  });
  return checked;
}

function updateManualSplitPreview() {
  if (!activeTrip) return;
  const previewEl = document.getElementById("manualSplitPreview");
  const amtInput = document.getElementById("manualAmount");
  if (!previewEl || !amtInput) return;

  const amt = parseFloat(amtInput.value) || 0;
  const checked = getCheckedManualSharedMembers();
  const cur = activeTrip.currency || "£";

  if (checked.length === 0) {
    previewEl.textContent = "Please tick at least one person who shared this expense.";
    previewEl.className = "text-xs text-rose-600 font-semibold mt-1.5";
    return;
  }

  const perPerson = amt / checked.length;
  previewEl.className = "text-xs text-indigo-600 font-semibold mt-1.5";
  previewEl.textContent = amt > 0
    ? `Split equally between ${checked.length} ${checked.length === 1 ? "person" : "people"}: ${cur}${perPerson.toFixed(2)} each`
    : `Ticked: ${checked.join(", ")}`;
}

async function handleManualPhotoChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    manualPhotoDataUrl = await readAndCompressImage(file, 900, 0.78);
    manualPhotoName = file.name;
    document.getElementById("manualPhotoPreviewImg").src = manualPhotoDataUrl;
    document.getElementById("manualPhotoPreviewName").textContent = file.name;
    document.getElementById("manualPhotoPreviewBox").classList.remove("hidden");
    document.getElementById("manualBillPhotoLabel").textContent = "Change Photo";
  } catch (err) {
    console.warn("Failed reading photo:", err);
  }
}

function clearManualPhoto() {
  manualPhotoDataUrl = null;
  manualPhotoName = null;
  const fileInput = document.getElementById("manualBillPhoto");
  if (fileInput) fileInput.value = "";
  const camInput = document.getElementById("manualCameraFallbackInput");
  if (camInput) camInput.value = "";
  const previewBox = document.getElementById("manualPhotoPreviewBox");
  if (previewBox) previewBox.classList.add("hidden");
  const label = document.getElementById("manualBillPhotoLabel");
  if (label) label.textContent = "Upload Photo";
}

async function handleAddManualExpense(event) {
  event.preventDefault();
  if (!activeTrip) return;

  const paidBy = document.getElementById("manualPaidBy").value;
  const amountVal = parseFloat(document.getElementById("manualAmount").value);
  const category = document.getElementById("manualCategory").value || "Other";
  const dateVal = document.getElementById("manualDate").value || new Date().toISOString().split("T")[0];
  const descInput = document.getElementById("manualDescription");
  const description = (descInput.value || "").trim() || category;
  const sharedBy = getCheckedManualSharedMembers();

  if (!paidBy) {
    showToast("Please select who paid.", "error");
    return;
  }
  if (!amountVal || amountVal <= 0) {
    showToast("Please enter a valid expense amount.", "error");
    return;
  }
  if (sharedBy.length === 0) {
    showToast("Please tick at least one person who shared this expense.", "error");
    return;
  }

  const newExpense = {
    id: "exp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    paid_by: paidBy,
    amount: Math.round(amountVal * 100) / 100,
    description: description,
    category: category,
    date: dateVal,
    shared_by: sharedBy,
    source: "manual",
    receipt_name: manualPhotoName || null,
    receipt_data_url: manualPhotoDataUrl || null,
    created_at: new Date().toISOString()
  };

  if (!Array.isArray(activeTrip.expenses)) activeTrip.expenses = [];
  activeTrip.expenses.unshift(newExpense);

  await syncTripToServer(activeTrip);

  document.getElementById("manualAmount").value = "";
  descInput.value = "";
  toggleAllManualShared(true);
  clearManualPhoto();
  renderActiveTripDashboard();

  const cur = activeTrip.currency || "£";
  showToast(`Added "${newExpense.description}" (${cur}${newExpense.amount.toFixed(2)}) paid by ${newExpense.paid_by}.`, "success");
}

// ----------------- 6. SCAN RECEIPTS WITH AI (SNAPSHOT, PHOTOS OR PDFS) -----------------

function handleScanFilesSelected(event) {
  const incoming = Array.from(event.target.files || []);
  if (incoming.length > 0) {
    selectedScanFiles.push(...incoming);
    renderScanFilesQueue();
  }
  event.target.value = "";
}

function removeScanFileAt(idx) {
  selectedScanFiles.splice(idx, 1);
  renderScanFilesQueue();
}

function renderScanFilesQueue() {
  const listEl = document.getElementById("scanFilesList");
  if (!listEl) return;

  if (selectedScanFiles.length === 0) {
    listEl.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  listEl.classList.remove("hidden");
  listEl.innerHTML = selectedScanFiles.map((file, idx) => {
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isSnapshot = file.name.startsWith("bill_snapshot_");
    const icon = isPdf
      ? "ph-file-pdf text-rose-600"
      : (isSnapshot ? "ph-camera text-indigo-600" : "ph-image text-violet-600");
    const sizeKb = Math.max(1, Math.round(file.size / 1024));
    return `
      <div class="flex items-center justify-between px-3 py-2 rounded-lg bg-white border border-slate-200 text-xs">
        <div class="flex items-center space-x-2 overflow-hidden">
          <i class="ph-bold ${icon} text-base shrink-0"></i>
          <span class="font-semibold text-slate-700 truncate">${escapeHtml(file.name)}</span>
          <span class="text-slate-400 shrink-0">(${sizeKb} KB)</span>
        </div>
        <button type="button" onclick="removeScanFileAt(${idx})" class="text-slate-400 hover:text-rose-600 ml-2 cursor-pointer">
          <i class="ph-bold ph-x"></i>
        </button>
      </div>
    `;
  }).join("");
}

async function handleScanReceipts(event) {
  event.preventDefault();
  if (!activeTrip) return;

  const paidBy = document.getElementById("scanPaidBy").value;
  if (!paidBy) {
    showToast("Please choose who paid for the receipts.", "error");
    return;
  }
  if (selectedScanFiles.length === 0) {
    showToast("Please take a snapshot or upload at least one receipt photo or PDF to scan.", "error");
    return;
  }

  const submitBtn = document.getElementById("scanSubmitBtn");
  const submitBtnText = document.getElementById("scanSubmitBtnText");
  submitBtn.disabled = true;
  submitBtn.classList.add("opacity-75");
  submitBtnText.textContent = `AI Scanning ${selectedScanFiles.length} file(s)...`;

  try {
    const previewMap = {};
    const filesPayload = [];
    for (const f of selectedScanFiles) {
      if (f.type.startsWith("image/")) {
        try {
          previewMap[f.name] = await readAndCompressImage(f, 900, 0.75);
        } catch (_) {}
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      filesPayload.push({
        name: f.name,
        mime_type: f.type || (f.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg"),
        data_base64: dataUrl
      });
    }

    const headers = { "Content-Type": "application/json" };
    const savedKey = localStorage.getItem(STORAGE_KEY_GEMINI);
    if (savedKey) headers["x-gemini-key"] = savedKey;

    let scannedReceipts = [];
    let statusMessage = "";

    try {
      const res = await fetch("/api/scan-receipts-json", {
        method: "POST",
        headers,
        body: JSON.stringify({
          paid_by: paidBy,
          files: filesPayload
        })
      });
      if (res.ok) {
        const data = await res.json();
        scannedReceipts = data.receipts || [];
        statusMessage = data.message || "";
      } else {
        throw new Error("Server scan endpoint returned status " + res.status);
      }
    } catch (_) {
      scannedReceipts = await clientFallbackScanReceipts(selectedScanFiles);
      statusMessage = `Scanned ${scannedReceipts.length} receipt(s) and split each between everyone!`;
    }

    if (!Array.isArray(activeTrip.expenses)) activeTrip.expenses = [];
    const everyone = [...(activeTrip.members || [])];

    for (const item of scannedReceipts) {
      const exp = {
        id: "exp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
        paid_by: paidBy,
        amount: Math.round((Number(item.amount) || 15.00) * 100) / 100,
        description: item.description || "Scanned Receipt",
        category: CATEGORY_META[item.category] ? item.category : "Food & Drink",
        date: item.date || new Date().toISOString().split("T")[0],
        shared_by: everyone,
        source: "scanned",
        receipt_name: item.source_file || null,
        receipt_data_url: (item.source_file && previewMap[item.source_file]) ? previewMap[item.source_file] : null,
        created_at: new Date().toISOString()
      };
      activeTrip.expenses.unshift(exp);
    }

    await syncTripToServer(activeTrip);

    selectedScanFiles = [];
    const scanInput = document.getElementById("scanFilesInput");
    if (scanInput) scanInput.value = "";
    renderScanFilesQueue();
    renderActiveTripDashboard();

    showToast(statusMessage || `Added ${scannedReceipts.length} scanned receipt(s) split between everyone!`, "success");
  } catch (err) {
    showToast("Error scanning receipts: " + (err.message || err), "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.classList.remove("opacity-75");
    submitBtnText.textContent = "Scan & Split Between Everyone";
  }
}

async function clientFallbackScanReceipts(files) {
  const today = new Date().toISOString().split("T")[0];
  const results = [];
  for (const f of files) {
    const stem = f.name.replace(/\.[^/.]+$/, "").replace(/[_\-]+/g, " ").trim();
    const numMatch = stem.match(/(\d{1,4}(?:\.\d{2}))/);
    const amount = numMatch ? parseFloat(numMatch[1]) : Math.round(((f.size % 6500) / 100 + 14.5) * 100) / 100;
    const lower = stem.toLowerCase();
    let category = "Food & Drink";
    if (/uber|taxi|train|flight|fuel|petrol|parking|bus/.test(lower)) category = "Transport";
    else if (/hotel|airbnb|stay|cottage|hostel|lodge/.test(lower)) category = "Accommodation";
    else if (/tesco|sainsbury|asda|waitrose|aldi|lidl|grocer|market/.test(lower)) category = "Groceries";
    else if (/ticket|museum|tour|cinema|activity/.test(lower)) category = "Activities";
    results.push({
      description: stem ? stem.replace(/\b\w/g, c => c.toUpperCase()) : "Scanned Receipt",
      amount,
      category,
      date: today,
      source_file: f.name
    });
  }
  return results;
}

// ----------------- DELETE EXPENSE (OR DELETE & RE-ADD BY HAND) -----------------

async function deleteExpense(expenseId, prefillManual = false) {
  if (!activeTrip || !Array.isArray(activeTrip.expenses)) return;
  const idx = activeTrip.expenses.findIndex(e => e.id === expenseId);
  if (idx === -1) return;

  const removed = activeTrip.expenses[idx];
  activeTrip.expenses.splice(idx, 1);

  await syncTripToServer(activeTrip);
  renderActiveTripDashboard();

  if (prefillManual) {
    switchExpenseTab("manual");
    document.getElementById("manualPaidBy").value = removed.paid_by;
    document.getElementById("manualAmount").value = removed.amount;
    document.getElementById("manualCategory").value = CATEGORY_META[removed.category] ? removed.category : "Other";
    document.getElementById("manualDate").value = removed.date || new Date().toISOString().split("T")[0];
    document.getElementById("manualDescription").value = removed.description || "";
    if (removed.receipt_data_url) {
      manualPhotoDataUrl = removed.receipt_data_url;
      manualPhotoName = removed.receipt_name || "bill_photo.jpg";
      document.getElementById("manualPhotoPreviewImg").src = manualPhotoDataUrl;
      document.getElementById("manualPhotoPreviewName").textContent = manualPhotoName;
      document.getElementById("manualPhotoPreviewBox").classList.remove("hidden");
    }
    updateManualSplitPreview();
    showToast(`Deleted scanned bill "${removed.description}" and pre-filled it in Add by Hand so you can tick who shared it!`, "info");
  } else {
    showToast(`Deleted expense "${removed.description}".`, "info");
  }
}

// ----------------- 7. WHO PAYS WHOM (FEWEST PAYMENTS + MARK PAID + UNDO) -----------------

function calculateSettlementPlan(trip) {
  const members = Array.isArray(trip.members) ? trip.members : [];
  const expenses = Array.isArray(trip.expenses) ? trip.expenses : [];
  const payments = Array.isArray(trip.payments) ? trip.payments : [];

  const netFloat = {};
  for (const m of members) netFloat[m] = 0;

  for (const exp of expenses) {
    const amt = Number(exp.amount) || 0;
    if (amt <= 0) continue;
    const payer = exp.paid_by;
    const sharedBy = (Array.isArray(exp.shared_by) && exp.shared_by.length > 0)
      ? exp.shared_by
      : members;
    if (sharedBy.length === 0) continue;

    const splitAmt = amt / sharedBy.length;
    if (netFloat[payer] === undefined) netFloat[payer] = 0;
    netFloat[payer] += amt;

    for (const beneficiary of sharedBy) {
      if (netFloat[beneficiary] === undefined) netFloat[beneficiary] = 0;
      netFloat[beneficiary] -= splitAmt;
    }
  }

  for (const pay of payments) {
    const pAmt = Number(pay.amount) || 0;
    if (pAmt <= 0) continue;
    if (netFloat[pay.from] === undefined) netFloat[pay.from] = 0;
    if (netFloat[pay.to] === undefined) netFloat[pay.to] = 0;
    netFloat[pay.from] += pAmt;
    netFloat[pay.to] -= pAmt;
  }

  const netCents = {};
  let sumCents = 0;
  let maxPerson = members[0] || null;

  for (const m of Object.keys(netFloat)) {
    const c = Math.round(netFloat[m] * 100);
    netCents[m] = c;
    sumCents += c;
    if (!maxPerson || Math.abs(c) > Math.abs(netCents[maxPerson] || 0)) {
      maxPerson = m;
    }
  }
  if (maxPerson && sumCents !== 0 && Math.abs(sumCents) <= members.length) {
    netCents[maxPerson] -= sumCents;
  }

  const debtors = [];
  const creditors = [];
  for (const [person, cents] of Object.entries(netCents)) {
    if (cents < -1) debtors.push({ person, cents: -cents });
    else if (cents > 1) creditors.push({ person, cents });
  }

  debtors.sort((a, b) => b.cents - a.cents);
  creditors.sort((a, b) => b.cents - a.cents);

  function solveMinTransactions(debList, credList) {
    const dFiltered = debList.filter(d => d.cents > 1).sort((a, b) => b.cents - a.cents);
    const cFiltered = credList.filter(c => c.cents > 1).sort((a, b) => b.cents - a.cents);

    if (dFiltered.length === 0 || cFiltered.length === 0) return [];

    for (let i = 0; i < dFiltered.length; i++) {
      for (let j = 0; j < cFiltered.length; j++) {
        if (dFiltered[i].cents === cFiltered[j].cents) {
          const matchedAmt = dFiltered[i].cents;
          const nextD = dFiltered.map((x, idx) => idx === i ? { ...x, cents: 0 } : { ...x });
          const nextC = cFiltered.map((x, idx) => idx === j ? { ...x, cents: 0 } : { ...x });
          return [
            { from: dFiltered[i].person, to: cFiltered[j].person, cents: matchedAmt },
            ...solveMinTransactions(nextD, nextC)
          ];
        }
      }
    }

    const firstDebtor = dFiltered[0];
    if (dFiltered.length + cFiltered.length <= 12) {
      let bestSolution = null;
      for (let j = 0; j < cFiltered.length; j++) {
        const cred = cFiltered[j];
        const transfer = Math.min(firstDebtor.cents, cred.cents);
        const nextD = dFiltered.map((x, idx) => idx === 0 ? { ...x, cents: x.cents - transfer } : { ...x });
        const nextC = cFiltered.map((x, idx) => idx === j ? { ...x, cents: x.cents - transfer } : { ...x });

        const subResult = solveMinTransactions(nextD, nextC);
        const candidate = [{ from: firstDebtor.person, to: cred.person, cents: transfer }, ...subResult];
        if (!bestSolution || candidate.length < bestSolution.length) {
          bestSolution = candidate;
        }
      }
      return bestSolution || [];
    }

    const cred = cFiltered[0];
    const transfer = Math.min(firstDebtor.cents, cred.cents);
    const nextD = dFiltered.map((x, idx) => idx === 0 ? { ...x, cents: x.cents - transfer } : { ...x });
    const nextC = cFiltered.map((x, idx) => idx === 0 ? { ...x, cents: x.cents - transfer } : { ...x });
    return [
      { from: firstDebtor.person, to: cred.person, cents: transfer },
      ...solveMinTransactions(nextD, nextC)
    ];
  }

  const rawTransactions = solveMinTransactions(debtors, creditors);
  const settlements = rawTransactions.map(t => ({
    from: t.from,
    to: t.to,
    amount: Math.round(t.cents) / 100
  }));

  const memberBalances = members.map(m => ({
    person: m,
    balance: Math.round(netCents[m] || 0) / 100
  }));

  return { memberBalances, settlements };
}

async function markSettlementPaid(fromPerson, toPerson, amount) {
  if (!activeTrip) return;
  if (!Array.isArray(activeTrip.payments)) activeTrip.payments = [];

  const paymentRecord = {
    id: "pay-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
    from: fromPerson,
    to: toPerson,
    amount: Math.round(Number(amount) * 100) / 100,
    paid_at: new Date().toISOString()
  };

  activeTrip.payments.unshift(paymentRecord);
  await syncTripToServer(activeTrip);
  renderActiveTripDashboard();

  const cur = activeTrip.currency || "£";
  showToast(`Marked ${fromPerson} → ${toPerson} (${cur}${paymentRecord.amount.toFixed(2)}) as paid! Moved to Payments List.`, "success");
}

async function undoPayment(paymentId) {
  if (!activeTrip || !Array.isArray(activeTrip.payments)) return;
  const idx = activeTrip.payments.findIndex(p => p.id === paymentId);
  if (idx === -1) return;

  const undone = activeTrip.payments[idx];
  activeTrip.payments.splice(idx, 1);

  await syncTripToServer(activeTrip);
  renderActiveTripDashboard();

  const cur = activeTrip.currency || "£";
  showToast(`Undid payment of ${cur}${Number(undone.amount).toFixed(2)} from ${undone.from} to ${undone.to}.`, "info");
}

// ----------------- RENDER OPENED TRIP DASHBOARD -----------------

function renderActiveTripDashboard() {
  if (!activeTrip) return;

  const cur = activeTrip.currency || "£";
  const expenses = Array.isArray(activeTrip.expenses) ? activeTrip.expenses : [];
  const payments = Array.isArray(activeTrip.payments) ? activeTrip.payments : [];
  const members = Array.isArray(activeTrip.members) ? activeTrip.members : [];

  document.getElementById("activeTripTitle").textContent = activeTrip.name;
  const totalSpend = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  document.getElementById("activeTripTotalSpend").textContent = `${cur}${totalSpend.toFixed(2)}`;
  document.getElementById("activeTripExpenseCount").textContent = String(expenses.length);

  const pillsEl = document.getElementById("activeTripMembersPills");
  if (pillsEl) {
    pillsEl.innerHTML = members.map(m => `
      <span
        onclick="openManageMembersModal()"
        title="Click to edit or manage group members"
        class="inline-flex items-center space-x-1 text-xs font-bold px-2.5 py-0.5 rounded-full bg-slate-100 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 border border-slate-200 cursor-pointer transition"
      >
        <i class="ph-bold ph-user text-indigo-600"></i>
        <span>${escapeHtml(m)}</span>
      </span>
    `).join("");
  }

  const { memberBalances, settlements } = calculateSettlementPlan(activeTrip);

  const balancesGrid = document.getElementById("memberBalancesGrid");
  if (balancesGrid) {
    balancesGrid.innerHTML = memberBalances.map(item => {
      const isPositive = item.balance > 0.005;
      const isNegative = item.balance < -0.005;
      const colorClass = isPositive
        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
        : (isNegative ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-slate-50 border-slate-200 text-slate-600");
      const signPrefix = isPositive ? "+" : (isNegative ? "-" : "");
      const statusText = isPositive ? "Gets back" : (isNegative ? "Owes" : "Settled");

      return `
        <div class="p-3 rounded-xl border ${colorClass} flex flex-col justify-between">
          <div class="text-xs font-bold truncate">${escapeHtml(item.person)}</div>
          <div class="text-sm font-extrabold mt-1">${signPrefix}${cur}${Math.abs(item.balance).toFixed(2)}</div>
          <div class="text-[10px] font-semibold opacity-75">${statusText}</div>
        </div>
      `;
    }).join("");
  }

  const settlementBadge = document.getElementById("settlementCountBadge");
  const whoPaysList = document.getElementById("whoPaysWhomList");

  if (settlements.length === 0) {
    if (settlementBadge) {
      settlementBadge.textContent = "All settled up!";
      settlementBadge.className = "text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800";
    }
    if (whoPaysList) {
      whoPaysList.innerHTML = `
        <div class="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 text-center text-xs font-semibold text-emerald-800 flex items-center justify-center space-x-2">
          <i class="ph-bold ph-check-circle text-emerald-600 text-lg"></i>
          <span>Everyone is completely settled up! No payments needed.</span>
        </div>
      `;
    }
  } else {
    if (settlementBadge) {
      settlementBadge.textContent = `${settlements.length} payment${settlements.length === 1 ? "" : "s"} needed`;
      settlementBadge.className = "text-xs font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800";
    }
    if (whoPaysList) {
      whoPaysList.innerHTML = settlements.map(s => `
        <div class="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-amber-50/50 border border-amber-200/80">
          <div class="flex items-center space-x-2.5 text-sm">
            <span class="font-extrabold text-slate-900 px-2.5 py-1 rounded-lg bg-white border border-slate-200 shadow-2xs">${escapeHtml(s.from)}</span>
            <span class="text-xs font-bold text-amber-700 flex items-center space-x-1">
              <span>pays</span>
              <i class="ph-bold ph-arrow-right"></i>
            </span>
            <span class="font-extrabold text-slate-900 px-2.5 py-1 rounded-lg bg-white border border-slate-200 shadow-2xs">${escapeHtml(s.to)}</span>
          </div>

          <div class="flex items-center space-x-3 ml-auto">
            <span class="text-base font-extrabold text-slate-900">${cur}${s.amount.toFixed(2)}</span>
            <button
              type="button"
              onclick="markSettlementPaid('${escapeAttr(s.from)}', '${escapeAttr(s.to)}', ${s.amount})"
              class="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs transition flex items-center space-x-1.5 cursor-pointer"
            >
              <i class="ph-bold ph-check"></i>
              <span>Mark paid</span>
            </button>
          </div>
        </div>
      `).join("");
    }
  }

  const paymentsBadge = document.getElementById("paymentsCountBadge");
  const paymentsListEl = document.getElementById("recordedPaymentsList");
  if (paymentsBadge) paymentsBadge.textContent = String(payments.length);

  if (paymentsListEl) {
    if (payments.length === 0) {
      paymentsListEl.innerHTML = `
        <p class="text-xs text-slate-400 italic py-1">No payments marked as paid yet. Tap "Mark paid" above when someone settles up.</p>
      `;
    } else {
      paymentsListEl.innerHTML = payments.map(p => {
        const dateFormatted = p.paid_at ? new Date(p.paid_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
        return `
          <div class="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-emerald-50/60 border border-emerald-200 text-xs">
            <div class="flex items-center space-x-2 flex-wrap">
              <i class="ph-bold ph-check-circle text-emerald-600 text-sm"></i>
              <span>
                <strong class="text-slate-900">${escapeHtml(p.from)}</strong> paid
                <strong class="text-slate-900">${escapeHtml(p.to)}</strong>
                <strong class="text-emerald-800 ml-1">${cur}${Number(p.amount).toFixed(2)}</strong>
              </span>
              ${dateFormatted ? `<span class="text-[11px] text-slate-400">• ${escapeHtml(dateFormatted)}</span>` : ""}
            </div>
            <button
              type="button"
              onclick="undoPayment('${escapeAttr(p.id)}')"
              class="px-2.5 py-1 rounded-lg bg-white hover:bg-rose-50 text-slate-600 hover:text-rose-600 border border-slate-200 font-bold text-[11px] transition flex items-center space-x-1 shrink-0 cursor-pointer"
            >
              <i class="ph-bold ph-arrow-counter-clockwise"></i>
              <span>Undo</span>
            </button>
          </div>
        `;
      }).join("");
    }
  }

  const expensesContainer = document.getElementById("expensesListContainer");
  if (!expensesContainer) return;

  if (expenses.length === 0) {
    expensesContainer.innerHTML = `
      <div class="p-8 text-center space-y-2">
        <div class="w-11 h-11 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center text-xl mx-auto">
          <i class="ph-bold ph-receipt"></i>
        </div>
        <p class="text-sm font-bold text-slate-700">No expenses logged yet</p>
        <p class="text-xs text-slate-400">Use the Add an Expense form on the left to log your first bill.</p>
      </div>
    `;
    return;
  }

  expensesContainer.innerHTML = expenses.map(exp => {
    const catMeta = CATEGORY_META[exp.category] || CATEGORY_META["Other"];
    const amt = Number(exp.amount) || 0;
    const sharedBy = (Array.isArray(exp.shared_by) && exp.shared_by.length > 0) ? exp.shared_by : members;
    const perPerson = sharedBy.length > 0 ? amt / sharedBy.length : amt;

    return `
      <div class="p-4 sm:px-6 hover:bg-slate-50/80 transition flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-start space-x-3.5">
          <div class="w-10 h-10 rounded-xl border ${catMeta.badge} flex items-center justify-center text-lg shrink-0 mt-0.5">
            <i class="ph-bold ${catMeta.icon}"></i>
          </div>

          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <h4 class="text-sm font-extrabold text-slate-900">${escapeHtml(exp.description || exp.category)}</h4>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${catMeta.badge}">
                ${escapeHtml(exp.category || "Other")}
              </span>
              ${exp.date ? `<span class="text-[11px] text-slate-400 font-medium">${escapeHtml(exp.date)}</span>` : ""}
            </div>

            <p class="text-xs text-slate-600">
              Paid by <strong class="text-slate-900">${escapeHtml(exp.paid_by)}</strong> •
              Shared by <strong class="text-slate-800">${sharedBy.map(escapeHtml).join(", ")}</strong>
              <span class="text-slate-400">(${cur}${perPerson.toFixed(2)} each)</span>
            </p>

            ${exp.receipt_data_url ? `
              <div class="pt-1">
                <button
                  type="button"
                  onclick="openReceiptPreviewModal('${escapeAttr(exp.id)}')"
                  class="inline-flex items-center space-x-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 px-2.5 py-1 rounded-lg cursor-pointer"
                >
                  <i class="ph-bold ph-image"></i>
                  <span>View Bill Photo</span>
                </button>
              </div>
            ` : (exp.receipt_name ? `
              <div class="text-[11px] text-slate-400 flex items-center space-x-1">
                <i class="ph-bold ph-paperclip"></i>
                <span>File: ${escapeHtml(exp.receipt_name)}</span>
              </div>
            ` : "")}
          </div>
        </div>

        <div class="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-1.5 shrink-0 pl-13 sm:pl-0">
          <div class="text-base font-extrabold text-slate-900">${cur}${amt.toFixed(2)}</div>
          <div class="flex items-center space-x-1.5">
            <button
              type="button"
              onclick="deleteExpense('${escapeAttr(exp.id)}', false)"
              class="text-xs font-bold px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 transition flex items-center space-x-1 cursor-pointer"
              title="Delete Expense"
            >
              <i class="ph-bold ph-trash"></i>
              <span>Delete</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// ----------------- 8. EXPORT CSV (DOWNLOAD ALL EXPENSES AS SPREADSHEET) -----------------

function exportExpensesCSV() {
  if (!activeTrip) {
    showToast("Open a trip first to export its expenses.", "error");
    return;
  }

  const expenses = Array.isArray(activeTrip.expenses) ? activeTrip.expenses : [];
  const members = Array.isArray(activeTrip.members) ? activeTrip.members : [];
  const cur = activeTrip.currency || "£";

  const headers = [
    "Date",
    "Description",
    "Category",
    "Paid By",
    `Amount (${cur})`,
    "Shared By",
    `Split Per Person (${cur})`,
    "Entry Method",
    "Receipt File"
  ];

  const rows = expenses.map(exp => {
    const amt = Number(exp.amount) || 0;
    const sharedBy = (Array.isArray(exp.shared_by) && exp.shared_by.length > 0) ? exp.shared_by : members;
    const splitEach = sharedBy.length > 0 ? amt / sharedBy.length : amt;
    return [
      exp.date || "",
      exp.description || exp.category || "",
      exp.category || "Other",
      exp.paid_by || "",
      amt.toFixed(2),
      sharedBy.join("; "),
      splitEach.toFixed(2),
      exp.source === "scanned" ? "AI Scanned Receipt" : "Added by Hand",
      exp.receipt_name || ""
    ];
  });

  const csvLines = [
    headers.map(csvEscape).join(","),
    ...rows.map(r => r.map(csvEscape).join(","))
  ];

  const csvContent = "\uFEFF" + csvLines.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const safeTripName = (activeTrip.name || "trip")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "trip";

  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", `${safeTripName}-expenses.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast(`Downloaded "${safeTripName}-expenses.csv" (${expenses.length} expense${expenses.length === 1 ? "" : "s"}).`, "success");
}

function csvEscape(val) {
  const str = String(val === null || val === undefined ? "" : val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ----------------- MODALS & UTILITIES -----------------

function openReceiptPreviewModal(expenseId) {
  if (!activeTrip || !Array.isArray(activeTrip.expenses)) return;
  const exp = activeTrip.expenses.find(e => e.id === expenseId);
  if (!exp || !exp.receipt_data_url) return;

  document.getElementById("receiptPreviewTitle").textContent = `${exp.description} — Paid by ${exp.paid_by}`;
  document.getElementById("receiptPreviewImage").src = exp.receipt_data_url;
  document.getElementById("receiptPreviewModal").classList.remove("hidden");
}

function closeReceiptPreviewModal() {
  document.getElementById("receiptPreviewModal").classList.add("hidden");
}

function openSettingsModal() {
  const savedKey = localStorage.getItem(STORAGE_KEY_GEMINI) || "";
  const input = document.getElementById("geminiApiKeyInput");
  if (input) input.value = savedKey;
  document.getElementById("settingsModal").classList.remove("hidden");
}

function closeSettingsModal() {
  document.getElementById("settingsModal").classList.add("hidden");
}

function saveSettingsModal() {
  const input = document.getElementById("geminiApiKeyInput");
  const key = (input ? input.value : "").trim();
  if (key) {
    localStorage.setItem(STORAGE_KEY_GEMINI, key);
    showToast("Saved Gemini API key for live receipt scanning.", "success");
  } else {
    localStorage.removeItem(STORAGE_KEY_GEMINI);
    showToast("Cleared custom Gemini API key (using server .env if configured).", "info");
  }
  closeSettingsModal();
  checkAiScannerStatus();
}

async function checkAiScannerStatus() {
  const dot = document.getElementById("aiStatusDot");
  if (!dot) return;
  try {
    const headers = {};
    const savedKey = localStorage.getItem(STORAGE_KEY_GEMINI);
    if (savedKey) headers["x-gemini-key"] = savedKey;
    const res = await fetch("/api/status", { headers });
    if (res.ok) {
      const data = await res.json();
      dot.className = data.ai_ready
        ? "w-2 h-2 rounded-full bg-emerald-500"
        : "w-2 h-2 rounded-full bg-amber-500";
    }
  } catch (_) {
    dot.className = "w-2 h-2 rounded-full bg-amber-500";
  }
}

function readAndCompressImage(file, maxDim = 900, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

let toastTimer = null;
function showToast(message, type = "success") {
  const banner = document.getElementById("toastBanner");
  const icon = document.getElementById("toastIcon");
  const text = document.getElementById("toastMessage");
  if (!banner || !icon || !text) return;

  text.textContent = message;
  if (type === "error") {
    banner.className = "p-4 rounded-2xl border flex items-center justify-between transition-all shadow-sm bg-rose-50 border-rose-200 text-rose-900";
    icon.className = "ph-bold ph-warning-circle text-xl text-rose-600";
  } else if (type === "info") {
    banner.className = "p-4 rounded-2xl border flex items-center justify-between transition-all shadow-sm bg-indigo-50 border-indigo-200 text-indigo-900";
    icon.className = "ph-bold ph-info text-xl text-indigo-600";
  } else {
    banner.className = "p-4 rounded-2xl border flex items-center justify-between transition-all shadow-sm bg-emerald-50 border-emerald-200 text-emerald-900";
    icon.className = "ph-bold ph-check-circle text-xl text-emerald-600";
  }

  banner.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    banner.classList.add("hidden");
  }, 5500);
}

function hideToast() {
  const banner = document.getElementById("toastBanner");
  if (banner) banner.classList.add("hidden");
}

function escapeHtml(str) {
  return String(str === null || str === undefined ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return escapeHtml(str);
}
