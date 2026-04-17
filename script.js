const WORD_LENGTH = 5;
const MAX_GUESSES = 5;
const GUESS_COUNT_COOKIE = "wordle_guess_count";
const GUESS_COUNT_STORAGE_KEY = "wordle_guess_count";
const PLAYED_WORDS_COOKIE = "wordle_played_words";
const PLAY_EVENTS_STORAGE_KEY = "wordle_play_events";
const WORDS_URL = "./words.json";
const WORDS_FETCH_TIMEOUT_MS = 2000;
const TEST_WIN_WORD = "HISHY";
const TEST_LOSE_WORD = "BYSHY";
const TEST_MESSAGE_WORD = "DESHY";
const TEST_MESSAGE_TEXT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.";
const KEYBOARD_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
];

const board = document.getElementById("board");
const keyboard = document.getElementById("keyboard");
const enterKeyButton = document.getElementById("enter-key-button");
const backspaceKeyButton = document.getElementById("backspace-key-button");
const hintButton = document.getElementById("hint-button");
const message = document.getElementById("message");
const newGameButton = document.getElementById("new-game-button");
const settingsButton = document.getElementById("settings-button");
const guessCountSelect = document.getElementById("guess-count");
const settingsModal = document.getElementById("settings-modal");
const settingsModalBackdrop = document.getElementById("settings-modal-backdrop");
const settingsCloseButton = document.getElementById("settings-close-button");
const confirmModal = document.getElementById("confirm-modal");
const confirmModalBackdrop = document.getElementById("confirm-modal-backdrop");
const confirmCancelButton = document.getElementById("confirm-cancel-button");
const confirmAcceptButton = document.getElementById("confirm-accept-button");
const revealModal = document.getElementById("reveal-modal");
const revealModalBackdrop = document.getElementById("reveal-modal-backdrop");
const revealModalText = document.getElementById("reveal-modal-text");
const revealOkButton = document.getElementById("reveal-ok-button");
const winModal = document.getElementById("win-modal");
const winModalBackdrop = document.getElementById("win-modal-backdrop");
const winModalText = document.getElementById("win-modal-text");
const winNewGameButton = document.getElementById("win-new-game-button");
const loseModal = document.getElementById("lose-modal");
const loseModalBackdrop = document.getElementById("lose-modal-backdrop");
const loseModalText = document.getElementById("lose-modal-text");
const loseNewGameButton = document.getElementById("lose-new-game-button");

let secretWord = "";
let currentGuess = "";
let currentRow = 0;
let gameOver = false;
let isRevealing = false;
let tileRows = [];
let dictionary = [];
let dictionarySet = new Set(dictionary);
let playableWords = [];
let dictionaryReady = false;
let isCheckingGuess = false;
let currentMaxGuesses = MAX_GUESSES;
let isModalOpen = false;
let previousFocus = null;
let gameStateVersion = 0;
let currentInlineHtml = "";
let isLoadingHint = false;
let current24HourPlayCount = 0;
let hasCountedCurrentGame = false;
let revealedHintIndices = [];
let revealedCorrectIndices = new Set();
let activeModalCleanup = null;
let activeModal = null;
const keyStates = new Map();
const hintCache = new Map();

function getWebpageVersion() {
  const meta = document.querySelector('meta[name="webpage-version"]');
  return meta?.content || "";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = WORDS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseWordsPayload(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.words;
  if (!Array.isArray(entries)) {
    throw new Error("Words payload is not an array.");
  }

  return entries
    .filter((entry) => entry && typeof entry.word === "string")
    .map((entry) => ({
      word: entry.word.trim().toUpperCase(),
      definition: typeof entry.definition === "string" ? entry.definition.trim() : "",
    }))
    .filter((entry) => /^[A-Z]{5}$/.test(entry.word));
}

async function loadWordsEntries(options = {}) {
  const { version = "" } = options;
  const wordsUrl = version
    ? `${WORDS_URL}?v=${encodeURIComponent(version)}`
    : WORDS_URL;
  const response = await fetchWithTimeout(wordsUrl);
  if (!response.ok) {
    throw new Error(`Words request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const entries = parseWordsPayload(payload);
  if (entries.length === 0) {
    throw new Error("Words file is empty.");
  }

  playableWords = entries.map((entry) => entry.word);
  dictionary = [...playableWords];
  dictionarySet = new Set(dictionary);

  hintCache.clear();

  entries.forEach((entry) => {
    hintCache.set(entry.word, entry.definition);
  });
}

function readGuessCountCookie() {
  const cookie = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${GUESS_COUNT_COOKIE}=`));

  if (!cookie) {
    return null;
  }

  const value = Number(cookie.split("=")[1]);
  if (!Number.isInteger(value) || value < 2 || value > 7) {
    return null;
  }

  return value;
}

function readPlayedWordsCookie() {
  const cookie = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${PLAYED_WORDS_COOKIE}=`));

  if (!cookie) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(cookie.split("=")[1]));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((word) => typeof word === "string" && /^[A-Z]{5}$/.test(word));
  } catch (error) {
    console.error(error);
    return [];
  }
}

function writePlayedWordsCookie(words) {
  document.cookie = `${PLAYED_WORDS_COOKIE}=${encodeURIComponent(JSON.stringify(words))}; max-age=31536000; path=/; SameSite=Lax`;
}

function readGuessCountStorage() {
  try {
    const value = Number(localStorage.getItem(GUESS_COUNT_STORAGE_KEY));
    if (!Number.isInteger(value) || value < 2 || value > 7) {
      return null;
    }

    return value;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function isSameLocalDay(timestamp, now = Date.now()) {
  const eventDate = new Date(timestamp);
  const currentDate = new Date(now);

  return eventDate.getFullYear() === currentDate.getFullYear()
    && eventDate.getMonth() === currentDate.getMonth()
    && eventDate.getDate() === currentDate.getDate();
}

function prunePlayEvents(events, now = Date.now()) {
  return events.filter((timestamp) =>
    Number.isInteger(timestamp) && timestamp <= now && isSameLocalDay(timestamp, now),
  );
}

function readPlayEventsStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAY_EVENTS_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }

    return prunePlayEvents(parsed);
  } catch (error) {
    console.error(error);
    return [];
  }
}

function writePlayEventsStorage(events) {
  try {
    localStorage.setItem(PLAY_EVENTS_STORAGE_KEY, JSON.stringify(events));
  } catch (error) {
    console.error(error);
  }
}

function refresh24HourPlayCount() {
  const events = readPlayEventsStorage();
  current24HourPlayCount = events.length;
  writePlayEventsStorage(events);
  return current24HourPlayCount;
}

function recordPlayEvent() {
  const now = Date.now();
  const events = prunePlayEvents(readPlayEventsStorage(), now);
  events.push(now);
  current24HourPlayCount = events.length;
  writePlayEventsStorage(events);
  hasCountedCurrentGame = true;
  return current24HourPlayCount;
}

function writeGuessCountCookie(value) {
  document.cookie = `${GUESS_COUNT_COOKIE}=${value}; max-age=31536000; path=/; SameSite=Lax`;
}

function writeGuessCountStorage(value) {
  try {
    localStorage.setItem(GUESS_COUNT_STORAGE_KEY, String(value));
  } catch (error) {
    console.error(error);
  }
}

function initializeGuessCountSetting() {
  const savedGuessCount = readGuessCountStorage() ?? readGuessCountCookie();
  const initialGuessCount = savedGuessCount ?? MAX_GUESSES;
  guessCountSelect.value = String(initialGuessCount);
  currentMaxGuesses = initialGuessCount;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMessages() {
  message.innerHTML = currentInlineHtml;
}

function setControlsDisabled(disabled) {
  guessCountSelect.disabled = disabled;
}

function pickNextWord() {
  if (dictionary.length === 0) {
    throw new Error("No words are available.");
  }

  let playedWords = readPlayedWordsCookie()
    .filter((word) => dictionarySet.has(word));
  let unplayedWords = dictionary.filter((word) => !playedWords.includes(word));

  if (unplayedWords.length === 0) {
    playedWords = [];
    unplayedWords = [...dictionary];
  }

  const word = unplayedWords[Math.floor(Math.random() * unplayedWords.length)];
  writePlayedWordsCookie([...playedWords, word]);
  return word;
}

function initializeBoard() {
  board.innerHTML = "";
  tileRows = [];

  for (let rowIndex = 0; rowIndex < currentMaxGuesses; rowIndex += 1) {
    const row = document.createElement("div");
    row.className = "board-row";

    const tiles = [];
    for (let columnIndex = 0; columnIndex < WORD_LENGTH; columnIndex += 1) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.setAttribute("aria-label", `Row ${rowIndex + 1} column ${columnIndex + 1}`);
      row.appendChild(tile);
      tiles.push(tile);
    }

    board.appendChild(row);
    tileRows.push(tiles);
  }
}

function initializeKeyboard() {
  keyboard.innerHTML = "";

  KEYBOARD_ROWS.forEach((rowKeys) => {
    const row = document.createElement("div");
    row.className = "keyboard-row";

    rowKeys.forEach((label) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "key";
      key.dataset.key = label;
      key.textContent = label;

      key.addEventListener("click", () => handleKeyPress(label));
      row.appendChild(key);
    });

    keyboard.appendChild(row);
  });
}

function setInlineMessage(html = "") {
  currentInlineHtml = html;
  renderMessages();
}

function setInlineText(text, options = {}) {
  const { italic = false } = options;
  setInlineMessage(italic ? `<em>${escapeHtml(text)}</em>` : escapeHtml(text));
}

function revealFreeLetter(index) {
  const letter = secretWord[index];

  if (statePriority("correct") > statePriority(keyStates.get(letter))) {
    keyStates.set(letter, "correct");
    const key = keyboard.querySelector(`[data-key="${letter}"]`);
    if (key) {
      key.classList.remove("correct", "present", "absent");
      key.classList.add("correct");
    }
  }

  refreshCurrentRow();
}

function getKnownLetterCount() {
  let count = 0;

  keyStates.forEach((state) => {
    if (state === "correct" || state === "present") {
      count += 1;
    }
  });

  return count;
}

function getRemainingFreeHintCount() {
  return Math.max(
    0,
    WORD_LENGTH - 1 - getKnownLetterCount(),
  );
}

function setHint(definition) {
  if (!definition) {
    if (getRemainingFreeHintCount() <= 0) {
      setInlineMessage("<em>You only need one more letter!</em>");
      return;
    }

    const availableIndices = [0, 1, 2, 3, 4]
      .filter((index) => !revealedHintIndices.includes(index))
      .filter((index) => !revealedCorrectIndices.has(index));
    const index = availableIndices.length > 0
      ? availableIndices[Math.floor(Math.random() * availableIndices.length)]
      : Math.floor(Math.random() * WORD_LENGTH);

    if (!revealedHintIndices.includes(index)) {
      revealedHintIndices.push(index);
    }

    revealFreeLetter(index);
    setInlineMessage(`<em>The word contains an "${escapeHtml(secretWord[index])}".</em>`);
    return;
  }

  setInlineMessage(`<em>${escapeHtml(definition)}</em>`);
}

async function handleHintRequest() {
  if (!dictionaryReady || isLoadingHint) {
    return;
  }

  if (currentRow === 0) {
    setInlineText("Type a 5 letter word to get started.", { italic: true });
    return;
  }

  const requestedWord = secretWord;
  const requestVersion = gameStateVersion;
  isLoadingHint = true;
  hintButton.disabled = true;

  try {
    if (requestVersion !== gameStateVersion || requestedWord !== secretWord) {
      return;
    }

    setHint(hintCache.get(requestedWord));
  } finally {
    isLoadingHint = false;
    hintButton.disabled = false;
  }
}

function updateActiveTile() {
  tileRows.flat().forEach((tile) => {
    tile.classList.remove("active");
  });

  if (gameOver || isRevealing || isCheckingGuess || !dictionaryReady) {
    return;
  }

  const row = tileRows[currentRow];
  if (!row) {
    return;
  }

  const activeIndex = Math.min(currentGuess.length, WORD_LENGTH - 1);
  const activeTile = row[activeIndex];
  if (activeTile && !activeTile.classList.contains("revealed")) {
    activeTile.classList.add("active");
  }
}

function refreshCurrentRow() {
  const row = tileRows[currentRow];
  if (!row) {
    return;
  }

  row.forEach((tile, index) => {
    const letter = currentGuess[index] || "";
    tile.textContent = letter;
    tile.classList.toggle("filled", Boolean(letter));
  });

  updateActiveTile();
}

function handleKeyPress(key) {
  if (gameOver || isRevealing || isCheckingGuess || !dictionaryReady) {
    return;
  }

  if (key === "ENTER") {
    submitGuess();
    return;
  }

  if (key === "BACK") {
    currentGuess = currentGuess.slice(0, -1);
    refreshCurrentRow();
    return;
  }

  if (/^[A-Z]$/.test(key) && currentGuess.length < WORD_LENGTH) {
    currentGuess += key;
    refreshCurrentRow();

    const tile = tileRows[currentRow][currentGuess.length - 1];
    tile.classList.remove("pop");
    void tile.offsetWidth;
    tile.classList.add("pop");
  }
}

function scoreGuess(guess, answer) {
  const result = Array(WORD_LENGTH).fill("absent");
  const counts = new Map();

  for (const letter of answer) {
    counts.set(letter, (counts.get(letter) || 0) + 1);
  }

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (guess[index] === answer[index]) {
      result[index] = "correct";
      counts.set(guess[index], counts.get(guess[index]) - 1);
    }
  }

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    const letter = guess[index];
    if (result[index] !== "absent") {
      continue;
    }

    if ((counts.get(letter) || 0) > 0) {
      result[index] = "present";
      counts.set(letter, counts.get(letter) - 1);
    }
  }

  return result;
}

function statePriority(state) {
  if (state === "correct") {
    return 3;
  }
  if (state === "present") {
    return 2;
  }
  if (state === "absent") {
    return 1;
  }
  return 0;
}

function updateKeyboard(guess, scores) {
  guess.split("").forEach((letter, index) => {
    const nextState = scores[index];
    const previousState = keyStates.get(letter);

    if (statePriority(nextState) <= statePriority(previousState)) {
      return;
    }

    keyStates.set(letter, nextState);
    const key = keyboard.querySelector(`[data-key="${letter}"]`);
    if (!key) {
      return;
    }

    key.classList.remove("correct", "present", "absent");
    key.classList.add(nextState);
  });
}

async function submitGuess() {
  if (currentGuess.length !== WORD_LENGTH) {
    return;
  }

  const submissionVersion = gameStateVersion;
  isCheckingGuess = true;
  const isTestWinWord = currentGuess === TEST_WIN_WORD;
  const isTestLoseWord = currentGuess === TEST_LOSE_WORD;
  const isTestMessageWord = currentGuess === TEST_MESSAGE_WORD;

  const allowedGuess = (isTestWinWord || isTestLoseWord || isTestMessageWord)
    ? true
    : dictionarySet.has(currentGuess);
  if (submissionVersion !== gameStateVersion) {
    return;
  }

  isCheckingGuess = false;

  if (!allowedGuess) {
    setInlineMessage(`<em>${escapeHtml(currentGuess)}</em> is not in the dictionary.`);
    updateActiveTile();
    return;
  }

  if (isTestMessageWord) {
    setInlineText(TEST_MESSAGE_TEXT);
    updateActiveTile();
    return;
  }

  const guess = currentGuess;
  const answer = isTestWinWord ? guess : secretWord;
  const scores = scoreGuess(guess, answer);
  scores.forEach((state, index) => {
    if (state === "correct") {
      revealedCorrectIndices.add(index);
    }
  });
  const row = tileRows[currentRow];
  isRevealing = true;
  updateActiveTile();

  row.forEach((tile, index) => {
    const state = scores[index];

    setTimeout(() => {
      tile.classList.add("flip");
      tile.classList.add("revealed", state);
      tile.classList.remove("filled");
    }, index * 180);

    setTimeout(() => {
      tile.classList.remove("flip");
    }, index * 180 + 420);
  });

  updateKeyboard(guess, scores);

  if (guess === answer) {
    if (!hasCountedCurrentGame) {
      recordPlayEvent();
    }
    gameOver = true;
    setTimeout(() => {
      isRevealing = false;
      setInlineMessage();
      openWinModal(secretWord, () => {
        resetGame();
      });
      updateActiveTile();
    }, 900);
    return;
  }

  if (isTestLoseWord) {
    gameOver = true;
    setTimeout(() => {
      isRevealing = false;
      setInlineMessage();
      openLoseModal(secretWord, () => {
        resetGame();
      });
      updateActiveTile();
    }, 900);
    return;
  }

  currentRow += 1;
  currentGuess = "";
  setInlineMessage();

  if (currentRow === currentMaxGuesses) {
    gameOver = true;
    setTimeout(() => {
      isRevealing = false;
      setInlineMessage();
      openLoseModal(secretWord, () => {
        resetGame();
      });
      updateActiveTile();
    }, 900);
    return;
  }

  setTimeout(() => {
    isRevealing = false;
    updateActiveTile();
  }, 900);
}

async function resetGame(options = {}) {
  const {
    selectingMessage = "",
    readyMessage = "",
  } = options;

  gameStateVersion += 1;
  const resetVersion = gameStateVersion;
  secretWord = "";
  currentGuess = "";
  currentRow = 0;
  gameOver = false;
  isRevealing = false;
  isCheckingGuess = false;
  isLoadingHint = false;
  hasCountedCurrentGame = false;
  revealedHintIndices = [];
  revealedCorrectIndices = new Set();
  keyStates.clear();
  setInlineMessage();
  hintButton.disabled = false;
  dictionaryReady = false;
  setControlsDisabled(true);
  setInlineText(selectingMessage);
  initializeBoard();
  initializeKeyboard();

  secretWord = pickNextWord();

  if (resetVersion !== gameStateVersion) {
    return;
  }

  dictionaryReady = true;
  setControlsDisabled(false);
  if (readyMessage) {
    setInlineText(readyMessage);
  }
  updateActiveTile();
}

function hasInProgressGame() {
  return !gameOver && (currentRow > 0 || currentGuess.length > 0);
}

function applyGuessCountChange(nextGuessCount) {
  currentMaxGuesses = nextGuessCount;
  guessCountSelect.value = String(nextGuessCount);
  writeGuessCountCookie(currentMaxGuesses);
  writeGuessCountStorage(currentMaxGuesses);
  resetGame();
}

function closeModal(options = {}) {
  const { restoreFocus = true } = options;

  isModalOpen = false;

  if (activeModal) {
    activeModal.classList.remove("is-open");
    activeModal.setAttribute("aria-hidden", "true");
  }

  if (activeModalCleanup) {
    activeModalCleanup();
    activeModalCleanup = null;
  }

  activeModal = null;

  if (restoreFocus && previousFocus && typeof previousFocus.focus === "function") {
    previousFocus.focus();
  }

  if (!restoreFocus && previousFocus && typeof previousFocus.blur === "function") {
    previousFocus.blur();
  }

  previousFocus = null;
}

function openModal({
  modal,
  initialFocus,
  bindings = [],
  onEscape,
  onEnter,
}) {
  if (isModalOpen) {
    return;
  }

  isModalOpen = true;
  activeModal = modal;
  previousFocus = document.activeElement;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");

  const handleKeydown = (event) => {
    if (event.key === "Escape" && onEscape) {
      onEscape();
      return;
    }

    if (event.key === "Enter" && onEnter) {
      onEnter();
    }
  };

  bindings.forEach(({ element, event, handler }) => {
    element.addEventListener(event, handler);
  });
  document.addEventListener("keydown", handleKeydown);

  activeModalCleanup = () => {
    bindings.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    document.removeEventListener("keydown", handleKeydown);
  };

  if (initialFocus) {
    initialFocus.focus();
  }
}

function openSettingsModal() {
  guessCountSelect.value = String(currentMaxGuesses);

  const handleClose = () => {
    closeModal();
  };

  openModal({
    modal: settingsModal,
    initialFocus: guessCountSelect,
    bindings: [
      { element: settingsModalBackdrop, event: "click", handler: handleClose },
      { element: settingsCloseButton, event: "click", handler: handleClose },
    ],
    onEscape: handleClose,
  });
}

function openConfirmModal(onConfirm) {
  const handleCancel = () => {
    closeModal();
  };

  const handleConfirm = () => {
    closeModal({ restoreFocus: false });
    onConfirm();
  };

  openModal({
    modal: confirmModal,
    initialFocus: confirmAcceptButton,
    bindings: [
      { element: confirmCancelButton, event: "click", handler: handleCancel },
      { element: confirmAcceptButton, event: "click", handler: handleConfirm },
      { element: confirmModalBackdrop, event: "click", handler: handleCancel },
    ],
    onEscape: handleCancel,
  });
}

function openRevealModal(word, onAcknowledge) {
  revealModalText.textContent = word ? word : "";

  const handleAcknowledge = () => {
    closeModal({ restoreFocus: false });
    onAcknowledge();
  };

  openModal({
    modal: revealModal,
    initialFocus: revealOkButton,
    bindings: [
      { element: revealOkButton, event: "click", handler: handleAcknowledge },
      { element: revealModalBackdrop, event: "click", handler: handleAcknowledge },
    ],
    onEscape: handleAcknowledge,
    onEnter: handleAcknowledge,
  });
}

function openWinModal(word, onNewGame) {
  winModalText.textContent = word ? `The word was ${word}.` : "";

  const handleNewGame = () => {
    closeModal({ restoreFocus: false });
    onNewGame();
  };

  openModal({
    modal: winModal,
    initialFocus: winNewGameButton,
    bindings: [
      { element: winNewGameButton, event: "click", handler: handleNewGame },
      { element: winModalBackdrop, event: "click", handler: handleNewGame },
    ],
    onEscape: handleNewGame,
    onEnter: handleNewGame,
  });
}

function openLoseModal(word, onNewGame) {
  loseModalText.textContent = word ? `The word was ${word}.` : "";

  const handleNewGame = () => {
    closeModal({ restoreFocus: false });
    onNewGame();
  };

  openModal({
    modal: loseModal,
    initialFocus: loseNewGameButton,
    bindings: [
      { element: loseNewGameButton, event: "click", handler: handleNewGame },
      { element: loseModalBackdrop, event: "click", handler: handleNewGame },
    ],
    onEscape: handleNewGame,
    onEnter: handleNewGame,
  });
}

function handleStartNewGame() {
  if (hasInProgressGame()) {
    const abandonedWord = secretWord;
    openConfirmModal(() => {
      openRevealModal(`The word was ${abandonedWord}.`, () => {
        resetGame();
      });
    });
    return;
  }

  resetGame();
}

document.addEventListener("keydown", (event) => {
  if (isModalOpen) {
    return;
  }

  const key = event.key.toUpperCase();

  if (key === "ENTER") {
    event.preventDefault();
    handleKeyPress("ENTER");
    return;
  }

  if (key === "BACKSPACE") {
    event.preventDefault();
    handleKeyPress("BACK");
    return;
  }

  if (/^[A-Z]$/.test(key)) {
    event.preventDefault();
    handleKeyPress(key);
  }
});

newGameButton.addEventListener("click", handleStartNewGame);
settingsButton.addEventListener("click", openSettingsModal);
hintButton.addEventListener("click", handleHintRequest);
enterKeyButton.addEventListener("click", () => handleKeyPress("ENTER"));
backspaceKeyButton.addEventListener("click", () => handleKeyPress("BACK"));
guessCountSelect.addEventListener("change", () => {
  const nextGuessCount = Number(guessCountSelect.value);

  if (nextGuessCount === currentMaxGuesses) {
    closeModal();
    return;
  }

  closeModal({ restoreFocus: false });

  if (hasInProgressGame()) {
    guessCountSelect.value = String(currentMaxGuesses);
    openConfirmModal(() => {
      applyGuessCountChange(nextGuessCount);
    });
    return;
  }

  applyGuessCountChange(nextGuessCount);
});

async function initializeGame() {
  initializeGuessCountSetting();
  refresh24HourPlayCount();
  initializeBoard();
  initializeKeyboard();
  setControlsDisabled(true);
  await loadWordsEntries({ version: getWebpageVersion() });
  await resetGame();
}

initializeGame().catch((error) => {
  console.error(error);
  setInlineText("Unable to load words.");
});
